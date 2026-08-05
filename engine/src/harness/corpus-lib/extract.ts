import { sql } from "drizzle-orm";
import { db } from "../../db.ts";
import { fromUnits, toUnits } from "../../money.ts";

/**
 * Canonical snapshot extraction — the OpenBooks side of a comparison. Every
 * figure is a signed (debit-positive) decimal string keyed by SEMANTIC key, so
 * snapshots are directly comparable with the independent reference ledger and
 * with other systems' adapters.
 */

/** Signed balance per semantic account key over all posted/reversed entries. Zeros omitted. */
export async function trialBalanceByKey(
  orgId: string,
  accounts: Record<string, string>,
): Promise<Record<string, string>> {
  const keyById = new Map(Object.entries(accounts).map(([key, id]) => [id, key]));
  const rows = (await db.execute(sql`
    select l.account_id, sum(l.amount)::text as bal
      from journal_lines l
      join journal_entries e on e.id = l.entry_id
     where l.org_id = ${orgId} and e.status in ('posted', 'reversed')
     group by l.account_id`)) as unknown as { rows: { account_id: string; bal: string }[] };
  const out: Record<string, string> = {};
  for (const r of rows.rows) {
    const key = keyById.get(r.account_id);
    if (!key) throw new Error(`posted line on account ${r.account_id} outside the corpus account set`);
    if (toUnits(r.bal) !== 0n) out[key] = fromUnits(toUnits(r.bal));
  }
  return out;
}

/**
 * Signed open balance per party per subledger side. Mirrors the aging math in
 * harness/scenario.ts: each open-item line keeps its sign (invoices +ar,
 * credits −ar, bills −ap …) reduced toward zero by settled applications.
 */
export async function openBalancesByParty(
  orgId: string,
  partyIds: Record<string, string>,
): Promise<Record<string, { ar?: string; ap?: string }>> {
  const keyById = new Map(Object.entries(partyIds).map(([key, id]) => [id, key]));
  const rows = (await db.execute(sql`
    select d.party_id, d.kind,
           sum(l.amount - sign(l.amount) * coalesce((
             select sum(ap.amount) from applications ap
              where (ap.to_line_id = l.id or ap.from_line_id = l.id) and ap.unapplied_at is null
           ), 0))::text as open
      from documents d
      join journal_entries e on e.id = d.posted_entry_id and e.status in ('posted', 'reversed')
      join journal_lines l on l.entry_id = d.posted_entry_id and l.is_open_item
     where d.org_id = ${orgId} and d.status = 'posted'
     group by d.party_id, d.kind`)) as unknown as {
    rows: { party_id: string; kind: string; open: string }[];
  };
  const out: Record<string, { ar?: string; ap?: string }> = {};
  for (const r of rows.rows) {
    const key = keyById.get(r.party_id);
    if (!key) throw new Error(`open item for party ${r.party_id} outside the corpus party set`);
    const side = r.kind.startsWith("customer") ? "ar" : "ap";
    const entry = (out[key] ??= {});
    entry[side] = fromUnits(toUnits(entry[side] ?? "0") + toUnits(r.open));
  }
  // Drop settled sides/parties so the snapshot matches the reference's zero-omission.
  for (const [key, sides] of Object.entries(out)) {
    if (sides.ar !== undefined && toUnits(sides.ar) === 0n) delete sides.ar;
    if (sides.ap !== undefined && toUnits(sides.ap) === 0n) delete sides.ap;
    if (sides.ar === undefined && sides.ap === undefined) delete out[key];
  }
  return out;
}

export interface ProjectRollup {
  /** Project-tagged debits to cogs/expense accounts (job cost). */
  cost: string;
  /** Project-tagged credits to income accounts, credit-positive (billed revenue). */
  billed: string;
  margin: string;
}

/** GL-derived per-project cost/billed/margin — the job-costing comparison contract. */
export async function projectRollups(
  orgId: string,
  projectIds: Record<string, string>,
): Promise<Record<string, ProjectRollup>> {
  const keyById = new Map(Object.entries(projectIds).map(([key, id]) => [id, key]));
  const rows = (await db.execute(sql`
    select l.project_id,
           coalesce(sum(l.amount) filter (where a.type in ('cogs', 'expense', 'expense_other', 'expense_deferred')), 0)::text as cost,
           coalesce(-sum(l.amount) filter (where a.type in ('income', 'income_other')), 0)::text as billed
      from journal_lines l
      join journal_entries e on e.id = l.entry_id and e.status in ('posted', 'reversed')
      join accounts a on a.id = l.account_id
     where l.org_id = ${orgId} and l.project_id is not null
     group by l.project_id`)) as unknown as {
    rows: { project_id: string; cost: string; billed: string }[];
  };
  const out: Record<string, ProjectRollup> = {};
  for (const r of rows.rows) {
    const key = keyById.get(r.project_id);
    if (!key) throw new Error(`project-tagged line for project ${r.project_id} outside the corpus project set`);
    out[key] = {
      cost: fromUnits(toUnits(r.cost)),
      billed: fromUnits(toUnits(r.billed)),
      margin: fromUnits(toUnits(r.billed) - toUnits(r.cost)),
    };
  }
  return out;
}

export interface SnapshotDiff {
  key: string;
  openbooks: string;
  reference: string;
  delta: string;
}

/** Penny-exact diff of two keyed decimal maps. No tolerance — one cent fails. */
export function diffKeyed(
  openbooks: Record<string, string>,
  reference: Record<string, string>,
): SnapshotDiff[] {
  const keys = [...new Set([...Object.keys(openbooks), ...Object.keys(reference)])].sort();
  const diffs: SnapshotDiff[] = [];
  for (const key of keys) {
    const a = toUnits(openbooks[key] ?? "0");
    const b = toUnits(reference[key] ?? "0");
    if (a !== b) {
      diffs.push({ key, openbooks: fromUnits(a), reference: fromUnits(b), delta: fromUnits(a - b) });
    }
  }
  return diffs;
}
