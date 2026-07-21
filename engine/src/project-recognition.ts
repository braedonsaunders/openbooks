import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { add, mulRate, neg, sum, isZero } from "./money.ts";

/**
 * Project GL recognition — the accounting-correct layer on top of the billing
 * engine. Two flows, both gated on org control-account config (inert until the
 * accounts are mapped in Setup):
 *   • Labor → WIP at approval: DR labor WIP [project] / CR labor clearing.
 *   • Fixed-price revenue recognition: percent-complete DR unbilled receivable
 *     [project] / CR project revenue. The invoice later relieves unbilled
 *     receivable (see generateInvoiceFromBillingRequest), so revenue is
 *     recognized once, when earned — not double-counted at billing.
 *
 * All entries post through the kernel (balanced, period-checked) with a tagged
 * `origin`, exactly like depreciation/fx-revaluation.
 */

interface RecognitionAccounts {
  laborWip?: string;
  laborClearing?: string;
  unbilledReceivable?: string;
  projectRevenue?: string;
}

export async function recognitionAccounts(orgId: string): Promise<RecognitionAccounts> {
  const r = (await db.execute(sql`select settings->'controlAccounts' as c from orgs where id = ${orgId}`)) as unknown as {
    rows: { c: Record<string, string> | null }[];
  };
  const c = r.rows[0]?.c ?? {};
  return {
    laborWip: c.laborWip,
    laborClearing: c.laborClearing,
    unbilledReceivable: c.unbilledReceivable,
    projectRevenue: c.projectRevenue,
  };
}

interface GlLine {
  accountId: string;
  amount: string; // signed: debit +, credit −
  projectId?: string | null;
  partyId?: string | null;
  memo?: string | null;
}

/**
 * Post a balanced, period-checked GL entry with a tagged origin — the shared
 * kernel poster for labor/recognition (mirrors depreciation.ts). Runs in its
 * own transaction; returns the entry id, or null when there is nothing to post.
 */
export async function postProjectGlEntry(opts: {
  orgId: string;
  actorId: string;
  origin: string;
  entryNumber: string;
  postingDate: string;
  memo: string;
  subsidiaryId?: string | null;
  /** Functional currency of line amounts when already resolved by the caller. */
  currency?: string;
  lines: GlLine[];
}): Promise<string | null> {
  const { orgId, actorId, origin, entryNumber, postingDate, memo, subsidiaryId, lines } = opts;
  if (lines.length === 0) return null;
  const bal = sum(lines.map((l) => l.amount));
  if (!isZero(bal)) throw new Error(`unbalanced project GL entry (${bal})`);
  return db.transaction(async (tx) => {
    const book = (await tx.execute(sql`
      select id from accounting_books where org_id = ${orgId} and is_active
       order by is_primary desc, code limit 1`)) as unknown as { rows: { id: string }[] };
    const bookId = book.rows[0]?.id;
    if (!bookId) throw new Error("no active GL book");
    const per = (await tx.execute(sql`
      select id from accounting_periods where org_id = ${orgId} and is_adjustment = false
       and starts_on <= ${postingDate} and ends_on >= ${postingDate} limit 1`)) as unknown as { rows: { id: string }[] };
    const periodId = per.rows[0]?.id;
    if (!periodId) throw new Error(`no accounting period covers ${postingDate}`);
    const org = (await tx.execute(sql`select base_currency from orgs where id = ${orgId}`)) as unknown as {
      rows: { base_currency: string }[];
    };
    const orgCurrency = org.rows[0]?.base_currency ?? "CAD";
    // journal_entries.subsidiary_id is NOT NULL — fall back to the org's default
    // (first non-elimination) subsidiary when the project/time carries none.
    let subId = subsidiaryId;
    if (!subId) {
      const s = (await tx.execute(sql`
        select id from subsidiaries where org_id = ${orgId} and is_active and not is_elimination
         order by name limit 1`)) as unknown as { rows: { id: string }[] };
      subId = s.rows[0]?.id ?? null;
    }
    let currency = orgCurrency;
    if (subId) {
      const subsidiary = (await tx.execute(sql`
        select base_currency from subsidiaries where org_id = ${orgId} and id = ${subId}`)) as unknown as {
        rows: { base_currency: string }[];
      };
      const functionalCurrency = subsidiary.rows[0]?.base_currency;
      if (!functionalCurrency) throw new Error(`subsidiary ${subId} does not exist`);
      if (opts.currency && opts.currency !== functionalCurrency) {
        throw new Error(`project GL currency ${opts.currency} does not match subsidiary functional currency ${functionalCurrency}`);
      }
      currency = opts.currency ?? orgCurrency;
    }
    const [entry] = (await tx.execute(sql`
      insert into journal_entries
        (org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin, created_by, updated_by)
      values (${orgId}, ${bookId}, ${subId}, ${entryNumber}, ${postingDate}, ${periodId}, ${memo},
              'draft', ${origin}, ${actorId}, ${actorId})
      returning id`)).rows as any[];
    const eid = entry.id;
    let n = 1;
    for (const l of lines) {
      await tx.execute(sql`
        insert into journal_lines
          (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate,
           project_id, party_id, memo)
        values (${orgId}, ${eid}, ${n}, ${l.accountId}, ${subId}, ${l.amount}, ${currency}, ${l.amount}, 1,
                ${l.projectId ?? null}, ${l.partyId ?? null}, ${l.memo ?? memo})`);
      n++;
    }
    await tx.execute(sql`update journal_entries set status = 'posted', posted_at = now(), posted_by = ${actorId} where id = ${eid}`);
    return eid;
  });
}

/** Reverse a posted origin-tagged entry (negated mirror, reverses_entry_id). */
export async function reverseProjectGlEntry(orgId: string, actorId: string, entryId: string): Promise<string | null> {
  return db.transaction(async (tx) => {
    const head = (await tx.execute(sql`
      select entry_number, book_id, subsidiary_id, period_id, posting_date, origin, status
        from journal_entries where id = ${entryId} and org_id = ${orgId}`)) as unknown as { rows: any[] };
    const h = head.rows[0];
    if (!h || h.status !== "posted") return null;
    const lines = (await tx.execute(sql`
      select account_id, amount, currency, txn_amount, project_id, party_id, memo, subsidiary_id
        from journal_lines where entry_id = ${entryId} order by line_number`)) as unknown as { rows: any[] };
    const [rev] = (await tx.execute(sql`
      insert into journal_entries
        (org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin, reverses_entry_id, created_by, updated_by)
      values (${orgId}, ${h.book_id}, ${h.subsidiary_id}, ${h.entry_number + "-R"}, ${h.posting_date}, ${h.period_id},
              ${"Reversal of " + h.entry_number}, 'draft', ${h.origin}, ${entryId}, ${actorId}, ${actorId})
      returning id`)).rows as any[];
    let n = 1;
    for (const l of lines.rows) {
      await tx.execute(sql`
        insert into journal_lines
          (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate, project_id, party_id, memo)
        values (${orgId}, ${rev.id}, ${n}, ${l.account_id}, ${l.subsidiary_id}, ${neg(String(l.amount))}, ${l.currency},
                ${neg(String(l.txn_amount ?? l.amount))}, 1, ${l.project_id}, ${l.party_id}, ${l.memo})`);
      n++;
    }
    await tx.execute(sql`update journal_entries set status = 'posted', posted_at = now(), posted_by = ${actorId} where id = ${rev.id}`);
    await tx.execute(sql`update journal_entries set status = 'reversed' where id = ${entryId}`);
    return rev.id;
  });
}

/* ------------------------------------------------------------------ */
/* Labor cost → WIP at approval                                        */
/* ------------------------------------------------------------------ */

/**
 * Post the labor cost of approved time to the ledger: DR labor WIP per project
 * (Σ hours × cost_rate), CR labor clearing (total). No-op unless both accounts
 * are configured and there is nonzero costed time. Stamps
 * time_entries.cost_journal_entry_id so it is never re-posted. Call after time
 * transitions to approved.
 */
export interface LaborPostingSourceRow {
  id: string;
  project_id: string;
  hours: string;
  cost_rate: string | null;
  worked_on: string;
  subsidiary_id: string | null;
  cost_rate_currency: string;
}

export interface LaborPostingGroup {
  subsidiaryId: string | null;
  currency: string;
  postingDate: string;
  timeEntryIds: string[];
  projectCosts: Array<{ projectId: string; amount: string }>;
  total: string;
}

/** Keep every labor journal inside one legal entity while aggregating projects. */
export function groupLaborPostings(rows: LaborPostingSourceRow[]): LaborPostingGroup[] {
  const groups = new Map<string, { subsidiaryId: string | null; currency: string; postingDate: string; timeEntryIds: string[]; byProject: Map<string, string> }>();
  for (const row of rows) {
    const cost = mulRate(String(row.hours ?? "0"), String(row.cost_rate ?? "0"));
    if (isZero(cost)) continue;
    const key = `${row.subsidiary_id ?? "__default__"}|${row.cost_rate_currency}`;
    const group = groups.get(key) ?? { subsidiaryId: row.subsidiary_id, currency: row.cost_rate_currency, postingDate: "", timeEntryIds: [], byProject: new Map<string, string>() };
    group.byProject.set(row.project_id, add(group.byProject.get(row.project_id) ?? "0", cost));
    group.timeEntryIds.push(row.id);
    if (row.worked_on > group.postingDate) group.postingDate = row.worked_on;
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => {
    const projectCosts = [...group.byProject].map(([projectId, amount]) => ({ projectId, amount }));
    return {
      subsidiaryId: group.subsidiaryId,
      currency: group.currency,
      postingDate: group.postingDate,
      timeEntryIds: group.timeEntryIds,
      projectCosts,
      total: sum(projectCosts.map((project) => project.amount)),
    };
  });
}

export async function postProjectLaborCost(orgId: string, actorId: string, timeEntryIds: string[]): Promise<string[]> {
  if (timeEntryIds.length === 0) return [];
  const accts = await recognitionAccounts(orgId);
  if (!accts.laborWip || !accts.laborClearing) return []; // inert until mapped
  const idArr = `{${timeEntryIds.join(",")}}`;
  const rows = (await db.execute(sql`
    select te.id, te.project_id, te.hours, te.cost_rate, te.worked_on,
           coalesce(p.subsidiary_id, te.cost_rate_subsidiary_id) as subsidiary_id,
           coalesce(te.cost_rate_currency, s.base_currency, o.base_currency) as cost_rate_currency
      from time_entries te
      left join projects p on p.id = te.project_id
      left join subsidiaries s on s.id = p.subsidiary_id
      join orgs o on o.id = te.org_id
     where te.org_id = ${orgId} and te.id = any(${idArr}::uuid[])
       and te.status = 'approved' and te.project_id is not null and te.cost_journal_entry_id is null`)) as unknown as {
    rows: LaborPostingSourceRow[];
  };
  if (rows.rows.length === 0) return [];

  const entryIds: string[] = [];
  for (const group of groupLaborPostings(rows.rows)) {
    const lines: GlLine[] = group.projectCosts.map((project) => ({
      accountId: accts.laborWip!,
      amount: project.amount,
      projectId: project.projectId,
      memo: "Labor cost",
    }));
    lines.push({ accountId: accts.laborClearing, amount: neg(group.total), memo: "Labor clearing" });
    const postingDate = group.postingDate || new Date().toISOString().slice(0, 10);
    const entryId = await postProjectGlEntry({
      orgId,
      actorId,
      origin: "labor_burden",
      entryNumber: `LAB-${postingDate}-${group.timeEntryIds[0].slice(0, 8)}`,
      postingDate,
      memo: "Approved labor cost → project WIP",
      subsidiaryId: group.subsidiaryId,
      currency: group.currency,
      lines,
    });
    if (entryId) {
      entryIds.push(entryId);
      await db.execute(sql`update time_entries set cost_journal_entry_id = ${entryId} where org_id = ${orgId} and id = any(${`{${group.timeEntryIds.join(",")}}`}::uuid[])`);
    }
  }
  return entryIds;
}

/** Release labor-cost entries for time (reverse + clear the linkage). */
export async function reverseProjectLaborCost(orgId: string, actorId: string, timeEntryIds: string[]): Promise<void> {
  if (timeEntryIds.length === 0) return;
  const idArr = `{${timeEntryIds.join(",")}}`;
  const ent = (await db.execute(sql`
    select distinct cost_journal_entry_id from time_entries
     where org_id = ${orgId} and id = any(${idArr}::uuid[]) and cost_journal_entry_id is not null`)) as unknown as {
    rows: { cost_journal_entry_id: string }[];
  };
  for (const e of ent.rows) await reverseProjectGlEntry(orgId, actorId, e.cost_journal_entry_id);
  await db.execute(sql`update time_entries set cost_journal_entry_id = null where org_id = ${orgId} and id = any(${idArr}::uuid[])`);
}

// Fixed-price percent-complete revenue recognition moved to the ARM pipeline:
// see project-revenue.ts (syncProjectRevenueContracts) — the central
// recognition run posts it; there is no per-project posting entry point.
