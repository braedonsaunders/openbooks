import { isDeepStrictEqual } from "node:util";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction, type SqlExecutor } from "../platform/db.ts";
import { demoRecords, demoRecordId, type DemoContext, type DemoRecord } from "./scenarios.ts";
import { demoFeatureEvidence, type DemoFeatureEvidence } from "./coverage.ts";
import { sampleCompanyFeatures } from "./features.ts";
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

export const DEMO_DATA_VERSION = 4;
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
    opportunityStatusId: string; date: string;
  }>(sql`
    select o.settings, o.base_currency as currency,
      (select id from users where org_id=o.id and is_active order by created_at limit 1) as "actorId",
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
  if (row.settings.simHarness !== true || row.settings.simProfile !== profile.profileId || row.settings.sampleCompany) {
    throw new SampleCompanyError("Feature scenarios can only be installed into the matching synthetic master company.");
  }
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
    ...row, orgId, industryKey, companyName: profile.companyName, year: Number(row.date.slice(0, 4)), employeeId: "",
    accounts: {
      bank: account(["asset_bank"]), receivable: account(["asset_receivable"]), revenue: account(["income"]),
      expense: account(["expense", "cogs"], /operating|materials|supplies|general.*administrative/i), inventory: demoRecordId(orgId, "accounts", "inventory"),
      payable: features.inventory || features.propertyManagement ? account(["liability_current_other"], /deposit|accrued/i) : "", equipment: demoRecordId(orgId, "accounts", "equipment"),
      deferredRevenue: demoRecordId(orgId, "accounts", "deferred-revenue"),
      accumulatedDepreciation: demoRecordId(orgId, "accounts", "accumulated-depreciation"),
    },
  };
}

async function tableColumns(tx: SqlExecutor, tables: string[]): Promise<Map<string, Set<string>>> {
  const result = await tx.execute<{ table_name: string; column_name: string }>(sql`
    select table_name, column_name from information_schema.columns
     where table_schema='public' and table_name in (${sql.join(tables.map((table) => sql`${table}`), sql`, `)})
  `);
  const columns = new Map<string, Set<string>>();
  for (const row of result.rows) {
    const names = columns.get(row.table_name) ?? new Set<string>();
    names.add(row.column_name); columns.set(row.table_name, names);
  }
  return columns;
}

async function insertRecord(tx: SqlExecutor, record: DemoRecord, columns: Set<string>, actorId: string): Promise<"inserted" | "updated" | "unchanged"> {
  const primaryKey = record.primaryKey ?? "id";
  const values = Object.entries(record.values).filter(([key]) => {
    // These audit columns are absent on a few native extension/link tables.
    if ((key === "created_by" || key === "updated_by") && !columns.has(key)) return false;
    if (!columns.has(key)) throw new SampleCompanyError(`Demo schema is missing ${record.table}.${key}; upgrade the database before installing demo data.`);
    return true;
  });
  const existing = await tx.execute(sql`
    select * from ${identifier(record.table)}
     where org_id=${String(record.values.org_id)} and ${identifier(primaryKey)}=${String(record.values[primaryKey])}
  `);
  // Stable identity means a retry adopts its own previous insert. No unrelated
  // conflict is swallowed; all other uniqueness violations remain refusals.
  if (existing.rows.length === 1) {
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
  const inserted = await tx.execute(sql`
    insert into ${identifier(record.table)} (${sql.join(values.map(([key]) => identifier(key)), sql`, `)})
    values (${sql.join(values.map(([, value]) => value !== null && typeof value === "object" ? sql`${JSON.stringify(value)}::jsonb` : sql`${value}`), sql`, `)})
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
    const tables = [...new Set(rows.map((row) => row.table))];
    const columns = await tableColumns(db, tables);
    let inserted = 0;
    let updated = 0;
    for (const record of rows) {
      const names = columns.get(record.table);
      if (!names?.has("org_id")) throw new SampleCompanyError(`Demo table ${record.table} is unavailable; upgrade the database before installing demo data.`);
      const action = await insertRecord(db, record, names, c.actorId);
      if (action === "inserted") inserted += 1;
      if (action === "updated") updated += 1;
    }
    if (industryKey === "wholesale_distribution") {
      const lineId = demoRecordId(orgId, "document_lines", "purchase");
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
    const after = {
      ...before, industry: industryKey, features: sampleCompanyFeatures(industryKey),
      onboarding: { schemaVersion: 1, setupComplete: true, completedAt: new Date().toISOString(), completedBy: c.actorId },
      home: { ...(before.home as object ?? {}), announcements: [{ id: "industry-demo", title: `${c.companyName} demonstration`, body: "Explore synthetic accounting history and editable industry workflows. Drafts use the normal approval and posting controls. External services require your own configuration. Company Settings → Features lists the enabled capabilities.", audience: "all", startsOn: new Date().toISOString().slice(0, 10), endsOn: null }] },
      ...(sampleCompanyFeatures(industryKey).payroll ? { payroll: { ...(before.payroll as object ?? {}), countries: ["US"] } } : {}),
      demoData: { version: DEMO_DATA_VERSION, industryKey, installedAt: new Date().toISOString(), installedBy: c.actorId, records: rows.length, tables, externalServices: "unconfigured", coverage: demoFeatureEvidence(industryKey) },
    };
    const changed = await db.execute(sql`update orgs set env_kind='preview', settings=${JSON.stringify(after)}::jsonb, updated_by=${c.actorId}, updated_at=now() where id=${orgId} returning id`);
    if (changed.rows.length !== 1) throw new SampleCompanyError("Demo company disappeared before registration.");
    const features = sampleCompanyFeatures(industryKey);
    const equity = demoRecordId(orgId, "accounts", "capital");
    for (const [key, amount, offset, memo] of [
      ["opening-cash", "100000.00", equity, "Synthetic capital contribution for demonstration operating cash"],
      ["bank-charge", "-500.00", c.accounts.expense, "Synthetic monthly banking charges"],
    ] as const) {
      const journal = await createScriptJournal(orgId, c.actorId, { documentDate: c.date, subsidiaryId: c.subsidiaryId, memo,
        lines: [{ accountId: demoRecordId(orgId, "accounts", "bank"), amount }, { accountId: offset, amount: amount.startsWith("-") ? amount.slice(1) : `-${amount}` }],
      }, { post: true, idempotencyKey: `industry-demo:${orgId}:${key}`, allowedSubsidiaryIds: null });
      if (!journal.entryId || journal.approvalPending) throw new SampleCompanyError("Demo preparation cannot approve its own journals. Review the master’s journal approval routing in Flows before retrying preparation.");
    }
    if (features.payroll) await seedPayrollComponents(orgId, c.actorId, "US", null);
    if (features.fundAccounting) await provisionFundAccounting({
      orgId, actorId: c.actorId, defaultFund: { code: "DEMO-OPERATING", name: "Operating fund" },
      classifications: {
        "DEMO-OPERATING": { kind: "operating", restrictionClass: "without_donor_restrictions", budgetaryControl: "advisory" },
        "DEMO-YOUTH": { kind: "restricted", restrictionClass: "with_donor_restrictions", budgetaryControl: "advisory" },
        "DEMO-ENDOWMENT": { kind: "endowment", restrictionClass: "with_donor_restrictions", budgetaryControl: "advisory" },
      },
    });
    if (features.inventory) {
      for (const [key, unitCost] of [["component", "12.50"], ["finished", "38.00"]]) {
        const itemId = demoRecordId(orgId, "items", key!);
        const receiptKey = `industry-demo:${orgId}:receipt:${key}`;
        const existing = await db.execute(sql`select id from inventory_movements where org_id=${orgId} and idempotency_key=${receiptKey}`);
        if (existing.rows.length === 0) await receiveInventory(orgId, c.actorId, {
          itemId, stockLocationId: demoRecordId(orgId, "stock_locations", "main"),
          quantity: "200.00", unitCost: unitCost!, subsidiaryId: c.subsidiaryId,
          offsetAccountId: c.accounts.payable, date: c.date, idempotencyKey: receiptKey,
          memo: "Synthetic opening receipt for the industry demonstration", tx: db,
        });
      }
    }
    if (features.usageBilling) {
      let meter = (await db.execute<{ key: string; customerId: string; subscriptionId: string }>(sql`
        select m.key, s.customer_id as "customerId", s.id as "subscriptionId" from usage_meters m
        join subscription_usage_links link on m.id=any(link.meter_ids) and link.org_id=m.org_id
        join subscriptions s on s.id=link.subscription_id and s.org_id=link.org_id
        where m.org_id=${orgId} and m.is_active order by m.key, s.id limit 1
      `)).rows[0];
      if (!meter) {
        const subscriber = (await db.execute<{ id: string; customerId: string }>(sql`select id, customer_id as "customerId" from subscriptions where org_id=${orgId} and status='active' order by id limit 1`)).rows[0];
        if (!subscriber) throw new SampleCompanyError("The SaaS demo needs an active subscription; prepare its recurring-billing foundation before installing usage scenarios.");
        const created = await createUsageMeter(orgId, c.actorId, { key: "demo-api-calls", name: "Demonstration API calls", unit: "call", aggregation: "sum", itemId: demoRecordId(orgId, "items", "main") });
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
    if (features.returnAuthorizations) {
      const invoiceId = demoRecordId(orgId, "documents", "stock-invoice");
      const invoice = (await db.execute<{ status: string }>(sql`select status from documents where org_id=${orgId} and id=${invoiceId}`)).rows[0];
      if (invoice?.status === "draft") {
        const released = await submitAndReleaseIfUngated("customer_invoice", invoiceId, c.actorId);
        if (released.flowError || released.gated || !released.autoApproved) throw new SampleCompanyError("The demonstration stock invoice needs approval before its return workflow can be prepared.");
        await postDocument(invoiceId, { control: await loadRequiredControlAccounts(orgId) }, { audit: { actorId: c.actorId, source: "industry_demo_installation" } });
      }
      const source = (await db.execute<{ id: string }>(sql`select id from inventory_movements where org_id=${orgId} and document_line_id=${demoRecordId(orgId, "document_lines", "stock-invoice")} and kind='issue' and status='posted'`)).rows[0];
      if (!source) throw new SampleCompanyError("The demonstration invoice has no posted stock issue; inspect its inventory posting before preparing the return.");
      const returnId = demoRecordId(orgId, "documents", "return");
      const returned = (await db.execute<{ status: string }>(sql`select status from documents where org_id=${orgId} and id=${returnId}`)).rows[0];
      if (returned?.status === "draft") await authorizeReturn(db, orgId, c.actorId, returnId, [{ lineNumber: 1, sourceIssueMovementId: source.id }], null);
    }
    if (features.propertyManagement) {
      const leaseId = demoRecordId(orgId, "property_leases", "residential");
      const lease = (await db.execute<{ status: string }>(sql`select status from property_leases where org_id=${orgId} and id=${leaseId}`)).rows[0];
      if (lease?.status === "draft") await activatePropertyLease(orgId, c.actorId, null, leaseId);
    }
    const verified = await verifyDemoScenarios(orgId, industryKey);
    if (!verified.ready) throw new SampleCompanyError(`The demo installation could not be verified: ${verified.missing.join(", ")}. Review the named native records before retrying preparation.`);
    await db.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, actor_id, changes)
      values (${orgId}, 'orgs', ${orgId}, 'update', ${c.actorId},
        ${JSON.stringify({ source: "industry_demo_installation", reason: "Register verified synthetic feature scenarios", before, after, environment: { before: previous.envKind, after: "preview" } })}::jsonb)
    `);
    return { orgId, industryKey, version: DEMO_DATA_VERSION, inserted, updated, records: rows.length, tables: tables.length };
  });
}

export interface DemoVerificationResult { ready: boolean; missing: string[]; features: Record<string, DemoFeatureEvidence> }

/** Inspect the stored native records under the source tenant's RLS context. */
export async function verifyDemoScenarios(orgId: string, industryKey: string): Promise<DemoVerificationResult> {
  return withOrgTransaction(orgId, async () => {
    const c = await context(db, orgId, industryKey);
    const expected = demoRecords(c);
    const missing: string[] = [];
    for (const table of new Set(expected.map((row) => row.table))) {
      const records = expected.filter((row) => row.table === table);
      const primaryKey = records[0]!.primaryKey ?? "id";
      const result = await db.execute<{ id: string }>(sql`
        select ${identifier(primaryKey)}::text as id from ${identifier(table)} where org_id=${orgId}
        and ${identifier(primaryKey)} in (${sql.join(records.map((row) => sql`${String(row.values[primaryKey])}::uuid`), sql`, `)})
      `);
      const stored = new Set(result.rows.map((row) => row.id));
      for (const record of records) if (!stored.has(String(record.values[primaryKey]))) missing.push(`${table}:${record.key}`);
    }
    const features = demoFeatureEvidence(industryKey);
    for (const table of new Set(Object.values(features).flatMap((entry) => [...entry.tables]))) {
      const result = await db.execute(sql`select 1 from ${identifier(table)} where org_id=${orgId} limit 1`);
      if (!result.rows.length) missing.push(`feature evidence: ${table}`);
    }
    const row = (await db.execute<{ settings: Record<string, unknown>; env: string }>(sql`select settings, env_kind as env from orgs where id=${orgId}`)).rows[0]!;
    const installed = row.settings.demoData as Record<string, unknown> | undefined;
    if (installed?.version !== DEMO_DATA_VERSION) missing.push("current demo data version");
    if (!isDeepStrictEqual(installed?.coverage, features)) missing.push("current feature coverage manifest");
    const storedFeatures = row.settings.features as Record<string, unknown> | undefined;
    if (!isDeepStrictEqual(storedFeatures, sampleCompanyFeatures(industryKey))) missing.push("authoritative industry feature settings");
    const cash = (await db.execute<{ ready: boolean }>(sql`
      select count(*)=2 and coalesce(sum(l.amount),0)=99500.00 as ready
      from journal_lines l join journal_entries e on e.id=l.entry_id and e.org_id=l.org_id
      where l.org_id=${orgId} and l.account_id=${demoRecordId(orgId, "accounts", "bank")} and e.status='posted'
    `)).rows[0];
    if (cash?.ready !== true) missing.push("posted demonstration cash and bank-charge journals");
    if (features.inventory) for (const key of ["component", "finished"]) {
      const receipt = await db.execute(sql`select id from inventory_movements where org_id=${orgId} and idempotency_key=${`industry-demo:${orgId}:receipt:${key}`} and kind='receipt' and status='posted'`);
      if (!receipt.rows.length) missing.push(`posted inventory receipt: ${key}`);
    }
    if (features.propertyManagement) {
      const lease = await db.execute(sql`select id from property_leases where org_id=${orgId} and id=${demoRecordId(orgId, "property_leases", "residential")} and status='active'`);
      if (!lease.rows.length) missing.push("active residential lease");
    }
    if (row.env !== "preview") missing.push("preview environment protections");
    if (!(row.settings.home as { announcements?: unknown[] } | undefined)?.announcements?.length) missing.push("home announcement");
    return { ready: missing.length === 0, missing, features };
  });
}
