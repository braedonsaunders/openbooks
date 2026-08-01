/**
 * End-to-end engine verification of multi-subsidiary posting:
 *  1. seeds a second subsidiary + elimination subsidiary + due-to/due-from
 *     accounts + intercompany pair in an explicitly selected sandbox
 *     (idempotent),
 *  2. posts an intercompany journal document through postDocument,
 *  3. asserts each legal entity's lines balance independently and the
 *     due-to/due-from legs were injected,
 *  4. runs auto-elimination and asserts the elimination entry nets the
 *     flagged accounts to zero at consolidated level.
 * Run: npx tsx scripts/verify-subsidiaries.ts <sandbox-or-preview-org-id>
 */
import { sql } from "drizzle-orm";
import { db, withOrg, pool } from "../engine/src/db.ts";
import { postDocument } from "../engine/src/posting.ts";
import { deriveConsolidatedRates, runAutoElimination } from "../engine/src/consolidation.ts";

const q = async (s: ReturnType<typeof sql>) => ((await db.execute(s)) as any).rows;

const targetOrgId = process.argv[2];
if (!targetOrgId || !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(targetOrgId)) {
  throw new Error("Pass the UUID of a disposable sandbox or preview org; production tenants are never valid verification targets");
}
const [org] = await (async () =>
  q(sql`
    select id, name, base_currency as ccy
      from orgs
     where id = ${targetOrgId}
       and env_kind in ('sandbox', 'preview')
     limit 1`))();
if (!org) {
  throw new Error(`Verification target ${targetOrgId} is missing or is a production tenant`);
}
console.log(`org: ${org.name} (${org.id})`);
const actorId = (await q(sql`
  select id
    from users
   where org_id = ${org.id} and is_active
   order by is_super_admin desc, created_at
   limit 1`))[0]?.id as string | undefined;
if (!actorId) throw new Error("sandbox has no active user to attribute verification postings");

const entryId = await withOrg(org.id, async () => {
  const root = (await q(sql`select id, name from subsidiaries where parent_id is null`))[0];
  console.log(`root subsidiary: ${root.name}`);

  // -- 1. seed second + elimination subsidiaries (idempotent) ---------------
  await q(sql`
    insert into currencies (code, name, minor_units) values ('USD', 'US Dollar', 2)
    on conflict (code) do nothing`);
  const ensureSub = async (name: string, isElim: boolean, currency: string) => {
    const found = await q(sql`select id from subsidiaries where name = ${name}`);
    if (found[0]) {
      await q(sql`
        update subsidiaries set base_currency = ${currency}, is_elimination = ${isElim}, is_active = true
         where id = ${found[0].id}`);
      return found[0].id;
    }
    return (
      await q(sql`
        insert into subsidiaries (org_id, parent_id, name, base_currency, country, is_elimination)
        values (${org.id}, ${root.id}, ${name}, ${currency}, 'CA', ${isElim}) returning id`)
    )[0].id;
  };
  const east = await ensureSub("Verify East Inc", false, "USD");
  await ensureSub("Verify Elimination", true, org.ccy);

  await q(sql`
    insert into accounting_books (org_id, code, name, is_primary)
    values (${org.id}, 'primary', 'Primary Book', true)
    on conflict (org_id, code) do update set is_primary = true, is_active = true`);
  const calendar = (await q(sql`
    select id from fiscal_calendars where org_id = ${org.id} and is_default and is_active limit 1`))[0];
  if (!calendar) throw new Error("sandbox has no active default fiscal calendar");
  await q(sql`
    insert into accounting_periods
      (org_id, fiscal_calendar_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment)
    values (${org.id}, ${calendar.id}, 2026, 7, '2026-07', '2026-07-01', '2026-07-31', false)
    on conflict (org_id, fiscal_calendar_id, fiscal_year, period_number) do update
      set starts_on = excluded.starts_on, ends_on = excluded.ends_on, is_adjustment = false`);
  await q(sql`
    insert into fx_rates (org_id, from_currency, to_currency, as_of, rate_type, rate, source)
    values (${org.id}, ${org.ccy}, 'USD', '2026-07-15', 'spot', 0.75, 'verification'),
           (${org.id}, 'USD', ${org.ccy}, '2026-07-15', 'spot', 1.3333333333, 'verification')
    on conflict (org_id, from_currency, to_currency, as_of, rate_type) do update
      set rate = excluded.rate, source = excluded.source`);

  const ensureAccount = async (number: string, name: string, type: string, eliminate: boolean) => {
    const found = await q(sql`select id from accounts where number = ${number}`);
    if (found[0]) return found[0].id;
    return (
      await q(sql`
        insert into accounts (org_id, number, name, type, eliminate)
        values (${org.id}, ${number}, ${name}, ${type}, ${eliminate}) returning id`)
    )[0].id;
  };
  const dueFrom = await ensureAccount("19999", "Verify IC Due From East", "asset_other", true);
  const dueTo = await ensureAccount("29999", "Verify IC Due To Root", "liability_current_other", true);
  const pairFound = await q(sql`
    select id from intercompany_pairs
     where (from_subsidiary_id = ${root.id} and to_subsidiary_id = ${east})
        or (from_subsidiary_id = ${east} and to_subsidiary_id = ${root.id})`);
  if (!pairFound[0]) {
    await q(sql`
      insert into intercompany_pairs (org_id, from_subsidiary_id, to_subsidiary_id, due_from_account_id, due_to_account_id)
      values (${org.id}, ${root.id}, ${east}, ${dueFrom}, ${dueTo}) returning id`);
  }

  // Two ordinary accounts for the journal legs.
  const cash = await ensureAccount("10000", "Verify Cash", "asset_bank", false);
  const expense = await ensureAccount("60000", "Verify Expense", "expense", false);

  // -- 2. a cross-currency journal: root pays CAD 1,250 of East's expense ---
  const stamp = `VERIFY-IC-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  const doc = (
    await q(sql`
      insert into documents (org_id, kind, document_number, document_date, currency, subsidiary_id, status, memo)
      values (${org.id}, 'journal', ${stamp}, '2026-07-15', ${org.ccy}, ${root.id}, 'draft', 'subsidiary verification')
      returning id`)
  )[0].id;
  await q(sql`
    insert into document_lines (org_id, document_id, line_number, account_id, amount, subsidiary_id, description)
    values (${org.id}, ${doc}, 1, ${expense}, 1250.00, ${east}, 'East expense paid by root'),
           (${org.id}, ${doc}, 2, ${cash}, -1250.00, ${root.id}, 'Root bank outflow')
    returning id`);

  const entryId = await postDocument(doc, { control: { ar: cash, ap: cash, bank: cash } });
  console.log(`posted intercompany journal → entry ${entryId}`);
  return entryId;
});

// Fresh org scope: withOrg pins one tx, whose snapshot may predate the
// posting transaction's commit — assertions get their own scope.
const periodId = await withOrg(org.id, async () => {
  // -- 3. assertions ---------------------------------------------------------
  const lines = await q(sql`
    select s.name as sub, a.number, a.name as account, l.amount::text,
           l.currency, l.txn_amount::text as "txnAmount", l.fx_rate::text as "fxRate"
      from journal_lines l join subsidiaries s on s.id = l.subsidiary_id
      join accounts a on a.id = l.account_id
     where l.entry_id = ${entryId} order by l.line_number`);
  console.table(lines);
  const perSub = await q(sql`
    select s.name, sum(l.amount)::text as total from journal_lines l
      join subsidiaries s on s.id = l.subsidiary_id
     where l.entry_id = ${entryId} group by s.name`);
  console.table(perSub);
  for (const r of perSub) {
    if (Number(r.total) !== 0) throw new Error(`SUBSIDIARY NOT BALANCED: ${r.name} ${r.total}`);
  }
  if (lines.length !== 4) throw new Error(`expected 4 lines (2 + 2 IC legs), got ${lines.length}`);
  const eastLines = lines.filter((line: any) => line.sub === "Verify East Inc");
  if (eastLines.some((line: any) => line.currency !== org.ccy || Number(line.fxRate) !== 0.75)) {
    throw new Error("East lines did not retain CAD transaction currency with the CAD→USD functional rate");
  }
  console.log("✓ per-subsidiary balance holds; cross-currency due-to/due-from legs retain FX detail");

  // -- 4. auto-elimination ---------------------------------------------------
  const period = (await q(sql`
    select id, name from accounting_periods where starts_on <= '2026-07-15' and ends_on >= '2026-07-15' and is_adjustment = false`))[0];
  if (!period) throw new Error("verification period is missing");
  return period.id as string;
});

await withOrg(org.id, async () => {
  const rates = await deriveConsolidatedRates(org.id, periodId);
  if (rates < 1) throw new Error("expected at least one consolidated currency pair");
});
const first = await withOrg(org.id, () => runAutoElimination(org.id, periodId, actorId));
console.log(`elimination entry ${first.entryId} with ${first.lineCount} lines`);
await withOrg(org.id, async () => {
  const consolidated = await q(sql`
    select a.number,
           sum(round(l.amount * case
             when s.base_currency = ${org.ccy} then 1
             else cf.current_rate
           end, 4))::text as net
      from journal_lines l join accounts a on a.id = l.account_id
      join journal_entries e on e.id = l.entry_id
      join subsidiaries s on s.id = l.subsidiary_id
      left join consolidated_fx_rates cf
        on cf.org_id = e.org_id and cf.period_id = e.period_id
       and cf.from_currency = s.base_currency and cf.to_currency = ${org.ccy}
     where a.eliminate and e.period_id = ${periodId} and e.status = 'posted'
     group by a.number`);
  console.table(consolidated);
  if (consolidated.length === 0) throw new Error("elimination proof returned no intercompany accounts");
  for (const r of consolidated) {
    if (Number(r.net) !== 0) throw new Error(`ELIMINATION FAILED: account ${r.number} nets ${r.net}`);
  }
  console.log("✓ translated intercompany accounts net to zero after elimination");
});

const second = await withOrg(org.id, () => runAutoElimination(org.id, periodId, actorId));
if (!first.entryId || !second.entryId || first.entryId === second.entryId) {
  throw new Error("elimination rerun did not create an immutable reversal and replacement");
}
await withOrg(org.id, async () => {
  const chain = (await q(sql`
    select original.status,
           count(reversal.id)::int as reversals
      from journal_entries original
      left join journal_entries reversal
        on reversal.reverses_entry_id = original.id and reversal.status = 'posted'
     where original.id = ${first.entryId}
     group by original.status`))[0];
  if (chain?.status !== "posted" || chain?.reversals !== 1) {
    throw new Error("elimination rerun mutated the original or failed to create its posted reversal");
  }
  const mismatch = (await q(sql`
    with original as (
      select account_id, sum(amount) amount from journal_lines
       where entry_id = ${first.entryId} group by account_id
    ), reversal as (
      select l.account_id, sum(l.amount) amount
        from journal_lines l join journal_entries e on e.id = l.entry_id
       where e.reverses_entry_id = ${first.entryId} group by l.account_id
    ), replacement as (
      select account_id, sum(amount) amount from journal_lines
       where entry_id = ${second.entryId} group by account_id
    )
    select count(*)::int as count
      from original o
      full join reversal r using (account_id)
      full join replacement n using (account_id)
     where coalesce(o.amount, 0) + coalesce(r.amount, 0) <> 0
        or coalesce(o.amount, 0) <> coalesce(n.amount, 0)`))[0];
  if (mismatch?.count !== 0) throw new Error("elimination reversal/replacement amounts do not match the original");
  console.log("✓ rerun preserves the original and appends a reversal plus replacement");
});

await pool.end();
console.log("ALL ENGINE CHECKS PASSED");
