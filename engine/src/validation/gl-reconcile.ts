/**
 * Reconcile an org's ledger against the source system it migrated from.
 *
 * Plausibility is not a test. A margin can look wrong because the business had
 * a bad year, and look right while half the revenue is missing — the only
 * question worth asking is whether OpenBooks agrees with the system of record.
 *
 * Reports revenue, cost and the invoice population side by side, and separates
 * the pre-cutover history (carried over as year-end summary journals, with no
 * project detail by design) from the transaction-level detail after it. Mixing
 * those two eras is what makes a healthy tenant look catastrophic.
 *
 * Usage: npx tsx --conditions=react-server src/validation/gl-reconcile.ts [--org=UUID] [--since=YYYY-MM-DD]
 *
 * --since may fall anywhere in a period: both sides filter on the actual
 * transaction date (source t.trandate against OpenBooks posting/document
 * dates), so a mid-period date covers the same population on both sides and
 * period-level P&L parity stays meaningful without snapping or refusing dates.
 *
 * Rate policy: none. Invoices are compared per transaction currency and P&L
 * per entity functional currency, each bucket with its own verdict; no
 * combined cross-currency figure is produced and no FX translation is
 * applied. A currency that cannot be resolved to ISO refuses the run by
 * name instead of joining a bucket it does not belong to.
 */
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { sourceClient } from "../sync/source-client.ts";
import {
  alignMoneyBuckets,
  parseSince,
  SOURCE_CURRENCY_SYMBOL_QUERY,
  SOURCE_SUBSIDIARY_QUERY,
  sourceInvoiceQuery,
  sourceIsoCurrency,
  sourcePlQuery,
} from "./gl-reconcile-queries.ts";

const ORG = process.argv.find((a) => a.startsWith("--org="))?.split("=")[1]
  ?? process.env.RECONCILE_ORG ?? (process.env.PROD_ORG ?? (() => { throw new Error("PROD_ORG is required"); })());
const SINCE = parseSince(process.argv.find((a) => a.startsWith("--since="))?.split("=")[1]);

/** P&L role, read from the account's type — a chart may say cogs or expense. */
const COST = ["cogs", "expense", "expense_other"];
const REVENUE = ["income", "revenue", "income_other"];

/** Aggregate P&L shape shared by the ledger and job-detail scans, one row per functional currency. */
interface LedgerTotals extends Record<string, unknown> {
  currency: string | null;
  subsidiary: string | null;
  revenue: string;
  cost: string;
}

/** Document-population probe shape (count plus exact total), one row per currency. */
interface InvoiceTotals extends Record<string, unknown> {
  currency: string;
  n: number;
  total: string;
}

/** Job-detail scan: ledger totals plus overhead and project count. */
interface JobTotals extends LedgerTotals {
  overhead: string;
  projects: number;
}

async function retry<T>(fn: () => Promise<T>, n = 8): Promise<T> {
  let last: unknown;
  for (let i = 0; i < n; i++) {
    try { return await fn(); } catch (e) {
      last = e;
      const chain: string[] = [];
      for (let c: unknown = e; c; c = (c as { cause?: unknown })?.cause) {
        chain.push(String((c as { message?: unknown })?.message ?? ""));
      }
      if (!/timeout|terminated|ECONN|ETIMEDOUT|EHOSTUNREACH|Connection/i.test(chain.join(" "))) throw e;
      await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
    }
  }
  throw last;
}

const money = (v: unknown) => Number(v ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (a: number, b: number) => (b === 0 ? "n/a" : `${((100 * a) / b).toFixed(2)}%`);
const line = (label: string, ours: number, theirs: number) => {
  const delta = ours - theirs;
  const flag = Math.abs(delta) <= Math.abs(theirs) * 0.005 ? "ok" : "DIFFERS";
  console.log(`  ${label.padEnd(22)} ours ${money(ours).padStart(16)}   source ${money(theirs).padStart(16)}   ${money(delta).padStart(15)}  ${pct(delta, theirs).padStart(8)}  ${flag}`);
};

(async () => {
  const org = ((await retry(() => db.execute(sql`select name, env_kind from orgs where id = ${ORG}`)))).rows[0];
  if (!org) throw new Error(`no such org: ${ORG}`);
  console.log(`${org.name} (${org.env_kind})  —  posting on/after ${SINCE}\n`);

  const client = sourceClient();

  // Source ISO symbols by currency-record id. Single-currency accounts do
  // not expose the currency record to SuiteQL; an empty map then falls back
  // to the display labels, and the grouped queries below still fail loudly.
  let symbolById = new Map<string, string>();
  try {
    const symbols = await retry(() => client.query<{ id: string; symbol: string }>(SOURCE_CURRENCY_SYMBOL_QUERY));
    symbolById = new Map(
      symbols
        .filter((row) => /^[A-Za-z]{3}$/.test(String(row.symbol ?? "").trim()))
        .map((row) => [String(row.id), String(row.symbol).trim().toUpperCase()]),
    );
  } catch {
    // Fall through with display labels only; see the comment above.
  }
  const subsidiaries = await retry(() => client.query<{ id: string; currency: string; currencylabel: string }>(SOURCE_SUBSIDIARY_QUERY));
  const subsidiaryIso = new Map(
    subsidiaries.map((row) => [
      String(row.id),
      sourceIsoCurrency("subsidiary", String(row.id), row.currency, row.currencylabel, symbolById),
    ]),
  );

  const srcPlRows = await retry(() => client.query<{ subsidiary: string; revenue: string; cost: string }>(sourcePlQuery(SINCE)));
  const srcRevenue = srcPlRows.map((row) => {
    const iso = subsidiaryIso.get(String(row.subsidiary ?? ""));
    if (!iso) throw new Error(`source P&L references unmapped subsidiary ${String(row.subsidiary ?? "unstated")}; refresh the source subsidiary population before comparing`);
    return { currency: iso, amount: String(row.revenue ?? "0") };
  });
  const srcCost = srcPlRows.map((row) => {
    const iso = subsidiaryIso.get(String(row.subsidiary ?? ""));
    if (!iso) throw new Error(`source P&L references unmapped subsidiary ${String(row.subsidiary ?? "unstated")}; refresh the source subsidiary population before comparing`);
    return { currency: iso, amount: String(row.cost ?? "0") };
  });
  const srcInvRows = await retry(() => client.query<{ currency_id: string; currency_label: string; n: string; total: string }>(sourceInvoiceQuery(SINCE)));
  const srcInvoices = srcInvRows.map((row) => ({
    currency: sourceIsoCurrency("invoice currency", String(row.currency_id ?? row.currency_label ?? ""), row.currency_id, row.currency_label, symbolById),
    n: Number(row.n ?? 0),
    total: String(row.total ?? "0"),
  }));

  const ours = ((await retry(() => db.execute<LedgerTotals>(sql`
    select s.base_currency as currency, je.subsidiary_id::text as subsidiary,
           coalesce(sum(-jl.amount) filter (where a.type = any(${`{${REVENUE.join(",")}}`}::text[])), 0)::text revenue,
           coalesce(sum(jl.amount) filter (where a.type = any(${`{${COST.join(",")}}`}::text[])), 0)::text cost
      from journal_lines jl
      join accounts a on a.id = jl.account_id
      join journal_entries je on je.id = jl.entry_id and je.status in ('posted', 'reversed')
      left join subsidiaries s on s.id = je.subsidiary_id and s.org_id = jl.org_id
     where jl.org_id = ${ORG} and je.posting_date >= ${SINCE}
     group by s.base_currency, je.subsidiary_id`)))).rows;
  for (const row of ours) {
    if (!row.currency) {
      throw new Error(`postings for subsidiary ${row.subsidiary} have no base currency; assign the legal entity a base currency before comparing`);
    }
  }
  const ourInv = ((await retry(() => db.execute<InvoiceTotals>(sql`
    select currency, count(*)::int n, coalesce(sum(total), 0)::text total from documents
     where org_id = ${ORG} and kind = 'customer_invoice' and status = 'posted' and document_date >= ${SINCE}
     group by currency`)))).rows;

  // No FX translation anywhere below: each bucket is compared in its stated
  // currency, and a currency one side lacks zero-fills into a difference.
  console.log("LEDGER (one verdict per functional currency; no combined total)");
  for (const bucket of alignMoneyBuckets(ours.map((row) => ({ currency: String(row.currency), amount: row.revenue })), srcRevenue)) {
    line(`[${bucket.currency}] revenue`, Number(bucket.ours), Number(bucket.theirs));
  }
  for (const bucket of alignMoneyBuckets(ours.map((row) => ({ currency: String(row.currency), amount: row.cost })), srcCost)) {
    line(`[${bucket.currency}] cost`, Number(bucket.ours), Number(bucket.theirs));
  }
  console.log("\nCUSTOMER INVOICES (one verdict per transaction currency; no combined total)");
  const invoiceCurrencies = [...new Set([...ourInv.map((row) => row.currency), ...srcInvoices.map((row) => row.currency)])].sort();
  const ourInvByCurrency = new Map(ourInv.map((row) => [row.currency, row]));
  const srcInvByCurrency = new Map(srcInvoices.map((row) => [row.currency, row]));
  for (const currency of invoiceCurrencies) {
    const oursBucket = ourInvByCurrency.get(currency);
    const srcBucket = srcInvByCurrency.get(currency);
    line(`[${currency}] count`, Number(oursBucket?.n ?? 0), Number(srcBucket?.n ?? 0));
    line(`[${currency}] total`, Number(oursBucket?.total ?? 0), Number(srcBucket?.total ?? 0));
  }

  // Job detail only exists after cutover; before it the history is year-end
  // summary journals with no project, so a job margin spanning both is meaningless.
  const job = ((await retry(() => db.execute<JobTotals>(sql`
    select coalesce(sum(-jl.amount) filter (where a.type = any(${`{${REVENUE.join(",")}}`}::text[])), 0)::text revenue,
           coalesce(sum(jl.amount) filter (where a.type = any(${`{${COST.join(",")}}`}::text[])), 0)::text cost,
           coalesce(sum(jl.amount) filter (where je.origin = 'overhead_applied'), 0)::text overhead,
           count(distinct jl.project_id)::int projects
      from journal_lines jl
      join accounts a on a.id = jl.account_id
      join journal_entries je on je.id = jl.entry_id and je.status in ('posted', 'reversed')
     where jl.org_id = ${ORG} and jl.project_id is not null and je.posting_date >= ${SINCE}`)))).rows[0]!;
  const jobRevenue = Number(job.revenue), jobCost = Number(job.cost), overhead = Number(job.overhead);
  console.log(`\nJOB-TAGGED (${job.projects} projects, detail exists only after cutover)`);
  console.log(`  revenue ${money(jobRevenue)}   cost ${money(jobCost)}   of which applied overhead ${money(overhead)}`);
  console.log(`  gross ${money(jobRevenue - jobCost)} (${pct(jobRevenue - jobCost, jobRevenue)})`);
  console.log(`  gross before applied overhead ${money(jobRevenue - jobCost + overhead)} (${pct(jobRevenue - jobCost + overhead, jobRevenue)})`);
  process.exit(0);
})().catch((e) => {
  const chain: string[] = [];
  for (let c = e; c; c = c.cause) if (c?.message) chain.push(String(c.message).replace(/\s+/g, " ").slice(0, 250));
  console.error("FATAL:", chain.pop() ?? "unknown");
  process.exit(1);
});
