import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { add, mulRate, neg, sum, isZero, cmp } from "./money.ts";

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
    const currency = org.rows[0]?.base_currency ?? "CAD";
    // journal_entries.subsidiary_id is NOT NULL — fall back to the org's default
    // (first non-elimination) subsidiary when the project/time carries none.
    let subId = subsidiaryId;
    if (!subId) {
      const s = (await tx.execute(sql`
        select id from subsidiaries where org_id = ${orgId} and is_active and not is_elimination
         order by name limit 1`)) as unknown as { rows: { id: string }[] };
      subId = s.rows[0]?.id ?? null;
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
export async function postProjectLaborCost(orgId: string, actorId: string, timeEntryIds: string[]): Promise<string | null> {
  if (timeEntryIds.length === 0) return null;
  const accts = await recognitionAccounts(orgId);
  if (!accts.laborWip || !accts.laborClearing) return null; // inert until mapped
  const idArr = `{${timeEntryIds.join(",")}}`;
  const rows = (await db.execute(sql`
    select te.id, te.project_id, te.hours, te.cost_rate, te.worked_on, p.subsidiary_id
      from time_entries te
      left join projects p on p.id = te.project_id
     where te.org_id = ${orgId} and te.id = any(${idArr}::uuid[])
       and te.status = 'approved' and te.project_id is not null and te.cost_journal_entry_id is null`)) as unknown as {
    rows: { id: string; project_id: string; hours: string; cost_rate: string | null; worked_on: string; subsidiary_id: string | null }[];
  };
  if (rows.rows.length === 0) return null;

  // Sum cost by project.
  const byProject = new Map<string, string>();
  const posted: string[] = [];
  let subsidiaryId: string | null = null;
  let maxDate = "";
  for (const r of rows.rows) {
    const cost = mulRate(String(r.hours ?? "0"), String(r.cost_rate ?? "0"));
    if (isZero(cost)) continue;
    byProject.set(r.project_id, add(byProject.get(r.project_id) ?? "0", cost));
    posted.push(r.id);
    subsidiaryId = subsidiaryId ?? r.subsidiary_id;
    if (r.worked_on > maxDate) maxDate = r.worked_on;
  }
  if (byProject.size === 0) return null;

  const lines: GlLine[] = [];
  let total = "0";
  for (const [projectId, amt] of byProject) {
    lines.push({ accountId: accts.laborWip, amount: amt, projectId, memo: "Labor cost" });
    total = add(total, amt);
  }
  lines.push({ accountId: accts.laborClearing, amount: neg(total), memo: "Labor clearing" });

  const postingDate = maxDate || new Date().toISOString().slice(0, 10);
  const entryId = await postProjectGlEntry({
    orgId,
    actorId,
    origin: "labor_burden",
    entryNumber: `LAB-${postingDate}-${timeEntryIds[0].slice(0, 8)}`,
    postingDate,
    memo: "Approved labor cost → project WIP",
    subsidiaryId,
    lines,
  });
  if (entryId) {
    await db.execute(sql`update time_entries set cost_journal_entry_id = ${entryId} where org_id = ${orgId} and id = any(${`{${posted.join(",")}}`}::uuid[])`);
  }
  return entryId;
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

/* ------------------------------------------------------------------ */
/* Fixed-price revenue recognition (percent-complete)                  */
/* ------------------------------------------------------------------ */

export interface RecognitionResult {
  contractValue: string;
  percentComplete: number;
  earned: string;
  recognizedToDate: string;
  delta: string;
  entryId: string | null;
}

/**
 * Recognize fixed-price project revenue to the earned-to-date point (ASC 606
 * over-time): earned = contractValue × %complete (cost-to-cost by default),
 * posting only the delta over already-recognized: DR unbilled receivable /
 * CR project revenue (origin revenue_recognition). The invoice later relieves
 * unbilled receivable, so revenue is recognized once. Requires the accounts
 * mapped; pass an explicit percentComplete (0..1) to override cost-to-cost.
 */
export async function recognizeProjectRevenue(
  orgId: string,
  actorId: string,
  projectId: string,
  percentCompleteOverride?: number,
): Promise<RecognitionResult> {
  const accts = await recognitionAccounts(orgId);
  if (!accts.unbilledReceivable || !accts.projectRevenue) {
    throw new Error("Map the Unbilled receivable and Project revenue accounts in Settings first");
  }
  const proj = (await db.execute(sql`
    select subsidiary_id, customer_id, billing_method,
           coalesce((custom->>'contractValue')::numeric, 0) as contract_value
      from projects where id = ${projectId} and org_id = ${orgId}`)) as unknown as {
    rows: { subsidiary_id: string | null; customer_id: string | null; billing_method: string | null; contract_value: string }[];
  };
  const p = proj.rows[0];
  if (!p) throw new Error("Project not found");
  const contractValue = String(p.contract_value ?? "0");

  let percent = percentCompleteOverride;
  if (percent == null) {
    const cc = (await db.execute(sql`
      select
        coalesce((select sum(t.estimated_cost) from project_tasks t where t.project_id = ${projectId} and t.org_id = ${orgId}), 0) as budget,
        coalesce((select sum(l.amount) from journal_lines l join journal_entries e on e.id = l.entry_id join accounts a on a.id = l.account_id
                   where l.org_id = ${orgId} and l.project_id = ${projectId} and e.status = 'posted'
                     and a.type in ('expense','cogs','expense_other','expense_deferred')), 0) as actual`)) as unknown as {
      rows: { budget: string; actual: string }[];
    };
    const budget = Number(cc.rows[0]?.budget ?? 0);
    const actual = Number(cc.rows[0]?.actual ?? 0);
    percent = budget > 0 ? Math.min(1, actual / budget) : 0;
  }
  percent = Math.max(0, Math.min(1, percent));

  const earned = mulRate(contractValue, percent.toFixed(6));
  // recognized to date = credits already posted to project revenue for this project.
  const rec = (await db.execute(sql`
    select coalesce(-sum(l.amount), 0)::numeric(19,4) as recognized
      from journal_lines l join journal_entries e on e.id = l.entry_id
     where l.org_id = ${orgId} and l.project_id = ${projectId} and e.status = 'posted'
       and e.origin = 'revenue_recognition' and l.account_id = ${accts.projectRevenue}`)) as unknown as {
    rows: { recognized: string }[];
  };
  const recognizedToDate = String(rec.rows[0]?.recognized ?? "0");
  const delta = add(earned, neg(recognizedToDate));

  let entryId: string | null = null;
  if (cmp(delta, "0") !== 0) {
    const postingDate = new Date().toISOString().slice(0, 10);
    entryId = await postProjectGlEntry({
      orgId,
      actorId,
      origin: "revenue_recognition",
      entryNumber: `REV-${postingDate}-${projectId.slice(0, 8)}`,
      postingDate,
      memo: "Percent-complete revenue recognition",
      subsidiaryId: p.subsidiary_id,
      lines: [
        // DR unbilled receivable (contract asset), CR project revenue — signed
        // so a positive delta debits the asset / credits revenue; a negative
        // delta (percent dropped) reverses.
        { accountId: accts.unbilledReceivable, amount: delta, projectId, partyId: p.customer_id, memo: "Unbilled receivable" },
        { accountId: accts.projectRevenue, amount: neg(delta), projectId, memo: "Project revenue" },
      ],
    });
  }
  return { contractValue, percentComplete: percent, earned, recognizedToDate, delta, entryId };
}
