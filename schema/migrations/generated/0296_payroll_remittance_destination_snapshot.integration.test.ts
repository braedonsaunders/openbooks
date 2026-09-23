import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypass } from "../../../engine/src/platform/db.ts";
import {
  PAYROLL_COUNTRY_PACKS,
  statutoryRemittanceDeclaration,
} from "../../../engine/src/payroll/packs.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
} from "../../../engine/src/testing/fixtures.ts";
import {
  connectMigrationClient,
  executeMigrationBody,
  migrationRunsWithoutTransaction,
  releaseMigrationClient,
  sanitizeMigrationContent,
} from "../../../scripts/bootstrap-migration-client.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;
const MIGRATION_FILENAME = "generated/0296_payroll_remittance_destination_snapshot.sql";
const migrationSql = readFileSync(
  new URL("./0296_payroll_remittance_destination_snapshot.sql", import.meta.url),
  "utf8",
);

async function runMigration(): Promise<void> {
  // The file builds its hot-table index CONCURRENTLY, which PostgreSQL
  // refuses inside a transaction block: drive the real no-transaction runner
  // path (statement by statement, ledger owned by bootstrap) instead of one
  // multi-statement query.
  // Never call this inside withBypass: withBypass holds one open transaction
  // and this helper migrates on a separate raw client, so a seeding write in
  // the same block holds a table lock the migration's DDL waits on while the
  // block waits on the migration — a hang no deadlock detector can see.
  // Seed in one block, migrate bare, read in the next.
  const content = sanitizeMigrationContent(migrationSql);
  assert.equal(
    migrationRunsWithoutTransaction(content),
    true,
    "0296 declares the no-transaction runner path",
  );
  const client = await connectMigrationClient();
  try {
    await executeMigrationBody(client, content, {
      transactional: false,
      filename: MIGRATION_FILENAME,
    });
  } finally {
    await releaseMigrationClient(client);
  }
}

type IndexState = { valid: boolean; ready: boolean; definition: string };

async function snapshotIndex(): Promise<IndexState[]> {
  const found = await db.execute<IndexState>(sql`
    select i.indisvalid as valid, i.indisready as ready,
           pg_get_indexdef(i.indexrelid) as definition
      from pg_index i
      join pg_class c on c.oid = i.indexrelid
     where c.relname = 'pay_stub_lines_remittance_party'`);
  return found.rows;
}

async function snapshotFkValidated(): Promise<boolean[]> {
  const found = await db.execute<{ valid: boolean }>(sql`
    select convalidated as valid from pg_constraint
     where conname = 'pay_stub_lines_remittance_party_tenant_fkey'`);
  return found.rows.map((row) => row.valid);
}

type SeededOrg = {
  orgId: string;
  vendorId: string;
  subsidiaryId: string;
  actor: string;
  periodId: string;
};

async function seedOrg(): Promise<SeededOrg> {
  const org = await createScratchOrg();
  const actor = await createScratchUser(org.orgId, "0296 upgrade", "m0296_upgrade");
  const period = (await db.execute<{ id: string }>(sql`
    select id from accounting_periods where org_id = ${org.orgId} limit 1`)).rows[0]?.id;
  assert.ok(period, "scratch org carries an accounting period");
  return { orgId: org.orgId, vendorId: org.vendorId, subsidiaryId: org.subsidiaryId, actor, periodId: period };
}

// One committed US deduction accrual remitting to the scratch vendor,
// shaped like a pre-0296 commit (the snapshot is the component's vendor, as
// the 0296 UPDATE backfills it).
async function seedLiabilityAccount(fx: SeededOrg, number: string, name: string): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into accounts (id, org_id, number, name, type, is_summary, is_active, eliminate,
                          reconcilable, required_dimensions, custom, subsidiary_include_children)
    values (${id}, ${fx.orgId}, ${number}, ${name}, 'liability_current',
            false, true, false, false, '[]'::jsonb, '{}'::jsonb, true)`);
  return id;
}

let runSeq = 0;

async function seedAccrual(
  fx: SeededOrg,
  overrides: {
    amount?: string;
    liabilityId?: string;
    code?: string;
    name?: string;
    snapshot?: string | null;
    componentVendor?: string | null;
    country?: string;
    systemKey?: string;
    province?: string;
  } = {},
): Promise<{ lineId: string; liability: string }> {
  const amount = overrides.amount ?? "100.00";
  const liability = overrides.liabilityId ?? (await seedLiabilityAccount(fx, "2310", "Withholding payable"));
  const code = overrides.code ?? "GARN";
  // An explicit null snapshots nothing: statutory components carry their
  // destination in pack settings, not on the component or the line.
  const componentVendor = overrides.componentVendor === undefined ? fx.vendorId : overrides.componentVendor;
  const lineSnapshot = overrides.snapshot === undefined ? fx.vendorId : overrides.snapshot;
  const componentId = randomUUID();
  const scheduleId = randomUUID();
  const employeeId = randomUUID();
  const runId = randomUUID();
  const stubId = randomUUID();
  const lineId = randomUUID();
  runSeq += 1;
  const scheduleName = `0296 schedule ${runSeq}`;
  await db.execute(sql`
    insert into pay_components
      (id, org_id, code, name, kind, country, system_key, is_active, liability_account_id,
       remittance_party_id, sequence, created_by, updated_by)
    values (${componentId}, ${fx.orgId}, ${code}, ${overrides.name ?? "Garnishment"}, 'deduction',
            ${overrides.country ?? "US"}, ${overrides.systemKey ?? null}, true,
            ${liability}, ${componentVendor}, 10, ${fx.actor}, ${fx.actor})`);
  await db.execute(sql`
    insert into pay_schedules
      (id, org_id, name, frequency, periods_per_year, anchor_period_end,
       pay_date_offset_days, is_active, created_by, updated_by)
    values (${scheduleId}, ${fx.orgId}, ${scheduleName}, 'monthly', 12,
            '2026-07-31', 0, true, ${fx.actor}, ${fx.actor})`);
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, subsidiary_id,
                         is_active, custom, created_by, updated_by)
    values (${employeeId}, ${fx.orgId}, 'person', '0296 Accrual', ${fx.subsidiaryId},
            true, '{}'::jsonb, ${fx.actor}, ${fx.actor})`);
  await db.execute(sql`
    insert into documents
      (id, org_id, kind, document_number, subsidiary_id, document_date,
       posting_date, posting_period_id, currency, status, memo, created_by, updated_by)
    values (${runId}, ${fx.orgId}, 'pay_run', ${`PR-0296-${runSeq}`}, ${fx.subsidiaryId}, '2026-07-21',
            '2026-07-21', ${fx.periodId}, 'USD', 'draft', '0296 source', ${fx.actor}, ${fx.actor})`);
  await db.execute(sql`
    insert into pay_runs
      (document_id, org_id, pay_schedule_id, period_start, period_end, pay_date,
       tax_year, run_status, run_type, created_by, updated_by)
    values (${runId}, ${fx.orgId}, ${scheduleId}, '2026-07-21', '2026-07-21',
            '2026-07-21', 2026, 'committed', 'regular', ${fx.actor}, ${fx.actor})`);
  await db.execute(sql`
    insert into pay_stubs
      (id, org_id, pay_run_document_id, employee_party_id, province,
       periods_per_year, pay_date, tax_year, currency_code, gross,
       pensionable_earnings, insurable_earnings, net_pay, employer_cost,
       vacation_accrued, factors, created_by, updated_by)
    values (${stubId}, ${fx.orgId}, ${runId}, ${employeeId}, ${overrides.province ?? "ON"}, 12,
            '2026-07-21', 2026, 'USD', '100.00', '100.00', '100.00', '100.00',
            '100.00', '0', '{}'::jsonb, ${fx.actor}, ${fx.actor})`);
  await db.execute(sql`
    insert into pay_stub_lines
      (id, org_id, stub_id, component_id, kind, description, amount, sequence,
       liability_account_id, liability_account_source, remittance_party_id, created_by, updated_by)
    values (${lineId}, ${fx.orgId}, ${stubId}, ${componentId}, 'deduction', ${overrides.name ?? "Garnishment"},
            ${amount}, 10, ${liability}, 'commit', ${lineSnapshot}, ${fx.actor}, ${fx.actor})`);
  return { lineId, liability };
}

async function seedBill(
  fx: SeededOrg,
  number: string,
  marker: Record<string, unknown>,
): Promise<string> {
  const id = randomUUID();
  // Draft first: document lines are immutable once the bill leaves draft, so
  // lines are seeded before approval. 'approved', not 'posted': a posted bill
  // needs a journal entry, which the backfill never reads. Approved bills are
  // live (non-voided) and count in the overlap check, which is all the
  // backfill cares about.
  await db.execute(sql`
    insert into documents (id, org_id, kind, document_number, subsidiary_id, party_id,
                           document_date, posting_date, posting_period_id, currency,
                           status, subtotal, tax_total, total, custom, created_by, updated_by)
    values (${id}, ${fx.orgId}, 'vendor_bill', ${number}, ${fx.subsidiaryId}, ${fx.vendorId},
            '2026-07-31', '2026-07-31', ${fx.periodId}, 'USD',
            'draft', '100', '0', '100', ${JSON.stringify({ payrollRemittance: marker })}::jsonb,
            ${fx.actor}, ${fx.actor})`);
  return id;
}

async function approveBill(fx: SeededOrg, billId: string): Promise<void> {
  await db.execute(sql`
    update documents set status = 'approved'
     where org_id = ${fx.orgId} and id = ${billId}`);
}

async function seedBillLines(
  fx: SeededOrg,
  billId: string,
  lines: { account: string; amount: string; description: string }[],
): Promise<void> {
  let lineNumber = 1;
  for (const line of lines) {
    await db.execute(sql`
      insert into document_lines (org_id, document_id, line_number, account_id, description,
                                  quantity, unit_price, amount, created_by, updated_by)
      values (${fx.orgId}, ${billId}, ${lineNumber++}, ${line.account}, ${line.description},
              1, ${line.amount}, ${line.amount}, ${fx.actor}, ${fx.actor})`);
  }
}

// The migration's repair-notice predicate, mirrored for assertions: live
// in-scope bills with a party or line mismatch, with reasons. Any drift
// between this mirror and the notice block fails the naming tests below.
async function namedBills(orgId: string): Promise<{ number: string; reasons: string }[]> {
  return (await db.execute<{ number: string; reasons: string }>(sql`
    with sane_bills as (
      select b.org_id, b.id, b.subsidiary_id,
             case when (b.custom -> 'payrollRemittance' ->> 'from') ~ '^\\d{4}-\\d{2}-\\d{2}$'
                  then (b.custom -> 'payrollRemittance' ->> 'from')::date end as from_date,
             case when (b.custom -> 'payrollRemittance' ->> 'to') ~ '^\\d{4}-\\d{2}-\\d{2}$'
                  then (b.custom -> 'payrollRemittance' ->> 'to')::date end as to_date,
             case when (b.custom -> 'payrollRemittance' ->> 'partyId') ~ '^[0-9a-fA-F-]{36}$'
                  then (b.custom -> 'payrollRemittance' ->> 'partyId')::uuid end as party_id,
             ((b.custom -> 'payrollRemittance' ->> 'filingAccountId') is null
              or (b.custom -> 'payrollRemittance' ->> 'filingAccountId') ~ '^[0-9a-fA-F-]{36}$') as filing_ok,
             case when (b.custom -> 'payrollRemittance' ->> 'filingAccountId') is null
                    or (b.custom -> 'payrollRemittance' ->> 'filingAccountId') ~ '^[0-9a-fA-F-]{36}$'
                  then (b.custom -> 'payrollRemittance' ->> 'filingAccountId')::uuid end as filing_id
        from public.documents b
       where b.org_id = ${orgId} and b.kind = 'vendor_bill' and b.status <> 'voided'
         and (b.custom -> 'payrollRemittance') is not null
    ),
    scoped as (
      select s.* from sane_bills s
      join public.documents b on b.org_id = s.org_id and b.id = s.id
     where b.status <> 'voided'
       and not exists (
         select 1 from public.payroll_remittance_coverage c
          where c.org_id = s.org_id and c.bill_document_id = s.id and c.created_by is not null
       )
    ),
    scoped_lines as (
      select s.org_id, s.id as bill, l.liability_account_id as acct,
             case when l.kind = 'credit' then -l.amount else l.amount end as net
        from scoped s
        join public.pay_stub_lines l on l.org_id = s.org_id
        join public.pay_stubs st on st.id = l.stub_id and st.org_id = l.org_id
        join public.pay_runs r on r.document_id = st.pay_run_document_id and r.org_id = st.org_id
        join public.pay_components c on c.org_id = l.org_id and c.id = l.component_id
        cross join lateral (
          select settings -> 'payroll' as p from public.orgs where id = s.org_id
        ) ops
       where s.from_date is not null and s.to_date is not null and s.party_id is not null
         and s.filing_ok
         and r.run_status = 'committed'
         and l.kind in ('deduction', 'employer_contribution', 'credit')
         and st.pay_date between s.from_date and s.to_date
         and ${sql.raw(resolutionFragment(frozenPackMap))}
         and st.filing_account_id is not distinct from s.filing_id
         and exists (
           select 1 from public.documents d
            where d.id = r.document_id and d.org_id = r.org_id
              and d.subsidiary_id is not distinct from s.subsidiary_id
         )
    ),
    accrual_groups as (
      select org_id, bill, acct, sum(net) as net from scoped_lines
       group by org_id, bill, acct having sum(net) <> 0
    ),
    bill_groups as (
      select s.org_id, s.id as bill, dl.account_id as acct, sum(dl.amount) as net
        from scoped s
        join public.document_lines dl on dl.org_id = s.org_id and dl.document_id = s.id
       where dl.amount <> 0
       group by s.org_id, s.id, dl.account_id
    ),
    flagged as (
      select b.document_number as number,
             (b.party_id is distinct from s.party_id) as party_bad,
             (exists (
                select ag.acct, ag.net from accrual_groups ag where ag.org_id = s.org_id and ag.bill = s.id
                except
                select bg.acct, bg.net from bill_groups bg where bg.org_id = s.org_id and bg.bill = s.id
              ) or exists (
                select bg.acct, bg.net from bill_groups bg where bg.org_id = s.org_id and bg.bill = s.id
                except
                select ag.acct, ag.net from accrual_groups ag where ag.org_id = s.org_id and ag.bill = s.id
              )) as line_bad
        from scoped s
        join public.documents b on b.org_id = s.org_id and b.id = s.id
    )
    select number,
           concat_ws(',', case when party_bad then 'party-mismatch' end,
                        case when line_bad then 'line-mismatch' end) as reasons
      from flagged
     where party_bad or line_bad
     order by number`)).rows;
}

// The frozen 0296-era pack map, parsed from the migration under test: the
// single source of truth for both the parity test and the notice mirror, so
// neither can drift from the shipped bytes.
type FrozenPackMap = {
  defaults: [country: string, key: string, settingsKey: string][];
  regionals: [country: string, key: string, province: string, settingsKey: string][];
};

function parseFrozenPackMap(sqlText: string): FrozenPackMap {
  const ident = String.raw`[A-Za-z0-9_]+`;
  const takeBlock = (fromMarker: string, toMarker: string): string => {
    const from = sqlText.indexOf(fromMarker);
    const to = sqlText.indexOf(toMarker, from);
    // A migration revision without the frozen map (pre-U4 bytes) parses to
    // an empty map: the statutory tests then prove the old bytes cover
    // nothing, instead of the suite failing to load.
    if (!(from >= 0 && to > from)) return "";
    return sqlText.slice(from, to);
  };
  const parseTuples = (block: string, arity: 3 | 4): string[][] => {
    const pattern = arity === 3
      ? new RegExp(String.raw`\(\s*'(` + ident + String.raw`)'\s*,\s*'(` + ident + String.raw`)'\s*,\s*'(` + ident + String.raw`)'\s*\)`, "g")
      : new RegExp(String.raw`\(\s*'(` + ident + String.raw`)'\s*,\s*'(` + ident + String.raw`)'\s*,\s*'(` + ident + String.raw`)'\s*,\s*'(` + ident + String.raw`)'\s*\)`, "g");
    return [...block.matchAll(pattern)].map((m) => m.slice(1));
  };
  const defaults = parseTuples(
    takeBlock("pack_default_vendor AS (", "pack_regional_vendor AS ("),
    3,
  ).map(([country, key, settingsKey]) => [country!, key!, settingsKey!] as [string, string, string]);
  const regionals = parseTuples(
    takeBlock("pack_regional_vendor AS (", "org_payroll_settings AS ("),
    4,
  ).map(([country, key, province, settingsKey]) => [country!, key!, province!, settingsKey!] as [string, string, string, string]);
  return { defaults, regionals };
}

const frozenPackMap = parseFrozenPackMap(migrationSql);

// The migration's resolution order (regional, snapshot, default) generated
// from the frozen map, so the notice mirror cannot disagree with the shipped
// repair on which lines belong to a bill.
function resolutionFragment(map: FrozenPackMap): string {
  const settingSql = (sk: string): string =>
    `case when jsonb_typeof(ops.p -> '${sk}') = 'string' ` +
    `then nullif(ops.p ->> '${sk}', '') else null end`;
  // An empty frozen map (pre-U4 bytes under test) degrades to pure snapshot
  // matching: every WHEN is false and the inner CASEs still parse.
  const regionBranch = map.regionals.length === 0
    ? "when false then null"
    : `when ${map.regionals.map(([c, k, prov]) => `(c.country = '${c}' and c.system_key = '${k}' and st.province = '${prov}')`).join(" or ")} then\n` +
      `                case ${map.regionals.map(([c, k, prov, sk]) => `when c.country = '${c}' and c.system_key = '${k}' and st.province = '${prov}' then ${settingSql(sk)}`).join("\n              ")} else null end`;
  const defaultBranch = map.defaults.length === 0
    ? "when false then null"
    : `when ${map.defaults.map(([c, k]) => `(c.country = '${c}' and c.system_key = '${k}')`).join(" or ")} then\n` +
      `                case ${map.defaults.map(([c, k, sk]) => `when c.country = '${c}' and c.system_key = '${k}' then ${settingSql(sk)}`).join("\n              ")} else null end`;
  // Text on both sides: settings values are text, so the snapshot casts to
  // text too — exactly the string comparison the TypeScript resolver does.
  return `(case
              ${regionBranch}
              when l.remittance_party_id is not null then l.remittance_party_id::text
              ${defaultBranch}
              else null end) is not distinct from s.party_id::text`;
}

function validMarker(fx: SeededOrg): Record<string, unknown> {
  return {
    partyId: fx.vendorId,
    from: "2026-07-01",
    to: "2026-07-31",
    filingAccountId: null,
    subsidiaryId: fx.subsidiaryId,
  };
}

// Drizzle reports the failed SQL in .message and the PostgreSQL refusal in
// .cause: match against the refusal, never the query text.
function refusalMessage(error: unknown): string {
  const cause = (error as { cause?: Error } | null)?.cause;
  return cause?.message ?? (error as Error)?.message ?? String(error);
}

async function coverageRows(orgId: string): Promise<{ bill: string; line: string; amount: string }[]> {
  return (await db.execute<{ bill: string; line: string; amount: string }>(sql`
    select bill_document_id::text as bill, stub_line_id::text as line, amount::text as amount
      from payroll_remittance_coverage
     where org_id = ${orgId}
     order by bill, line`)).rows;
}

test(
  "0296 refuses the upgrade by name for malformed legacy markers",
  { skip: !DB },
  async () => {
    const fx = await withBypass(() => seedOrg());
    try {
      await withBypass(async () => {
        await seedAccrual(fx);
        await approveBill(fx, await seedBill(fx, "VB-U1-DATE", { ...validMarker(fx), from: "2026-02-30" }));
        await approveBill(
          fx,
          await seedBill(fx, "VB-U1-UUID", {
            ...validMarker(fx),
            partyId: "------------------------------------",
          }),
        );
        const missingParty = validMarker(fx);
        delete missingParty.partyId;
        await approveBill(fx, await seedBill(fx, "VB-U1-NOPARTY", missingParty));
      });
      // The refusing upgrade runs bare on its own client, never inside the
      // seeding transaction above: the seeds are committed, so the precheck
      // sees them, and no open transaction holds a lock the upgrade waits on.
      await runMigration().then(
        () => assert.fail("malformed markers must refuse the upgrade"),
        (error: unknown) => {
          const message = refusalMessage(error);
          // The refusal names every bill and field — not a bare cast error.
          assert.match(message, /VB-U1-DATE/);
          assert.match(message, /from/);
          assert.match(message, /impossible calendar date/);
          assert.match(message, /VB-U1-UUID/);
          assert.match(message, /partyId/);
          assert.match(message, /unparseable reference/);
          assert.match(message, /VB-U1-NOPARTY/);
          assert.match(message, /missing/);
          assert.match(message, /re-apply/);
        },
      );
      await withBypass(async () => {
        assert.deepEqual(await coverageRows(fx.orgId), [], "refused upgrade covers nothing");
      });
    } finally {
      await withBypass(() => dropScratchOrg(fx.orgId));
    }
  },
);

test(
  "0296 covers a well-formed legacy bill, idempotently",
  { skip: !DB },
  async () => {
    const fx = await withBypass(() => seedOrg());
    try {
      const { billId, lineId } = await withBypass(async () => {
        const { lineId, liability } = await seedAccrual(fx);
        const billId = await seedBill(fx, "VB-U1-OK", validMarker(fx));
        await seedBillLines(fx, billId, [{ account: liability, amount: "100", description: "Garnishment" }]);
        await approveBill(fx, billId);
        return { billId, lineId };
      });
      await runMigration();
      assert.deepEqual(await withBypass(() => coverageRows(fx.orgId)), [
        { bill: billId, line: lineId, amount: "100.0000" },
      ]);
      // Re-running changes nothing: the anti-join skips covered lines.
      await runMigration();
      assert.deepEqual(await withBypass(() => coverageRows(fx.orgId)), [
        { bill: billId, line: lineId, amount: "100.0000" },
      ]);
    } finally {
      await withBypass(() => dropScratchOrg(fx.orgId));
    }
  },
);

test(
  "0296 refuses a non-string marker value by name",
  { skip: !DB },
  async () => {
    const fx = await withBypass(() => seedOrg());
    try {
      await withBypass(async () => {
        await seedAccrual(fx);
        // A JSON number is not a date: ->> yields text that fails the shape
        // filter. The marker claims the structured shape but is unusable, so
        // the upgrade refuses by name instead of leaving silent debt.
        await approveBill(fx, await seedBill(fx, "VB-U1-NONSTRING", { ...validMarker(fx), from: 20260701 }));
      });
      await runMigration().then(
        () => assert.fail("a non-string marker value must refuse the upgrade"),
        (error: unknown) => {
          const message = refusalMessage(error);
          assert.match(message, /VB-U1-NONSTRING/);
          assert.match(message, /from/);
          assert.match(message, /malformed date/);
        },
      );
      await withBypass(async () => {
        assert.deepEqual(await coverageRows(fx.orgId), [], "refused upgrade covers nothing");
      });
    } finally {
      await withBypass(() => dropScratchOrg(fx.orgId));
    }
  },
);

test(
  "0296 skips markers that never claimed the structured shape",
  { skip: !DB },
  async () => {
    const fx = await withBypass(() => seedOrg());
    try {
      await withBypass(async () => {
        await seedAccrual(fx);
        // A scalar marker and an object naming none of the four fields
        // predate structured bills: the backfill skips them as before and
        // they keep the fail-closed overlap refusal.
        await approveBill(fx, await seedBill(fx, "VB-U1-SCALAR", "legacy" as unknown as Record<string, unknown>));
        await approveBill(fx, await seedBill(fx, "VB-U1-EMPTY", { note: "pre-structured" }));
      });
      await runMigration();
      assert.deepEqual(await withBypass(() => coverageRows(fx.orgId)), []);
    } finally {
      await withBypass(() => dropScratchOrg(fx.orgId));
    }
  },
);

test(
  "0296 leaves a same-total wrong-account bill uncovered and names it",
  { skip: !DB },
  async () => {
    const fx = await withBypass(() => seedOrg());
    try {
      const billId = await withBypass(async () => {
        // $100 accrued to A, but the bill debits $100 of B: same total, so
        // the old grand-total match covered the A line while A stayed
        // payable in the GL.
        const { liability } = await seedAccrual(fx);
        const other = await seedLiabilityAccount(fx, "2320", "Other payable");
        assert.notEqual(other, liability);
        const id = await seedBill(fx, "VB-U2-WRONGACCT", validMarker(fx));
        await seedBillLines(fx, id, [{ account: other, amount: "100", description: "Garnishment" }]);
        await approveBill(fx, id);
        return id;
      });
      await runMigration();
      const { rows, named } = await withBypass(async () => ({
        rows: await coverageRows(fx.orgId),
        named: await namedBills(fx.orgId),
      }));
      assert.deepEqual(rows, [], "a wrong-account bill gains no coverage");
      assert.deepEqual(named, [{ number: "VB-U2-WRONGACCT", reasons: "line-mismatch" }]);
      assert.ok(billId);
    } finally {
      await withBypass(() => dropScratchOrg(fx.orgId));
    }
  },
);

test(
  "0296 empties a party-mismatched bill and names it",
  { skip: !DB },
  async () => {
    const fx = await withBypass(() => seedOrg());
    try {
      await withBypass(async () => {
        // The marker names the scratch vendor but the bill was re-pointed at
        // another vendor: simulate the rows the old grand-total backfill
        // wrote, then prove the repair removes them and names the bill.
        const { lineId, liability } = await seedAccrual(fx);
        const otherVendor = randomUUID();
        await db.execute(sql`
          insert into parties (id, org_id, kind, display_name, subsidiary_id,
                               is_active, custom, created_by, updated_by)
          values (${otherVendor}, ${fx.orgId}, 'company', 'Other vendor', ${fx.subsidiaryId},
                  true, '{}'::jsonb, ${fx.actor}, ${fx.actor})`);
        const billId = await seedBill(fx, "VB-U2-PARTY", validMarker(fx));
        await seedBillLines(fx, billId, [{ account: liability, amount: "100", description: "Garnishment" }]);
        await db.execute(sql`
          update documents set party_id = ${otherVendor}
           where org_id = ${fx.orgId} and id = ${billId}`);
        await approveBill(fx, billId);
        await db.execute(sql`
          insert into payroll_remittance_coverage (org_id, bill_document_id, stub_line_id, amount)
          values (${fx.orgId}, ${billId}, ${lineId}, '100.00')`);
      });
      await runMigration();
      const { rows, named } = await withBypass(async () => ({
        rows: await coverageRows(fx.orgId),
        named: await namedBills(fx.orgId),
      }));
      assert.deepEqual(rows, [], "a party-mismatched bill keeps no backfill rows");
      assert.deepEqual(named, [{ number: "VB-U2-PARTY", reasons: "party-mismatch" }]);
    } finally {
      await withBypass(() => dropScratchOrg(fx.orgId));
    }
  },
);

test(
  "0296 covers a bill whose lines reconcile across two liability accounts",
  { skip: !DB },
  async () => {
    const fx = await withBypass(() => seedOrg());
    try {
      const { billId, lineA, lineB } = await withBypass(async () => {
        // $60 to A plus $40 to B, billed as two labelled lines: the account
        // split is legitimate, so both lines gain coverage and no notice names it.
        const first = await seedAccrual(fx, { amount: "60.00", code: "GARN-A", name: "Garnishment A" });
        const second = await seedAccrual(fx, {
          amount: "40.00",
          code: "GARN-B",
          name: "Garnishment B",
          liabilityId: await seedLiabilityAccount(fx, "2320", "Other payable"),
        });
        const id = await seedBill(fx, "VB-U2-TWOACCT", validMarker(fx));
        await seedBillLines(fx, id, [
          { account: first.liability, amount: "60", description: "Garnishment A" },
          { account: second.liability, amount: "40", description: "Garnishment B" },
        ]);
        // The seed bills total a fixed 100; the two lines sum to it.
        await db.execute(sql`
          update documents set total = '100', subtotal = '100'
           where org_id = ${fx.orgId} and id = ${id}`);
        await approveBill(fx, id);
        return { billId: id, lineA: first.lineId, lineB: second.lineId };
      });
      await runMigration();
      const { rows, named } = await withBypass(async () => ({
        rows: await coverageRows(fx.orgId),
        named: await namedBills(fx.orgId),
      }));
      // Line uuids sort arbitrarily: compare as a set keyed by amount.
      assert.deepEqual(
        [...rows].sort((a, b) => (a.amount < b.amount ? -1 : 1)),
        [
          { bill: billId, line: lineB, amount: "40.0000" },
          { bill: billId, line: lineA, amount: "60.0000" },
        ],
      );
      assert.deepEqual(named, []);
    } finally {
      await withBypass(() => dropScratchOrg(fx.orgId));
    }
  },
);

test("0296 frozen pack map matches the live declarations", async () => {
  // Pure source-text + declaration comparison: no database needed, so this
  // runs in every partition. It pins the repair's frozen map against the
  // TypeScript resolver both ways over the 0296-era key set: a pack edit to
  // an old key fails here and forces a conscious repair decision instead of
  // silently diverging SQL from TS. Post-0296 keys are invisible by design —
  // no pre-0296 line can carry a key its pack had not declared yet.
  assert.ok(
    frozenPackMap.defaults.length > 0 && frozenPackMap.regionals.length > 0,
    "the migration carries a non-empty frozen pack map",
  );
  const frozenKeys = new Set([
    ...frozenPackMap.defaults.map(([c, k]) => `${c}.${k}`),
    ...frozenPackMap.regionals.map(([c, k]) => `${c}.${k}`),
  ]);
  for (const [country, key, settingsKey] of frozenPackMap.defaults) {
    const live = statutoryRemittanceDeclaration(country).vendorSettingsKeyBySystemKey.get(key);
    assert.equal(live, settingsKey, `${country}.${key} vendor key changed since 0296`);
  }
  for (const [country, key, province, settingsKey] of frozenPackMap.regionals) {
    const live = statutoryRemittanceDeclaration(country).regionalVendorSettingsKeyBySystemKey.get(key)?.[province];
    assert.equal(live, settingsKey, `${country}.${key}.${province} regional key changed since 0296`);
  }
  for (const country of Object.keys(PAYROLL_COUNTRY_PACKS)) {
    const declaration = statutoryRemittanceDeclaration(country);
    for (const [key, provinces] of declaration.regionalVendorSettingsKeyBySystemKey) {
      if (!frozenKeys.has(`${country}.${key}`)) continue;
      const liveEntries = Object.entries(provinces ?? {}).sort();
      const frozenEntries = frozenPackMap.regionals
        .filter(([c, k]) => c === country && k === key)
        .map(([, , prov, sk]) => [prov, sk])
        .sort();
      assert.deepEqual(liveEntries, frozenEntries, `${country}.${key} gained a regional route since 0296`);
    }
  }
});

test(
  "0296 frees backfill rows when their bill is voided",
  { skip: !DB },
  async () => {
    const fx = await withBypass(() => seedOrg());
    try {
      const billId = await withBypass(async () => {
        const { liability } = await seedAccrual(fx);
        const id = await seedBill(fx, "VB-U2-VOID", validMarker(fx));
        await seedBillLines(fx, id, [{ account: liability, amount: "100", description: "Garnishment" }]);
        await approveBill(fx, id);
        return id;
      });
      await runMigration();
      assert.equal((await withBypass(() => coverageRows(fx.orgId))).length, 1);
      await withBypass(async () => {
        await db.execute(sql`
          update documents
             set status = 'voided', voided_at = now(), voided_by = ${fx.actor},
                 void_reason = 'voided for the 0296 repair test'
           where org_id = ${fx.orgId} and id = ${billId}`);
      });
      await runMigration();
      assert.deepEqual(await withBypass(() => coverageRows(fx.orgId)), []);
      assert.ok(billId);
    } finally {
      await withBypass(() => dropScratchOrg(fx.orgId));
    }
  },
);

async function setPayrollSetting(fx: SeededOrg, key: string, value: string): Promise<void> {
  // jsonb_set cannot create a missing parent path, so the payroll object is
  // ensured first: scratch orgs carry features/control accounts but no
  // payroll settings until a pack is configured.
  await db.execute(sql`
    update orgs
       set settings = jsonb_set(
         jsonb_set(
           coalesce(settings, '{}'::jsonb),
           string_to_array('payroll', ','),
           coalesce(settings -> 'payroll', '{}'::jsonb),
           true
         ),
         string_to_array(${`payroll,${key}`}, ','),
         to_jsonb(${value}::text),
         true
       )
     where id = ${fx.orgId}`);
}

test(
  "0296 covers a legacy statutory CRA bill through pack settings",
  { skip: !DB },
  async () => {
    const fx = await withBypass(() => seedOrg());
    try {
      const { billId, lineId } = await withBypass(async () => {
        // A normal pre-0296 CRA bill: the income-tax component names no
        // vendor (the destination lives in pack settings), so the line
        // snapshot is NULL and snapshot-only matching covers nothing.
        await setPayrollSetting(fx, "craRemittancePartyId", fx.vendorId);
        const { lineId, liability } = await seedAccrual(fx, {
          country: "CA",
          systemKey: "income_tax",
          code: "ITAX",
          name: "Income tax",
          componentVendor: null,
          snapshot: null,
        });
        const id = await seedBill(fx, "VB-U4-CRA", validMarker(fx));
        await seedBillLines(fx, id, [{ account: liability, amount: "100", description: "Income tax" }]);
        await approveBill(fx, id);
        return { billId: id, lineId };
      });
      await runMigration();
      const { rows, named } = await withBypass(async () => ({
        rows: await coverageRows(fx.orgId),
        named: await namedBills(fx.orgId),
      }));
      assert.deepEqual(rows, [{ bill: billId, line: lineId, amount: "100.0000" }]);
      assert.deepEqual(named, []);
    } finally {
      await withBypass(() => dropScratchOrg(fx.orgId));
    }
  },
);

test(
  "0296 covers a legacy regional QPP bill through the RQ key",
  { skip: !DB },
  async () => {
    const fx = await withBypass(() => seedOrg());
    try {
      const { billId, lineId } = await withBypass(async () => {
        // QPP for a Quebec stub routes to the RQ vendor before the snapshot:
        // the snapshot stays NULL and only pack-aware matching covers it.
        await setPayrollSetting(fx, "rqRemittancePartyId", fx.vendorId);
        const { lineId, liability } = await seedAccrual(fx, {
          country: "CA",
          systemKey: "cpp",
          code: "QPP",
          name: "Quebec Pension Plan",
          componentVendor: null,
          snapshot: null,
          province: "QC",
        });
        const id = await seedBill(fx, "VB-U4-RQ", validMarker(fx));
        await seedBillLines(fx, id, [{ account: liability, amount: "100", description: "QPP" }]);
        await approveBill(fx, id);
        return { billId: id, lineId };
      });
      await runMigration();
      const { rows, named } = await withBypass(async () => ({
        rows: await coverageRows(fx.orgId),
        named: await namedBills(fx.orgId),
      }));
      assert.deepEqual(rows, [{ bill: billId, line: lineId, amount: "100.0000" }]);
      assert.deepEqual(named, []);
    } finally {
      await withBypass(() => dropScratchOrg(fx.orgId));
    }
  },
);

test(
  "0296 replays clean: a second no-transaction run changes nothing",
  { skip: !DB },
  async () => {
    const fx = await withBypass(() => seedOrg());
    try {
      const { billId, lineId } = await withBypass(async () => {
        const { lineId, liability } = await seedAccrual(fx);
        const id = await seedBill(fx, "VB-U5-REPLAY", validMarker(fx));
        await seedBillLines(fx, id, [{ account: liability, amount: "100", description: "Garnishment" }]);
        await approveBill(fx, id);
        return { billId: id, lineId };
      });
      await runMigration();
      // The runner's retry replays the whole file after a mid-file failure,
      // which leaves earlier statements committed — so the replay must be a
      // clean no-op, not a duplicate.
      await runMigration();
      const index = await withBypass(() => snapshotIndex());
      assert.equal(index.length, 1, "exactly one snapshot index survives the replay");
      assert.equal(index[0].valid, true, "the snapshot index is valid");
      assert.equal(index[0].ready, true, "the snapshot index is ready");
      assert.ok(
        index[0].definition.includes("(org_id, remittance_party_id)"),
        "the replay did not swap the index definition",
      );
      assert.deepEqual(await withBypass(() => snapshotFkValidated()), [true]);
      assert.deepEqual(await withBypass(() => coverageRows(fx.orgId)), [
        { bill: billId, line: lineId, amount: "100.0000" },
      ]);
      assert.ok(billId);
    } finally {
      await withBypass(() => dropScratchOrg(fx.orgId));
    }
  },
);

test(
  "0296 heals a failed CONCURRENTLY build instead of skipping it forever",
  { skip: !DB },
  async () => {
    const fx = await withBypass(() => seedOrg());
    try {
      await withBypass(() => seedAccrual(fx));
      await runMigration();
      const live = await withBypass(() => snapshotIndex());
      assert.equal(live.length, 1);
      assert.equal(live[0].valid, true);
      // Plant a failed build under the real name: the poisoned expression
      // (uuid text never parses as int) fails on the seeded snapshot row and
      // leaves the name present but INVALID — the shape a killed or
      // timed-out CONCURRENTLY build leaves behind. This DDL runs on a raw
      // migration client, never inside withBypass: withBypass holds one
      // atomic transaction and CONCURRENTLY refuses inside a transaction
      // block.
      const plant = await connectMigrationClient();
      try {
        await plant.query("drop index if exists pay_stub_lines_remittance_party");
        const failed = await plant
          .query(
            "CREATE INDEX CONCURRENTLY pay_stub_lines_remittance_party ON public.pay_stub_lines (((remittance_party_id::text::int)))",
          )
          .then(
            () => null,
            (error: unknown) => error,
          );
        assert.ok(failed, "the poisoned build must fail");
      } finally {
        await releaseMigrationClient(plant);
      }
      const planted = await withBypass(() => snapshotIndex());
      assert.equal(planted.length, 1);
      assert.equal(planted[0].valid, false, "the plant leaves an INVALID index");
      // IF NOT EXISTS alone would skip the INVALID name forever, silently
      // keeping the missing index: show that hazard before the heal.
      const skip = await connectMigrationClient();
      try {
        await skip.query(
          "CREATE INDEX CONCURRENTLY IF NOT EXISTS pay_stub_lines_remittance_party ON public.pay_stub_lines (org_id, remittance_party_id)",
        );
      } finally {
        await releaseMigrationClient(skip);
      }
      const skipped = await withBypass(() => snapshotIndex());
      assert.equal(skipped[0].valid, false, "IF NOT EXISTS skips the INVALID name");
      // The file's drop-up-front guard removes it and the rebuild heals.
      await runMigration();
      const healed = await withBypass(() => snapshotIndex());
      assert.equal(healed.length, 1);
      assert.equal(healed[0].valid, true);
      assert.equal(healed[0].ready, true);
      assert.ok(healed[0].definition.includes("(org_id, remittance_party_id)"));
    } finally {
      await withBypass(() => dropScratchOrg(fx.orgId));
    }
  },
);

test(
  "0296 timing rehearsal: the no-transaction file completes over volume",
  { skip: !DB },
  async () => {
    const fx = await withBypass(() => seedOrg());
    try {
      const liabilityId = await withBypass(() => seedLiabilityAccount(fx, "2310", "Withholding payable"));
      await withBypass(async () => {
        for (let i = 0; i < 50; i += 1) {
          await seedAccrual(fx, { code: `VOL${i}`, amount: "10.00", liabilityId });
        }
      });
      const started = Date.now();
      await runMigration();
      const elapsedMs = Date.now() - started;
      const index = await withBypass(() => snapshotIndex());
      assert.equal(index.length, 1);
      assert.equal(index[0].valid, true, "the rehearsal leaves a valid index");
      assert.equal(index[0].ready, true, "the rehearsal leaves a ready index");
      assert.deepEqual(await withBypass(() => snapshotFkValidated()), [true]);
      assert.ok(
        Number.isFinite(elapsedMs),
        `the rehearsal completes and reports its wall time (${elapsedMs}ms over 50 lines)`,
      );
    } finally {
      await withBypass(() => dropScratchOrg(fx.orgId));
    }
  },
);
