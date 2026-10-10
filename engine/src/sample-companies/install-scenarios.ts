import { createPromotion } from "../sales/promotions.ts";
import { installOperatingReturns } from "./install-returns.ts";
import { snapshotSampleRecords, assertSampleRecordsPreserved, assertSampleSettingsPreserved } from "./preservation.ts";
import { verifyNativeOperatingEvidence } from "./readiness.ts";
import { installOperatingPayments } from "./install-payments.ts";
import { installFeatureWorkflows } from "./install-feature-workflows.ts";
import { installOperatingBanking } from "./install-banking.ts";
import { installOperatingDocuments, verifyOperatingDocuments } from "./install-operations.ts";
import { isDeepStrictEqual } from "node:util";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction, type SqlExecutor } from "../platform/db.ts";
import { demoRecords, scenarioRecordId, type DemoContext, type DemoRecord } from "./scenarios.ts";
import { demoFeatureEvidence, type DemoFeatureEvidence } from "./coverage.ts";
import { sampleCompanyFeatures, sampleRefreshFeatures } from "./features.ts";
import { SAMPLE_COMPANY_BY_INDUSTRY } from "./catalog.ts";
import { generateAccountingPeriods } from "../close/calendar.ts";
import { createUsageRatingPlan, createUsageRatingPlanVersion, replaceUsageRatingBands, publishUsagePlanVersion, createSubscriptionUsageLink } from "../billing/usage/rating-plans.ts";
import { createUsageMeter, ingestUsageRecords } from "../billing/usage/records.ts";
import { recomputeSaasMetrics } from "../billing/metrics/metrics-ledger.ts";
import { createScriptJournal } from "../ledger/journal-writes.ts";
import { postDocument } from "../ledger/posting-document.ts";
import { loadRequiredControlAccounts } from "../records/control-accounts.ts";
import { submitAndReleaseIfUngated } from "../flows/submit.ts";
import { authorizeReturn } from "../sales/returns.ts";
import { activatePropertyLease } from "../property/lease-schedules.ts";
import { receiveInventory } from "../inventory/movements.ts";
import { provisionFundAccounting } from "../nonprofit/provision.ts";
import { seedPayrollComponents } from "../payroll/run-setup.ts";
import { SampleCompanyError } from "./provisioning-failures.ts";

export const DEMO_DATA_VERSION = 5;
const IDENTIFIER = /^[a-z][a-z0-9_]*$/;
function identifier(value: string) {
  if (!IDENTIFIER.test(value)) throw new Error(`Invalid demo record identifier: ${value}`);
  return sql.raw(`"${value}"`);
}

async function context(tx: SqlExecutor, orgId: string, industryKey: string, extendPeriods = false): Promise<DemoContext> {
  const profile = SAMPLE_COMPANY_BY_INDUSTRY.get(industryKey);
  if (!profile) throw new SampleCompanyError(`Unknown demo industry: ${industryKey}`);
  const result = await tx.execute<{
    settings: Record<string, unknown>; currency: string; actorId: string; subsidiaryId: string;
    bookId: string; periodId: string; customerId: string; vendorId: string;
    opportunityStatusId: string; date: string; seed: string | null; envKind: string; operatorAccessible: boolean;
  }>(sql`
    select o.settings, o.base_currency as currency, o.sandbox_seed as seed, o.env_kind as "envKind",
      exists(select 1 from user_org_access access where access.org_id=o.id and access.is_active) as "operatorAccessible",
      (select u.id from users u join role_assignments ra on ra.org_id=u.org_id and ra.user_id=u.id join app_roles ar on ar.org_id=ra.org_id and ar.id=ra.role_id where u.org_id=o.id and u.is_active and ar.key='admin' order by u.created_at,u.id limit 1) as "actorId",
      (select id from subsidiaries where org_id=o.id and parent_id is null and is_active limit 1) as "subsidiaryId",
      (select id from accounting_books where org_id=o.id and is_primary limit 1) as "bookId",
      p.id as "periodId",
      (select party_id from customer_roles where org_id=o.id order by id limit 1) as "customerId",
      (select party_id from vendor_roles where org_id=o.id order by id limit 1) as "vendorId",
      (select id from crm_opportunity_statuses where org_id=o.id and is_active order by id limit 1) as "opportunityStatusId",
      greatest(p.starts_on, least(current_date, p.ends_on))::text as date
    from orgs o
    left join lateral (
      select period.id, period.starts_on, period.ends_on from accounting_periods period
      where period.org_id=o.id and not period.is_adjustment
        and period.fiscal_calendar_id in (select id from fiscal_calendars where org_id=o.id and is_default and is_active)
        and not exists (select 1 from period_locks lock where lock.org_id=o.id and lock.period_id=period.id and lock.state <> 'open')
      order by case when current_date between period.starts_on and period.ends_on then 0 when period.starts_on > current_date then 1 else 2 end,
        period.starts_on limit 1
    ) p on true
    where o.id=${orgId} for update of o
  `);
  const row = result.rows[0];
  if (!row) throw new SampleCompanyError(`Demo organization ${orgId} could not be read`);
  const member = row.settings.sampleCompany as Record<string, unknown> | undefined;
  const memberSample = !!member;
  if (memberSample ? row.envKind !== "preview" || member!.industryKey !== industryKey || member!.profileId !== profile.profileId
    || member!.immutableSyntheticSource !== true || !row.seed || typeof member!.templateOrgId !== "string"
    || (member!.provisioningStage != null && !["ready", "numbering_reconciled"].includes(String(member!.provisioningStage)))
    : row.settings.simHarness !== true || row.settings.simProfile !== profile.profileId) {
    throw new SampleCompanyError("Scenarios require a matching synthetic master or a fully provisioned native exploration company.");
  }
  const identity = { orgId, identitySourceOrgId: memberSample ? String(member!.templateOrgId) : undefined, identitySeed: memberSample ? row.seed! : undefined };
  const installed = row.settings.demoData as { anchorDate?: string } | undefined;
  const anchored = installed?.anchorDate ?? (await tx.execute<{ date: string }>(sql`
    select statement_date::text as date from bank_statements where org_id=${orgId} and id=${scenarioRecordId(identity, "bank_statements", "operating-v3")}
  `)).rows[0]?.date;
  // Authored scenario dates are stable across retries. New financial activity uses
  // the separately resolved open period, preserving closed demonstration history.
  let operationDate = row.date;
  if (anchored) row.date = anchored;
  for (const key of ["actorId", "subsidiaryId", "bookId", "customerId", "vendorId", "opportunityStatusId"] as const) {
    if (!row[key]) throw new SampleCompanyError(`Demo company is missing ${key}; prepare its accounting foundation before installing scenarios.`);
  }
  if (!row.periodId) {
    if (!extendPeriods) throw new SampleCompanyError("The master demo has no open accounting period; prepare its industry template to extend the calendar without reopening posted history.");
    const calendar = (await tx.execute<{ id: string; year: number }>(sql`
      select c.id, coalesce((select max(p.fiscal_year)+1 from accounting_periods p where p.org_id=c.org_id and p.fiscal_calendar_id=c.id), extract(year from current_date)::int)::int as year
      from fiscal_calendars c where c.org_id=${orgId} and c.is_default and c.is_active
    `)).rows[0];
    if (!calendar) throw new SampleCompanyError("The demo needs an active default fiscal calendar; configure its calendar before preparing scenarios.");
    await generateAccountingPeriods(orgId, calendar.id, calendar.year, row.actorId);
    return context(tx, orgId, industryKey);
  }
  const openDates = (await tx.execute<{ date: string }>(sql`
    select least(p.ends_on,greatest(p.starts_on,${operationDate}::date))::text as date
    from accounting_periods p where p.org_id=${orgId} and not p.is_adjustment
      and p.fiscal_calendar_id in (select id from fiscal_calendars where org_id=${orgId} and is_default and is_active)
      and not exists(select 1 from period_locks l where l.org_id=p.org_id and l.period_id=p.id and l.state<>'open')
    order by case when p.starts_on<=${operationDate}::date then 0 else 1 end,
      case when p.starts_on<=${operationDate}::date then p.starts_on end desc,p.starts_on limit 3
  `)).rows.map(row => row.date).sort();
  const operationDates = openDates.length ? openDates : [operationDate];
  operationDate = operationDates[operationDates.length - 1]!;
  const accounts = (await tx.execute<{ id: string; number: string; name: string; type: string }>(sql`
    select id, number, name, type from accounts where org_id=${orgId} and is_active and not is_summary order by number
  `)).rows;
  const account = (types: string[], expression?: RegExp): string => {
    const candidates = accounts.filter((a) => types.includes(a.type));
    const selected = expression ? candidates.find((a) => expression.test(a.name)) : candidates[0];
    if (!selected) throw new SampleCompanyError(`Demo company needs an account of type ${types.join(" or ")}.`);
    return selected.id;
  };
  const features = sampleCompanyFeatures(industryKey);
  return {
    ...row, ...identity, memberSample, preserveExisting: memberSample || row.operatorAccessible || installed != null, operationDate, operationDates, industryKey, companyName: profile.companyName, year: Number(row.date.slice(0, 4)), employeeId: scenarioRecordId(identity, "parties", "employee"),
    accounts: {
      bank: account(["asset_bank"]), receivable: account(["asset_receivable"]), revenue: account(["income"]),
      expense: account(["expense", "cogs"], /operating|materials|supplies|general.*administrative/i), inventory: scenarioRecordId(identity, "accounts", "inventory"),
      payable: features.inventory || features.propertyManagement ? account(["liability_current_other"], /deposit|accrued/i) : "", equipment: scenarioRecordId(identity, "accounts", "equipment"),
      deferredRevenue: scenarioRecordId(identity, "accounts", "deferred-revenue"),
      accumulatedDepreciation: scenarioRecordId(identity, "accounts", "accumulated-depreciation"),
    },
  };
}

async function tableColumns(tx: SqlExecutor, tables: string[]): Promise<Map<string, Map<string, string>>> {
  const result = await tx.execute<{ table_name: string; column_name: string; data_type: string }>(sql`
    select table_name, column_name, data_type from information_schema.columns
     where table_schema='public' and table_name in (${sql.join(tables.map((table) => sql`${table}`), sql`, `)})
       and is_generated = 'NEVER'
  `);
  const columns = new Map<string, Map<string, string>>();
  for (const row of result.rows) {
    const names = columns.get(row.table_name) ?? new Map<string, string>();
    names.set(row.column_name, row.data_type); columns.set(row.table_name, names);
  }
  return columns;
}

/** Tables and native primary keys authored by this industry, including legacy drafts. */
export async function sampleScenarioPreservationTables(orgId: string, industryKey: string): Promise<Map<string, string>> {
  const c = await context(db, orgId, industryKey, true);
  return new Map(demoRecords(c).map(record => [record.table, record.primaryKey ?? "id"]));
}

/** Authored document fixtures remain draft-only and resolve every financial reference in this tenant. */
async function validateAuthoredDocument(tx: SqlExecutor, record: DemoRecord): Promise<void> {
  const value = record.values;
  const orgId = String(value.org_id);
  if (record.table === "documents") {
    if (value.status != null && value.status !== "draft") throw new SampleCompanyError("Authored document fixtures cannot supply an approved or posted state.");
    if (value.posted_entry_id != null) throw new SampleCompanyError("Authored document fixtures cannot supply a posting link.");
    for (const [column, table] of [["party_id", "parties"], ["subsidiary_id", "subsidiaries"], ["project_id", "projects"]] as const) {
      if (value[column] == null) continue;
      if (!(await tx.execute(sql`select id from ${identifier(table)} where org_id=${orgId} and id=${String(value[column])}`)).rows.length) throw new SampleCompanyError(`The authored ${value.kind} draft references a ${table} record outside its company.`);
    }
    const role = value.kind === "expense_report" ? "employee_roles" : value.kind === "purchase_order" ? "vendor_roles" : ["quote", "sales_order"].includes(String(value.kind)) ? "customer_roles" : null;
    if (role && !(await tx.execute(sql`select id from ${identifier(role)} where org_id=${orgId} and party_id=${String(value.party_id)}`)).rows.length) throw new SampleCompanyError(`The authored ${value.kind} draft needs a tenant-local ${role} party.`);
  }
  if (record.table === "document_lines") {
    if (!(await tx.execute(sql`select id from documents where org_id=${orgId} and id=${String(value.document_id)} and status='draft'`)).rows.length) throw new SampleCompanyError("Authored lines require a draft document in the same company.");
    if (value.account_id != null && !(await tx.execute(sql`select id from accounts where org_id=${orgId} and id=${String(value.account_id)} and is_active and not is_summary`)).rows.length) throw new SampleCompanyError("The authored line needs an active posting account in the same company.");
    if (value.item_id != null && !(await tx.execute(sql`select id from items where org_id=${orgId} and id=${String(value.item_id)}`)).rows.length) throw new SampleCompanyError("The authored line needs an item in the same company.");
  }
}

async function insertRecord(tx: SqlExecutor, record: DemoRecord, columns: Map<string, string>, actorId: string, preserveExisting = false): Promise<"inserted" | "updated" | "unchanged"> {
  const primaryKey = record.primaryKey ?? "id";
  const values = Object.entries(record.values).filter(([key]) => {
    // These audit columns are absent on a few native extension/link tables.
    if ((key === "created_by" || key === "updated_by") && !columns.has(key)) return false;
    if (!columns.has(key)) throw new SampleCompanyError(`The demo schema has no writable ${record.table}.${key}; use a compatible demo definition and database schema before installing demo data.`);
    return true;
  });
  // The promotion command owns UUID allocation. Its tenant-local code is the
  // stable native identity; retries and member refreshes preserve that record.
  if (record.table === "promotions") {
    const orgId = String(record.values.org_id);
    const code = String(record.values.code);
    const prior = (await tx.execute(sql`select id from promotions where org_id=${orgId} and upper(code)=upper(${code})`)).rows;
    if (prior.length > 1) throw new SampleCompanyError("The demonstration promotion code is ambiguous; review its native records before refreshing.");
    if (prior.length === 1) return "unchanged";
    if (record.values.kind !== "percent") throw new SampleCompanyError("The authored promotion needs a supported native creation contract.");
    const created = await createPromotion(tx, orgId, actorId, { code, name: String(record.values.name), kind: "percent",
      percentValue: String(record.values.percent_value), description: String(record.values.description) });
    if (created.code !== code || created.status !== "draft") throw new SampleCompanyError("Native promotion creation did not return the authored draft identity.");
    return "inserted";
  }
  const existing = await tx.execute(sql`
    select * from ${identifier(record.table)}
     where org_id=${String(record.values.org_id)} and ${identifier(primaryKey)}=${String(record.values[primaryKey])}
  `);
  // Stable identity means a retry adopts its own previous insert. No unrelated
  // conflict is swallowed; all other uniqueness violations remain refusals.
  if (existing.rows.length === 1) {
    if (preserveExisting) return "unchanged";
    const prior = existing.rows[0]!;
    // Extension versions and their files are immutable, including drafts.
    // Package corrections are new versioned identities in the authored scenarios.
    const editable = record.table === "automations" ? ["name", "description", "trigger", "actions"] : [];
    const changed = values.filter(([key, value]) => editable.includes(key) && !isDeepStrictEqual(prior[key], value));
    if (changed.length) {
      if (prior.status !== "draft") throw new SampleCompanyError(`The ${record.table} demonstration has advanced beyond draft; review its configuration through the normal workflow before preparing this master.`);
      const result = await tx.execute(sql`
        update ${identifier(record.table)} set ${sql.join(changed.map(([key,value]) => sql`${identifier(key)}=${typeof value === "object" && value !== null ? sql`${JSON.stringify(value)}::jsonb` : sql`${value}`}`), sql`, `)}, updated_by=${actorId}, updated_at=now()
        where org_id=${String(record.values.org_id)} and ${identifier(primaryKey)}=${String(record.values[primaryKey])} and status='draft' returning ${identifier(primaryKey)}
      `);
      if (result.rows.length !== 1) throw new SampleCompanyError(`The ${record.table} demonstration changed during correction; reload it before preparing this master.`);
      await tx.execute(sql`insert into audit_log(org_id,table_name,row_id,action,actor_id,changes) values (${String(record.values.org_id)},${record.table},${String(record.values[primaryKey])},'update',${actorId},${JSON.stringify({ source: "industry_demo_installation", reason: "Keep the draft demonstration compatible with its native configuration contract", before: Object.fromEntries(changed.map(([key])=>[key,prior[key]])), after: Object.fromEntries(changed) })}::jsonb)`);
      return "updated";
    }
    return "unchanged";
  }
  if (existing.rows.length > 1) throw new SampleCompanyError(`Demo identity is ambiguous in ${record.table}.`);
  await validateAuthoredDocument(tx, record);
  const inserted = await tx.execute(sql`
    insert into ${identifier(record.table)} (${sql.join(values.map(([key]) => identifier(key)), sql`, `)})
    values (${sql.join(values.map(([key, value]) => columns.get(key) === "ARRAY" && Array.isArray(value) ? sql`array[${sql.join(value.map(item => sql`${String(item)}`), sql`, `)}]::text[]` : value !== null && typeof value === "object" ? sql`${JSON.stringify(value)}::jsonb` : sql`${value}`), sql`, `)})
    returning ${identifier(primaryKey)}
  `);
  if (inserted.rows.length !== 1) throw new SampleCompanyError(`Demo insert into ${record.table} could not be read back.`);
  await tx.execute(sql`
    insert into audit_log (org_id, table_name, row_id, action, actor_id, changes)
    values (${String(record.values.org_id)}, ${record.table}, ${String(record.values[primaryKey])}, 'insert', ${actorId},
      ${JSON.stringify({ source: "industry_demo_installation", reason: "Install synthetic product demonstration", after: Object.fromEntries(values) })}::jsonb)
  `);
  return "inserted";
}

export interface DemoInstallationResult { orgId: string; industryKey: string; version: number; inserted: number; updated: number; records: number; tables: number }

/** All editable scenarios and their registration commit atomically per tenant. */
export async function installDemoScenarios(orgId: string, industryKey: string): Promise<DemoInstallationResult> {
  return withOrgTransaction(orgId, async () => {
    const c = await context(db, orgId, industryKey, true);
    const rows = demoRecords(c);
    const preservation = c.preserveExisting ? await snapshotSampleRecords(orgId, new Map(rows.map(row => [row.table, row.primaryKey ?? "id"]))) : undefined;
    const tables = [...new Set(rows.map((row) => row.table))];
    const columns = await tableColumns(db, tables);
    const insertedDraftIds = new Set<string>();
    let inserted = 0;
    let updated = 0;
    for (const record of rows.filter(record => record.table !== "promotions")) {
      const names = columns.get(record.table);
      if (!names?.has("org_id")) throw new SampleCompanyError(`Demo table ${record.table} is unavailable; upgrade the database before installing demo data.`);
      const action = await insertRecord(db, record, names, c.actorId, c.preserveExisting);
      if (action === "inserted") {
        inserted += 1;
        if (record.table === "documents") insertedDraftIds.add(String(record.values.id));
      }
      if (action === "updated") updated += 1;
    }
    if (industryKey === "wholesale_distribution" && !c.preserveExisting) {
      const lineId = scenarioRecordId(c, "document_lines", "purchase");
      const line = (await db.execute<{ accountId: string; status: string }>(sql`
        select l.account_id as "accountId", d.status from document_lines l
        join documents d on d.id=l.document_id and d.org_id=l.org_id
        where l.org_id=${orgId} and l.id=${lineId} and d.kind='purchase_order' for update of l, d
      `)).rows[0];
      if (!line) throw new SampleCompanyError("The demonstration purchase order line could not be read back; prepare the master again before cloning it.");
      if (line.accountId !== c.accounts.expense) {
        if (line.status !== "draft") throw new SampleCompanyError("The demonstration purchase order has advanced beyond draft and needs a controlled correction through its order workflow before preparing the master.");
        const changed = await db.execute(sql`update document_lines set account_id=${c.accounts.expense}, updated_at=now(), updated_by=${c.actorId} where org_id=${orgId} and id=${lineId} and account_id=${line.accountId} returning id`);
        if (changed.rows.length !== 1) throw new SampleCompanyError("The demonstration purchase order changed during correction; reload the order before preparing the master.");
        await db.execute(sql`insert into audit_log(org_id,table_name,row_id,action,actor_id,changes) values (${orgId},'document_lines',${lineId},'update',${c.actorId},${JSON.stringify({ source: "industry_demo_installation", reason: "Classify the draft stock purchase as operating cost", before: { accountId: line.accountId }, after: { accountId: c.accounts.expense } })}::jsonb)`);
        updated++;
      }
    }
    const previous = (await db.execute<{ settings: Record<string, unknown>; envKind: string }>(sql`select settings, env_kind as "envKind" from orgs where id=${orgId}`)).rows[0]!;
    const before = previous.settings;
    const installed = before.demoData as Record<string, unknown> | undefined;
    if (inserted === 0 && updated === 0 && installed?.version === DEMO_DATA_VERSION && (await verifyDemoScenarios(orgId, industryKey)).ready) {
      return { orgId, industryKey, version: DEMO_DATA_VERSION, inserted, updated, records: rows.length, tables: tables.length };
    }
    const announcements = (before.home as { announcements?: Array<{ id: string }> } | undefined)?.announcements ?? [];
    const after = {
      ...before, industry: industryKey, features: c.memberSample || installed ? sampleRefreshFeatures(industryKey, before.features as Record<string, unknown> ?? {}) : sampleCompanyFeatures(industryKey),
      onboarding: before.onboarding ?? { schemaVersion: 1, setupComplete: true, completedAt: new Date().toISOString(), completedBy: c.actorId },
      home: { ...(before.home as object ?? {}), announcements: announcements.some(a => a.id === "industry-demo") ? announcements : [...announcements, { id: "industry-demo", title: `${c.companyName} demonstration`, body: "Explore synthetic accounting history and editable industry workflows. Drafts use the normal approval and posting controls. External services require your own configuration. Company Settings → Features lists the enabled capabilities.", audience: "all", startsOn: new Date().toISOString().slice(0, 10), endsOn: null }] },
      ...(sampleCompanyFeatures(industryKey).payroll ? { payroll: { ...(before.payroll as object ?? {}), countries: (before.payroll as { countries?: string[] } | undefined)?.countries ?? ["US"] } } : {}),
      demoData: { version: DEMO_DATA_VERSION, industryKey, anchorDate: c.date, installedAt: new Date().toISOString(), installedBy: c.actorId, records: rows.length, tables, externalServices: "unconfigured", coverage: demoFeatureEvidence(industryKey) },
    };
    const changed = await db.execute(sql`update orgs set env_kind='preview', settings=${JSON.stringify(after)}::jsonb, updated_by=${c.actorId}, updated_at=now() where id=${orgId} returning id`);
    if (changed.rows.length !== 1) throw new SampleCompanyError("Demo company disappeared before registration.");
    // Feature-gated native configuration commands run after the audited gate
    // registration and inside this same atomic installation transaction.
    for (const record of rows.filter(record => record.table === "promotions")) {
      const names = columns.get(record.table);
      if (!names?.has("org_id")) throw new SampleCompanyError("The native promotions schema is unavailable; apply the supported schema before installing scenarios.");
      const action = await insertRecord(db, record, names, c.actorId, c.preserveExisting);
      if (action === "inserted") inserted += 1;
    }
    const features = sampleCompanyFeatures(industryKey);
    const equity = scenarioRecordId(c, "accounts", "capital");
    if (!c.preserveExisting) for (const [key, amount, offset, memo] of [
      ["opening-cash", "100000.00", equity, "Synthetic capital contribution for demonstration operating cash"],
      ["bank-charge", "-500.00", c.accounts.expense, "Synthetic monthly banking charges"],
    ] as const) {
      const journal = await createScriptJournal(orgId, c.actorId, { documentDate: c.date, subsidiaryId: c.subsidiaryId, memo,
        lines: [{ accountId: scenarioRecordId(c, "accounts", "bank"), amount }, { accountId: offset, amount: amount.startsWith("-") ? amount.slice(1) : `-${amount}` }],
      }, { post: true, idempotencyKey: `industry-demo:${orgId}:${key}`, allowedSubsidiaryIds: null });
      if (!journal.entryId || journal.approvalPending) throw new SampleCompanyError("Demo preparation cannot approve its own journals. Review the master’s journal approval routing in Flows before retrying preparation.");
    }
    if (features.payroll && !c.preserveExisting) await seedPayrollComponents(orgId, c.actorId, "US", null);
    if (features.fundAccounting && !c.preserveExisting) await provisionFundAccounting({
      orgId, actorId: c.actorId, defaultFund: { code: "DEMO-OPERATING", name: "Operating fund" },
      classifications: {
        "DEMO-OPERATING": { kind: "operating", restrictionClass: "without_donor_restrictions", budgetaryControl: "advisory" },
        "DEMO-YOUTH": { kind: "restricted", restrictionClass: "with_donor_restrictions", budgetaryControl: "advisory" },
        "DEMO-ENDOWMENT": { kind: "endowment", restrictionClass: "with_donor_restrictions", budgetaryControl: "advisory" },
      },
    });
    if (features.inventory && !c.preserveExisting) {
      for (const [key, unitCost] of [["component", "12.50"], ["finished", "38.00"]]) {
        const itemId = scenarioRecordId(c, "items", key!);
        const receiptKey = `industry-demo:${orgId}:receipt:${key}`;
        const existing = await db.execute(sql`select id from inventory_movements where org_id=${orgId} and idempotency_key=${receiptKey}`);
        if (existing.rows.length === 0) await receiveInventory(orgId, c.actorId, {
          itemId, stockLocationId: scenarioRecordId(c, "stock_locations", "main"),
          quantity: "200.00", unitCost: unitCost!, subsidiaryId: c.subsidiaryId,
          offsetAccountId: c.accounts.payable, date: c.date, idempotencyKey: receiptKey,
          memo: "Synthetic opening receipt for the industry demonstration", tx: db,
        });
      }
    }
    if (features.usageBilling && !c.preserveExisting) {
      let meter = (await db.execute<{ key: string; customerId: string; subscriptionId: string }>(sql`
        select m.key, s.customer_id as "customerId", s.id as "subscriptionId" from usage_meters m
        join subscription_usage_links link on m.id=any(link.meter_ids) and link.org_id=m.org_id
        join subscriptions s on s.id=link.subscription_id and s.org_id=link.org_id
        where m.org_id=${orgId} and m.is_active order by m.key, s.id limit 1
      `)).rows[0];
      if (!meter) {
        const subscriber = (await db.execute<{ id: string; customerId: string }>(sql`select id, customer_id as "customerId" from subscriptions where org_id=${orgId} and status='active' order by id limit 1`)).rows[0];
        if (!subscriber) throw new SampleCompanyError("The SaaS demo needs an active subscription; prepare its recurring-billing foundation before installing usage scenarios.");
        const created = await createUsageMeter(orgId, c.actorId, { key: "demo-api-calls", name: "Demonstration API calls", unit: "call", aggregation: "sum", itemId: scenarioRecordId(c, "items", "main") });
        const plan = await createUsageRatingPlan(orgId, c.actorId, { name: "Demonstration graduated API usage", currency: c.currency });
        const version = await createUsageRatingPlanVersion(orgId, c.actorId, { planId: plan.id, effectiveFrom: c.date });
        await replaceUsageRatingBands(orgId, c.actorId, version.id, [{ meterId: created.id, kind: "graduated", seq: 1, upToQty: null, unitPrice: "0.00250000" }]);
        await publishUsagePlanVersion(orgId, c.actorId, version.id);
        await createSubscriptionUsageLink(orgId, c.actorId, { subscriptionId: subscriber.id, customerId: subscriber.customerId, planVersionId: version.id, meterIds: [created.id], effectiveFrom: c.date, allowOverage: true });
        meter = { key: created.key, customerId: subscriber.customerId, subscriptionId: subscriber.id };
      }
      await ingestUsageRecords(orgId, c.actorId, [{ meterKey: meter.key, customerId: meter.customerId, subscriptionId: meter.subscriptionId,
        occurredOn: c.date, quantity: "12500", source: "manual", sourceRef: "Synthetic demonstration reading", idempotencyKey: `industry-demo:${orgId}:usage-reading` }]);
      const firstMonth = (await db.execute<{ month: string }>(sql`select date_trunc('month', min(start_on))::date::text as month from subscriptions where org_id=${orgId}`)).rows[0]?.month;
      if (!firstMonth) throw new SampleCompanyError("The SaaS demo has no subscription start month; review its subscriptions before preparing metrics.");
      const targetMonth = `${c.date.slice(0, 7)}-01`;
      for (let month = firstMonth; month <= targetMonth;) {
        const stored = await db.execute(sql`select 1 from saas_metrics_facts_monthly where org_id=${orgId} and month=${month}::date limit 1`);
        if (!stored.rows.length || month === targetMonth) await recomputeSaasMetrics(orgId, month);
        const next = new Date(`${month}T00:00:00Z`); next.setUTCMonth(next.getUTCMonth() + 1); month = next.toISOString().slice(0, 10);
      }
    }
    if (features.returnAuthorizations && !c.preserveExisting) {
      const invoiceId = scenarioRecordId(c, "documents", "stock-invoice");
      const invoice = (await db.execute<{ status: string }>(sql`select status from documents where org_id=${orgId} and id=${invoiceId}`)).rows[0];
      if (invoice?.status === "draft") {
        const released = await submitAndReleaseIfUngated("customer_invoice", invoiceId, c.actorId);
        if (released.flowError || released.gated || !released.autoApproved) throw new SampleCompanyError("The demonstration stock invoice needs approval before its return workflow can be prepared.");
        await postDocument(invoiceId, { control: await loadRequiredControlAccounts(orgId) }, { audit: { actorId: c.actorId, source: "industry_demo_installation" } });
      }
      const source = (await db.execute<{ id: string }>(sql`select id from inventory_movements where org_id=${orgId} and document_line_id=${scenarioRecordId(c, "document_lines", "stock-invoice")} and kind='issue' and status='posted'`)).rows[0];
      if (!source) throw new SampleCompanyError("The demonstration invoice has no posted stock issue; inspect its inventory posting before preparing the return.");
      const returnId = scenarioRecordId(c, "documents", "return");
      const returned = (await db.execute<{ status: string }>(sql`select status from documents where org_id=${orgId} and id=${returnId}`)).rows[0];
      if (returned?.status === "draft") await authorizeReturn(db, orgId, c.actorId, returnId, [{ lineNumber: 1, sourceIssueMovementId: source.id }], null);
    }
    if (features.propertyManagement && !c.preserveExisting) {
      const leaseId = scenarioRecordId(c, "property_leases", "residential");
      const lease = (await db.execute<{ status: string }>(sql`select status from property_leases where org_id=${orgId} and id=${leaseId}`)).rows[0];
      if (lease?.status === "draft") await activatePropertyLease(orgId, c.actorId, null, leaseId);
    }
    await installOperatingDocuments(c, insertedDraftIds);
    await installFeatureWorkflows(c);
    await installOperatingReturns(c);
    await installOperatingPayments(c);
    await installOperatingBanking(c);
    const verified = await verifyDemoScenarios(orgId, industryKey);
    if (!verified.ready) throw new SampleCompanyError(`The demo installation could not be verified: ${verified.missing.join(", ")}. Review the named native records before retrying preparation.`);
    if (preservation) {
      await assertSampleRecordsPreserved(orgId, preservation);
      const stored = (await db.execute<{ settings: Record<string, unknown> }>(sql`select settings from orgs where id=${orgId}`)).rows[0]!;
      assertSampleSettingsPreserved(before, stored.settings, industryKey);
    }
    await db.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, actor_id, changes)
      values (${orgId}, 'orgs', ${orgId}, 'update', ${c.actorId},
        ${JSON.stringify({ source: "industry_demo_installation", reason: "Register verified synthetic feature scenarios", before, after, environment: { before: previous.envKind, after: "preview" } })}::jsonb)
    `);
    return { orgId, industryKey, version: DEMO_DATA_VERSION, inserted, updated, records: rows.length, tables: tables.length };
  });
}

export interface DemoVerificationResult {
  ready: boolean; accountingQualified: boolean; missing: string[]; features: Record<string, DemoFeatureEvidence>;
  evidence: Record<string, { enabled: boolean; records: Record<string, number>; expectedStage: DemoFeatureEvidence["stage"]; nativeExecutionVerified: boolean }>;
}

/** Inspect the stored native records under the source tenant's RLS context. */
export async function verifyDemoScenarios(orgId: string, industryKey: string): Promise<DemoVerificationResult> {
  return withOrgTransaction(orgId, async () => {
    const c = await context(db, orgId, industryKey);
    const expected = demoRecords(c);
    const missing: string[] = await verifyOperatingDocuments({ ...c, employeeId: scenarioRecordId(c, "parties", "employee") });
    for (const table of new Set(expected.map((row) => row.table))) {
      const records = expected.filter((row) => row.table === table);
      const primaryKey = table === "promotions" ? "code" : records[0]!.primaryKey ?? "id";
      const result = await db.execute<{ id: string; record: Record<string, unknown> }>(sql`
        select ${identifier(primaryKey)}::text as id,to_jsonb(stored) as record from ${identifier(table)} stored where org_id=${orgId}
        and ${identifier(primaryKey)} in (${sql.join(records.map((row) => primaryKey === "code" ? sql`${String(row.values[primaryKey])}` : sql`${String(row.values[primaryKey])}::uuid`), sql`, `)})
      `);
      const stored = new Set(result.rows.map((row) => row.id));
      for (const record of records) {
        const key = String(record.values[primaryKey]);
        if (!stored.has(key)) { missing.push(`${table}:${record.key}`); continue; }
        // New operating children must point to their intended authored parents.
        // Member edits retain ownership; historical master fixtures predate these identities.
        if (!c.memberSample && /^(operations-|operating-|billing-child-|commercial-|contract-|variant-)/.test(record.key)) {
          const current = result.rows.find(row => row.id === key)!.record;
          for (const [column, expected] of Object.entries(record.values)) {
            if (!column.endsWith("_id") || column === "org_id" || column === "period_id" || expected == null) continue;
            if (current[column] !== expected) missing.push(`authored relationship: ${table}:${record.key}.${column}`);
          }
        }
      }
    }
    missing.push(...await verifyNativeOperatingEvidence(c));
    const features = demoFeatureEvidence(industryKey);
    const counts: Record<string, number> = {};
    for (const table of new Set(Object.values(features).flatMap((entry) => [...entry.tables]))) {
      const result = await db.execute<{ count: number }>(sql`select count(*)::int as count from ${identifier(table)} where org_id=${orgId}`);
      counts[table] = result.rows[0]?.count ?? 0;
      if (!counts[table]) missing.push(`feature evidence: ${table}`);
    }
    const row = (await db.execute<{ settings: Record<string, unknown>; env: string }>(sql`select settings, env_kind as env from orgs where id=${orgId}`)).rows[0]!;
    const installed = row.settings.demoData as Record<string, unknown> | undefined;
    if (installed?.version !== DEMO_DATA_VERSION) missing.push("current demo data version");
    if (!isDeepStrictEqual(installed?.coverage, features)) missing.push("current feature coverage manifest");
    const storedFeatures = row.settings.features as Record<string, unknown> | undefined;
    if (Object.entries(sampleCompanyFeatures(industryKey)).some(([key, enabled]) => enabled && storedFeatures?.[key] !== true)) missing.push("authoritative industry feature settings");
    const cash = (await db.execute<{ ready: boolean }>(sql`
      select count(*)=2 and coalesce(sum(l.amount),0)=99500.00 as ready
      from journal_lines l join journal_entries e on e.id=l.entry_id and e.org_id=l.org_id
      where l.org_id=${orgId} and l.account_id=${scenarioRecordId(c, "accounts", "bank")} and e.status='posted' -- Live entries only: the readiness probe asserts the live demonstration journals; reversed history does not satisfy it
    `)).rows[0];
    if (!c.memberSample && cash?.ready !== true) missing.push("posted demonstration cash and bank-charge journals");
    if (features.inventory && !c.memberSample) for (const key of ["component", "finished"]) {
      const receipt = await db.execute(sql`select id from inventory_movements where org_id=${orgId} and idempotency_key=${`industry-demo:${orgId}:receipt:${key}`} and kind='receipt' and status='posted'`);
      if (!receipt.rows.length) missing.push(`posted inventory receipt: ${key}`);
    }
    if (features.propertyManagement && !c.memberSample) {
      const lease = await db.execute(sql`select id from property_leases where org_id=${orgId} and id=${scenarioRecordId(c, "property_leases", "residential")} and status='active'`);
      if (!lease.rows.length) missing.push("active residential lease");
    }
    if (row.env !== "preview") missing.push("preview environment protections");
    if (!(row.settings.home as { announcements?: unknown[] } | undefined)?.announcements?.length) missing.push("home announcement");
    const ready = missing.length === 0;
    const evidence = Object.fromEntries(Object.entries(features).map(([key, feature]) => [key, {
      enabled: storedFeatures?.[key] === true, records: Object.fromEntries(feature.tables.map(table => [table, counts[table] ?? 0])),
      expectedStage: feature.stage, nativeExecutionVerified: ready && !c.memberSample && feature.stage === "executed",
    }]));
    const qualification = installed?.accountingVerification as { status?: string; version?: number } | undefined;
    return { ready, accountingQualified: !c.memberSample && qualification?.status === "passed" && qualification.version === DEMO_DATA_VERSION, missing, features, evidence };
  });
}
