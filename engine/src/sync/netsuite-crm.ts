import { NETSUITE_MAPPING_GROUPS, connectionSourceOptions } from "./connection-settings.ts";
import { isUuid } from "../platform/uuid.ts";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { unsealJson } from "../platform/secrets.ts";
import { guardedFetch } from "../connectors/ssrf-guard.ts";
import { netsuiteRestlet, suiteql, type NetSuiteCreds } from "../connectors/netsuite.ts";
import { ensureCrmDefaults } from "../crm/crm.ts";
import { weightAmount } from "../crm/crm-math.ts";
import { canonicalDecimal } from "../money/exact-decimal.ts";
import { normalizeMoney } from "../money/money.ts";
import {
  netSuiteOperationalMappingWriter,
  type OperationalMappingWriter,
} from "./operational-entity-mappings.ts";
import { orgFeatureEnabled } from "../organization/org-feature-lock.ts";
import {
  NetSuiteBridgeClient,
  DEFAULT_NETSUITE_BRIDGE_SCRIPT_ID,
  DEFAULT_NETSUITE_BRIDGE_DEPLOYMENT_ID,
  type NetSuiteBridgeConfig,
} from "../connectors/netsuite-bridge.ts";

export interface CrmImportReport {
  accountStatuses: number;
  accounts: number;
  missingParties: number;
  opportunities: number;
  opportunityLines: number;
  activities: Record<string, number>;
  sourceNoteLinks: number;
  warnings: string[];
}

type NsRef = { id?: string | number; refName?: string };

const sourceText = (value: unknown): string | null => {
  const text = value == null ? "" : String(value).trim();
  return text || null;
};

/** Persist a NetSuite CRM amount without crossing the floating-point boundary. */
function persistSyncLineMoney(value: unknown, label: string): string {
  const exact = canonicalDecimal(value, 4);
  if (exact === null) throw new Error(`${label} must be an exact decimal`);
  return normalizeMoney(exact);
}

/** Resolve a source currency reference only to an ISO currency configured by the application. */
export function resolveNetSuiteCrmCurrency(
  sourceValue: unknown,
  baseCurrency: string,
  sourceCurrencyById: ReadonlyMap<string, string>,
  configuredCurrencies: ReadonlySet<string>,
): string | null {
  const sourceId = sourceText(sourceValue);
  const code = sourceId
    ? (sourceCurrencyById.get(sourceId) ?? sourceId.toUpperCase())
    : baseCurrency.toUpperCase();
  return /^[A-Z]{3}$/.test(code) && configuredCurrencies.has(code) ? code : null;
}

/** Resolve an opportunity's close probability, falling back to its CRM status. */
export function resolveNetSuiteCrmOpportunityProbability(
  sourceValue: unknown,
  fallback: number,
): number {
  const probabilityText = sourceText(sourceValue);
  const probabilityValue = probabilityText == null ? fallback : Number(probabilityText);
  return Number.isFinite(probabilityValue)
    ? Math.max(0, Math.min(100, Math.round(probabilityValue)))
    : fallback;
}

async function credentials(
  orgId: string,
  connectionId?: string,
): Promise<
  NetSuiteCreds & { probabilityField?: string; connectionId: string; bridge: NetSuiteBridgeConfig }
> {
  const row = await db.execute<{ id: string; config: Record<string, unknown>; secrets: string }>(
    sql`
    select id, config, secrets from connections where org_id=${orgId} and source='netsuite'
      ${connectionId ? sql`and id=${connectionId}` : sql``}
    order by status='active' desc, created_at desc limit 1`,
    "objects",
  );
  const connection = row[0];
  if (!connection) throw new Error("No tenant NetSuite connection exists");
  const secret =
    connection.secrets == null
      ? null
      : unsealJson<Partial<NetSuiteCreds>>(connection.secrets, {
          orgId,
          purpose: "connection.secrets",
        });
  if (
    !secret?.consumerKey ||
    !secret.consumerSecret ||
    !secret.tokenKey ||
    !secret.tokenSecret ||
    !connection.config.account ||
    !connection.config.host
  ) {
    throw new Error("The tenant NetSuite connection is missing credentials");
  }
  const mappings = connectionSourceOptions(connection.config, NETSUITE_MAPPING_GROUPS);
  return {
    bridge: {
      scriptId:
        typeof connection.config.bridgeScriptId === "string"
          ? connection.config.bridgeScriptId
          : undefined,
      deploymentId:
        typeof connection.config.bridgeDeploymentId === "string"
          ? connection.config.bridgeDeploymentId
          : undefined,
    },
    connectionId: connection.id,
    account: String(connection.config.account),
    host: String(connection.config.host),
    consumerKey: secret.consumerKey,
    consumerSecret: secret.consumerSecret,
    tokenKey: secret.tokenKey,
    tokenSecret: secret.tokenSecret,
    probabilityField:
      typeof mappings.crmProbabilityField === "string" ? mappings.crmProbabilityField : undefined,
  };
}

function date(value: unknown): string | null {
  if (!value) return null;
  const text = String(value);
  const us = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text);
  return us ? `${us[3]}-${us[1]}-${us[2]}` : text;
}

function stage(value: unknown): "lead" | "prospect" | "customer" {
  const normalized = String(value ?? "").toLowerCase();
  return normalized === "lead" ? "lead" : normalized === "prospect" ? "prospect" : "customer";
}

function refId(value: unknown): string | null {
  if (value && typeof value === "object" && "id" in value)
    return String((value as NsRef).id ?? "") || null;
  return value == null || value === "" ? null : String(value);
}

async function importNativeActivities(
  orgId: string,
  actorId: string | null,
  creds: NetSuiteCreds & { bridge: NetSuiteBridgeConfig },
  report: CrmImportReport,
  transport: typeof fetch,
  mappings: OperationalMappingWriter,
) {
  const bridge = new NetSuiteBridgeClient(creds, creds.bridge, (params) =>
    netsuiteRestlet(
      creds.bridge.scriptId ?? DEFAULT_NETSUITE_BRIDGE_SCRIPT_ID,
      creds.bridge.deploymentId ?? DEFAULT_NETSUITE_BRIDGE_DEPLOYMENT_ID,
      params,
      creds,
      "POST",
      transport,
    ),
  );
  const kinds = [
    { type: "task", kind: "task" },
    { type: "phonecall", kind: "call" },
    { type: "calendarevent", kind: "event" },
    { type: "note", kind: "note" },
  ] as const;
  for (const source of kinds) {
    const collection = await bridge.crmActivities(source.type);
    let imported = 0;
    for (const { id: nsId, fields: record } of collection) {
      const subject = sourceText(record.title);
      const body = sourceText(record.message ?? record.note);
      if (!subject && !body)
        throw new Error(`Source ${source.type} ${nsId} has neither a title nor content`);
      const accountNsId = refId(record.company ?? record.entity);
      const party = accountNsId
        ? (
            await db.execute<{ id: string }>(
              sql`select id from parties where org_id=${orgId} and custom->>'nsId'=${accountNsId} limit 1`,
              "objects",
            )
          )[0]
        : null;
      if (accountNsId && !party) {
        report.missingParties++;
        report.warnings.push(`Source ${source.type} ${nsId} requires missing party ${accountNsId}`);
        continue;
      }
      const statusText = String(record.status ?? "").toLowerCase();
      const status =
        source.type === "note" || /^(complete|completed)$/.test(statusText)
          ? "completed"
          : /^(cancelled|canceled)$/.test(statusText)
            ? "cancelled"
            : "planned";
      const identity = sql`custom->'netsuite'->>'recordType'=${source.type}`;
      const existing = await db.execute<{ id: string }>(
        sql`select id from crm_activities where org_id=${orgId} and custom->'netsuite'->>'id'=${nsId} and ${identity}`,
        "objects",
      );
      if (existing.length > 1)
        throw new Error(`Source ${source.type} ${nsId} has duplicate CRM activity identities`);
      const metadata = {
        id: nsId,
        recordType: source.type,
        noteType: record.notetype ?? null,
        transaction: record.transaction ?? null,
        activity: record.activity ?? null,
        lastModifiedAt: record.lastmodifieddate ?? null,
      };
      const startsAt = date(record.startdate ?? record.notedate);
      const completedAt =
        status === "completed"
          ? date(record.completeddate ?? record.notedate ?? record.enddate)
          : null;
      const activityId = await mappings.write(
        "crmActivities",
        `${source.type}:${nsId}`,
        { subject: subject ?? body!.slice(0, 120), body },
        sql`custom->'netsuite'->>'id'=${nsId} and ${identity}`,
        async (mapped) => {
          const result = existing[0]
            ? await db.execute<{ id: string }>(
                sql`update crm_activities set kind=${source.kind},status=${status},subject=${String(mapped.subject)},body=${mapped.body ?? null},starts_at=${startsAt},ends_at=${date(record.enddate)},due_at=${date(record.duedate)},completed_at=${completedAt},custom=jsonb_set(coalesce(custom,'{}'::jsonb),'{netsuite}',${JSON.stringify(metadata)}::jsonb),updated_at=now(),updated_by=${actorId} where id=${existing[0].id} and org_id=${orgId} returning id`,
                "objects",
              )
            : await db.execute<{ id: string }>(
                sql`insert into crm_activities(org_id,kind,status,subject,body,starts_at,ends_at,due_at,completed_at,custom,created_by,updated_by) values(${orgId},${source.kind},${status},${String(mapped.subject)},${mapped.body ?? null},${startsAt},${date(record.enddate)},${date(record.duedate)},${completedAt},${JSON.stringify({ netsuite: metadata })}::jsonb,${actorId},${actorId}) returning id`,
                "objects",
              );
          const id = result[0]?.id;
          if (!id) throw new Error("The imported CRM activity was not saved");
          return id;
        },
      );
      // Re-import retains an existing link to the same native account.
      // The unique activity/subject identity is a benign replay conflict.
      if (party)
        await db.execute(
          sql`insert into crm_activity_links(org_id,activity_id,subject_kind,subject_id,created_by,updated_by) values(${orgId},${activityId},'account',${party.id},${actorId},${actorId}) on conflict(activity_id,subject_kind,subject_id) do nothing`,
        );
      imported++;
    }
    report.activities[source.type] = imported;
    if (source.type === "note") report.sourceNoteLinks = collection.length;
  }
}

/** Idempotent CRM import from the tenant's stored NetSuite connection. */
export async function importNetSuiteCrm(
  orgId: string,
  connectionId?: string,
  transport: typeof fetch = guardedFetch,
  options: { actorId?: string | null } = {},
): Promise<CrmImportReport> {
  // Canonical switchboard read (::boolean casts threw on non-boolean imports).
  if (!(await orgFeatureEnabled(orgId, "crm"))) throw new Error("CRM feature is disabled");
  const creds = await credentials(orgId, connectionId);
  const actorId = options.actorId ?? null;
  if (actorId !== null) {
    if (!isUuid(actorId)) throw new Error("CRM import actor must be a valid user id");
    const actor = await db.execute<{ id: string }>(
      sql`select id from users where id=${actorId} and org_id=${orgId} and is_active`,
      "objects",
    );
    if (!actor[0]) throw new Error("CRM import actor must be an active user in the tenant");
  }
  const mappings = await netSuiteOperationalMappingWriter(orgId, creds.connectionId, actorId);
  await ensureCrmDefaults(orgId, actorId);
  const report: CrmImportReport = {
    accountStatuses: 0,
    accounts: 0,
    missingParties: 0,
    opportunities: 0,
    opportunityLines: 0,
    activities: {},
    sourceNoteLinks: 0,
    warnings: [],
  };

  const statuses = await suiteql<{
    key: string;
    name: string;
    entitytype: string;
    probability?: string;
    inactive?: string;
  }>(
    `select key,name,entitytype,probability,inactive from entitystatus where entitytype in ('LEAD','PROSPECT','CUSTOMER')`,
    creds,
    1000,
    transport,
  );
  const statusIds = new Map<string, string>();
  for (const source of statuses) {
    const lifecycle = stage(source.entitytype);
    const statusId = await mappings.write(
      "crmAccountStatuses",
      source.key,
      { name: source.name },
      sql`lifecycle_stage=${lifecycle} and key=${`netsuite_${source.key}`}`,
      async (mapped) => {
        const saved = await db.execute<{ id: string }>(
          sql`insert into crm_account_statuses(org_id,lifecycle_stage,key,name,sequence,is_qualified,is_active,created_by,updated_by) values(${orgId},${lifecycle},${`netsuite_${source.key}`},${String(mapped.name)},100,${lifecycle !== "lead"},${source.inactive !== "T"},${actorId},${actorId}) on conflict(org_id,lifecycle_stage,key) do update set name=excluded.name,is_qualified=excluded.is_qualified,is_active=excluded.is_active,updated_at=now(),updated_by=${actorId} where crm_account_statuses.org_id=${orgId} returning id`,
          "objects",
        );
        if (!saved[0]) throw new Error("The imported CRM account status was not saved");
        return saved[0].id;
      },
    );
    statusIds.set(`${lifecycle}:${source.key}`, statusId);
    report.accountStatuses++;
  }

  // An account may expose a custom qualification-probability field; a stock
  // NetSuite has none. SuiteQL errors on an unknown identifier, so only select
  // it when the connection maps one, and fall back to the standard `probability`.
  const probField =
    typeof (creds as { probabilityField?: string }).probabilityField === "string" &&
    /^[a-z0-9_]+$/i.test((creds as { probabilityField?: string }).probabilityField!)
      ? (creds as { probabilityField?: string }).probabilityField!
      : undefined;
  const probCol = probField ? `,${probField}` : "";
  const customers = await suiteql<{
    id: string;
    stage: string;
    entitystatus?: string;
    probability?: string;
    dateprospect?: string;
    dateclosed?: string;
    datecreated?: string;
  }>(
    `select id,stage,entitystatus,probability${probCol}, dateprospect,dateclosed,datecreated from customer`,
    creds,
    1000,
    transport,
  );
  for (const customer of customers) {
    const lifecycle = stage(customer.stage);
    const party = await db.execute<{ id: string }>(
      sql`select id from parties where org_id=${orgId} and custom->>'nsId'=${customer.id} limit 1`,
      "objects",
    );
    if (!party[0]) {
      report.missingParties++;
      continue;
    }
    const partyId = party[0].id;
    const scoreText =
      (probField ? (customer as Record<string, string | undefined>)[probField] : undefined) ??
      customer.probability;
    const score =
      scoreText == null || scoreText === ""
        ? null
        : Math.max(0, Math.min(100, Math.round(Number(scoreText))));
    const statusId = customer.entitystatus
      ? (statusIds.get(`${lifecycle}:${customer.entitystatus}`) ?? null)
      : null;
    await mappings.write(
      "crmAccounts",
      customer.id,
      { lifecycleStage: lifecycle, qualificationScore: scoreText },
      sql`party_id=${partyId}`,
      async () =>
        db.transaction(async (tx) => {
          // Lock the profile while comparing stages so concurrent imports cannot
          // both observe the same old stage and lose a transition event.
          const existing = await tx.execute<{
            id: string;
            lifecycle_stage: "lead" | "prospect" | "customer";
          }>(
            sql`
        select id,lifecycle_stage
         from crm_account_profiles
         where org_id=${orgId} and party_id=${partyId}
         for update`,
            "objects",
          );
          const previousStage = existing[0]?.lifecycle_stage ?? null;
          const profileExists = existing.length > 0;
          const stageChanged = previousStage !== lifecycle;
          const fromStage = profileExists && stageChanged ? previousStage : null;
          const saved = await tx.execute<{ id: string }>(
            sql`insert into crm_account_profiles(org_id,party_id,lifecycle_stage,status_id,qualification_score,qualified_at,converted_at,acquired_on,is_active,custom,created_by,updated_by) values(${orgId},${partyId},${lifecycle},${statusId},${score},${lifecycle !== "lead" ? date(customer.dateprospect ?? customer.datecreated) : null},${lifecycle === "customer" ? date(customer.dateclosed ?? customer.datecreated) : null},${lifecycle === "customer" ? date(customer.dateclosed ?? customer.datecreated) : null},true,${JSON.stringify({ netsuite: { id: customer.id, stage: customer.stage, statusId: customer.entitystatus } })}::jsonb,${actorId},${actorId}) on conflict(party_id) do update set lifecycle_stage=excluded.lifecycle_stage,status_id=excluded.status_id,qualification_score=excluded.qualification_score,qualified_at=coalesce(crm_account_profiles.qualified_at,excluded.qualified_at),converted_at=coalesce(crm_account_profiles.converted_at,excluded.converted_at),acquired_on=coalesce(crm_account_profiles.acquired_on,excluded.acquired_on),is_active=true,custom=crm_account_profiles.custom||excluded.custom,updated_at=now(),updated_by=${actorId} where crm_account_profiles.org_id=${orgId} returning id`,
            "objects",
          );
          if (!saved[0]) throw new Error("The imported CRM account profile was not saved");
          // A new profile (or one created before import history existed) gets one
          // initial import event. Existing imported profiles append every stage
          // transition, including reversions reported by the source.
          const eventGuard =
            profileExists && stageChanged
              ? sql`true`
              : sql`not exists(select 1 from crm_account_stage_events where org_id=${orgId} and account_profile_id=${saved[0]!.id} and source_kind='import')`;
          await tx.execute(
            sql`insert into crm_account_stage_events(org_id,account_profile_id,from_stage,to_stage,source_kind,reason,occurred_at,created_by,updated_by) select ${orgId},${saved[0]!.id},${fromStage},${lifecycle},'import','Imported lifecycle from source',coalesce(${date(customer.dateclosed ?? customer.dateprospect ?? customer.datecreated)}::timestamptz,now()),${actorId},${actorId} where ${eventGuard}`,
          );
          return saved[0].id;
        }),
    );
    report.accounts++;
  }

  const noteLinks = await suiteql<{ id: string; entity: string }>(
    "select id,entity from note",
    creds,
    1000,
    transport,
  );
  report.sourceNoteLinks = noteLinks.length;

  const opportunities = await suiteql<{
    id: string;
    tranid: string;
    entity?: string;
    trandate?: string;
    duedate?: string;
    status?: string;
    probability?: string;
    currency?: string;
    foreigntotal?: string;
    memo?: string;
  }>(
    `select id,tranid,entity,trandate,duedate,status,probability,currency,foreigntotal,memo from transaction where type='Opprtnty'`,
    creds,
    1000,
    transport,
  );
  const [defaultStatusResult, orgResult, configuredCurrencyResult] = await Promise.all([
    db.execute<{ id: string; probability: number }>(
      sql`select id,probability from crm_opportunity_statuses where org_id=${orgId} and is_default order by sequence limit 1`,
      "objects",
    ),
    db.execute<{ base_currency: string }>(
      sql`select base_currency from orgs where id=${orgId}`,
      "objects",
    ),
    db.execute<{ code: string }>(sql`select code from currencies`, "objects"),
  ]);
  const defaultStatus = defaultStatusResult[0];
  const baseCurrency = orgResult[0]?.base_currency;
  if (!baseCurrency)
    throw new Error(
      "The tenant must have a configured base currency before CRM opportunities can be imported",
    );
  const configuredCurrencies = new Set(
    configuredCurrencyResult.map((row) => row.code.toUpperCase()),
  );
  const sourceCurrencyById = new Map<string, string>();
  try {
    const sourceCurrencies = await suiteql<{ id: string; symbol?: string }>(
      "select id,symbol from currency",
      creds,
      1000,
      transport,
    );
    for (const currency of sourceCurrencies) {
      const code = sourceText(currency.symbol)?.toUpperCase();
      if (code && /^[A-Z]{3}$/.test(code)) sourceCurrencyById.set(String(currency.id), code);
    }
  } catch {
    // Single-currency source accounts do not expose this record; null transaction
    // currencies resolve to the tenant's configured base currency below.
  }
  for (const opportunity of opportunities) {
    const party = opportunity.entity
      ? (
          await db.execute<{ id: string }>(
            sql`select id from parties where org_id=${orgId} and custom->>'nsId'=${opportunity.entity} limit 1`,
            "objects",
          )
        )[0]
      : null;
    if (!defaultStatus)
      throw new Error("CRM import requires a default opportunity status in Company Setup");
    if (!party) {
      report.missingParties++;
      report.warnings.push(
        `Opportunity ${opportunity.tranid || opportunity.id} requires missing source party ${opportunity.entity ?? "(blank)"}`,
      );
      continue;
    }
    const currency = resolveNetSuiteCrmCurrency(
      opportunity.currency,
      baseCurrency,
      sourceCurrencyById,
      configuredCurrencies,
    );
    if (!currency) {
      report.warnings.push(
        `Opportunity ${opportunity.tranid || opportunity.id} was skipped because source currency ${opportunity.currency ?? "(blank)"} does not resolve to a configured ISO currency.`,
      );
      continue;
    }
    const probability = resolveNetSuiteCrmOpportunityProbability(
      opportunity.probability,
      defaultStatus.probability,
    );
    const projectedAmount = persistSyncLineMoney(
      opportunity.foreigntotal || "0",
      "projected_amount",
    );
    const weightedAmount = persistSyncLineMoney(
      weightAmount(projectedAmount, probability),
      "weighted_amount",
    );
    await mappings.write(
      "crmOpportunities",
      opportunity.id,
      {
        title: opportunity.memo || opportunity.tranid || `NS-${opportunity.id}`,
        description: opportunity.memo ?? null,
      },
      sql`opportunity_number=${opportunity.tranid || `NS-${opportunity.id}`}`,
      async (mapped) => {
        const saved = await db.execute<{ id: string }>(
          sql`insert into crm_opportunities(org_id,opportunity_number,title,party_id,status_id,probability,expected_close_date,currency,projected_amount,weighted_amount,description,is_active,custom,created_by,updated_by) values(${orgId},${opportunity.tranid || `NS-${opportunity.id}`},${String(mapped.title)},${party.id},${defaultStatus.id},${probability},${date(opportunity.duedate)},${currency},${projectedAmount},${weightedAmount},${mapped.description ?? null},true,${JSON.stringify({ netsuite: { id: opportunity.id } })}::jsonb,${actorId},${actorId}) on conflict(org_id,opportunity_number) do update set probability=excluded.probability,title=excluded.title,party_id=excluded.party_id,expected_close_date=excluded.expected_close_date,currency=excluded.currency,projected_amount=excluded.projected_amount,weighted_amount=excluded.weighted_amount,description=excluded.description,custom=crm_opportunities.custom||excluded.custom,updated_at=now(),updated_by=${actorId} where crm_opportunities.org_id=${orgId} returning id`,
          "objects",
        );
        if (!saved[0]) throw new Error("The imported CRM opportunity was not saved");
        return saved[0].id;
      },
    );
    report.opportunities++;
  }
  await importNativeActivities(orgId, actorId, creds, report, transport, mappings);
  return report;
}
