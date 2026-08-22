import { sql } from "drizzle-orm";
import { db, pool } from "../db.ts";
import { divRate, fromUnits, toUnits } from "../money.ts";

/**
 * Payment-application reconciler — the platform's settlement sync.
 *
 * Given the SOURCE system's application links (payment/credit → the open item
 * it settled, e.g. NetSuite's nexttransactionlinelink linktype='Payment'),
 * reconcile openbooks `applications` to match. DELTA-SAFE and idempotent:
 * existing applied amounts per line AND per (payment, applied) pair are
 * hydrated first, so re-running inserts only what's missing — never duplicates.
 *
 * Both sides resolve to their posted entry's OPEN AR/AP line (is_open_item),
 * which includes journal legs (openbooks applies ANY crediting document).
 * Allocation is capped in-memory against remaining line capacity so the
 * kernel's app_check_open trigger just agrees; genuine source over-applications
 * are reported as `unallocated`, never forced.
 */

export interface SourceLink {
  paymentRef: string; // source id of the paying/crediting transaction
  appliedRef: string; // source id of the settled open item (invoice/bill)
  amount: string; // positive decimal
}

export interface ApplyStats {
  pairs: number;
  inserted: number;
  insertedAmount: string;
  alreadySettled: number;
  skippedNoLine: number;
  unallocated: string;
}

interface OpenLine { lineId: string; remaining: bigint; date: string; lineNo: number; accountId: string; partyId: string | null; subsidiaryId: string; currency: string; fxRate: string; sign: string }

export async function reconcileApplications(
  orgId: string,
  refKey: string,
  links: SourceLink[],
): Promise<ApplyStats> {
  // -- target: applied amount per (payment, applied) pair ---------------------
  const target = new Map<string, bigint>();
  for (const l of links) {
    const u = toUnits(l.amount);
    if (u <= 0n) continue;
    const key = `${l.paymentRef}|${l.appliedRef}`;
    target.set(key, (target.get(key) ?? 0n) + u);
  }

  // -- read-decide-write under one org-pinned transaction ----------------------
  // A per-org advisory xact lock serializes overlapping syncs: two concurrent
  // runs would otherwise hydrate the same "already applied" state and both
  // insert the missing delta. Every delta read AND the inserts share this one
  // connection and transaction, so no committed application can slip between
  // hydration and write. The tenant GUCs are set explicitly (the applyGuc
  // contract in db.ts): a sync job may run outside any request/org scope,
  // where pooled queries would be denied by default.
  const client = await pool.connect();
  let inserted = 0;
  let insertedUnits = 0n;
  let alreadySettled = 0;
  let skippedNoLine = 0;
  let unallocated = 0n;
  try {
    await client.query("begin");
    await client.query(
      "select set_config('app.current_org', $1, true), set_config('app.bypass_rls', 'off', true)",
      [orgId],
    );
    await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `sync-applications:${orgId}`,
    ]);

    // -- open AR/AP lines per source ref ----------------------------------------
    // Current posted entries only: a reversed entry (voided / source-deleted
    // document) no longer carries a settleable open item. Do not filter on
    // journal origin here. A controller-authorized source correction replaces
    // the document's original `document` entry with an append-only `migration`
    // or `intercompany` entry; that replacement is the only legal settlement
    // endpoint and must remain visible to a later source application.
    const lineRows = await client.query<{ ref: string; line_id: string; pdate: string; line_no: number; amt: string; account_id: string; party_id: string | null; subsidiary_id: string; currency: string; fx_rate: string; amount_sign: string }>(`
      select d.custom->>$2 as ref, l.id as line_id, e.posting_date::text as pdate,
             l.line_number as line_no, abs(l.amount) as amt,
             l.account_id as account_id, l.party_id as party_id,
             l.subsidiary_id, l.currency, l.fx_rate, sign(l.amount) as amount_sign
        from journal_entries e
        join documents d on d.id = e.source_document_id and d.posted_entry_id = e.id
        join journal_lines l on l.entry_id = e.id and l.is_open_item
        join accounts a on a.id = l.account_id
       where e.status = 'posted' and d.org_id = $1
         and a.type in ('liability_payable', 'asset_receivable')
         and d.custom->>$2 is not null`, [orgId, refKey]);

    const linesByRef = new Map<string, OpenLine[]>();
    for (const r of lineRows.rows) {
      const arr = linesByRef.get(r.ref) ?? [];
      arr.push({ lineId: r.line_id, remaining: toUnits(r.amt), date: r.pdate, lineNo: r.line_no, accountId: r.account_id, partyId: r.party_id, subsidiaryId: r.subsidiary_id, currency: r.currency, fxRate: r.fx_rate, sign: r.amount_sign });
      linesByRef.set(r.ref, arr);
    }
    for (const arr of linesByRef.values()) arr.sort((a, b) => a.lineNo - b.lineNo);

    // -- hydrate what's already applied ------------------------------------------
    // per line (both roles), to reduce remaining capacity:
    const usedByLine = new Map<string, bigint>();
    for (const side of ["from_line_id", "to_line_id"] as const) {
      const used = await client.query<{ line_id: string; amt: string }>(
        `select ${side} as line_id, sum(amount) as amt
           from applications where org_id = $1 and unapplied_at is null group by 1`,
        [orgId],
      );
      for (const r of used.rows) {
        usedByLine.set(r.line_id, (usedByLine.get(r.line_id) ?? 0n) + toUnits(r.amt));
      }
    }
    for (const arr of linesByRef.values()) {
      for (const ol of arr) {
        const used = usedByLine.get(ol.lineId) ?? 0n;
        ol.remaining = ol.remaining - used < 0n ? 0n : ol.remaining - used;
      }
    }

    // per (payment, applied) pair, to compute the missing delta:
    const existingPair = new Map<string, bigint>();
    const pairRows = await client.query<{ pay_ref: string; app_ref: string; amt: string }>(`
      select df.custom->>$2 as pay_ref, dt.custom->>$2 as app_ref, sum(ap.amount) as amt
        from applications ap
        join journal_lines lf on lf.id = ap.from_line_id and lf.org_id = ap.org_id
        join journal_entries ef on ef.id = lf.entry_id and ef.org_id = lf.org_id
        join documents df on df.id = ef.source_document_id and df.org_id = ef.org_id
        join journal_lines lt on lt.id = ap.to_line_id and lt.org_id = ap.org_id
        join journal_entries et on et.id = lt.entry_id and et.org_id = lt.org_id
        join documents dt on dt.id = et.source_document_id and dt.org_id = et.org_id
       where ap.org_id = $1 and ap.unapplied_at is null
         and df.custom->>$2 is not null and dt.custom->>$2 is not null
       group by 1, 2`, [orgId, refKey]);
    for (const r of pairRows.rows) {
      existingPair.set(`${r.pay_ref}|${r.app_ref}`, toUnits(r.amt));
    }

    // -- allocate the missing deltas ---------------------------------------------
    const toInsert: [string, string, bigint, string, string, string][] = []; // from, to, base, date, txn, currency

    for (const [key, want] of target) {
      const have = existingPair.get(key) ?? 0n;
      let remaining = want - have;
      if (remaining <= 0n) { alreadySettled++; continue; }
      const [paymentRef, appliedRef] = key.split("|");
      const payLines = linesByRef.get(paymentRef!);
      const appLines = linesByRef.get(appliedRef!);
      if (!payLines || !appLines) { skippedNoLine++; continue; }
      let pi = 0, ai = 0;
      while (remaining > 0n && pi < payLines.length && ai < appLines.length) {
        // A line can never settle itself: when a source self-links a document
        // (paymentRef === appliedRef, e.g. a journal referenced in its own payment
        // link), payLines and appLines share rows — skip the diagonal so we never
        // emit a from_line_id === to_line_id application (it breaks subledger↔GL
        // tie-out and represents no real settlement).
        if (payLines[pi]!.lineId === appLines[ai]!.lineId) { ai++; continue; }
        // A settlement is always SAME control account AND SAME subledger party:
        // a customer's AR credit settles that customer's AR debit — never AR↔AP,
        // and never one party against another. Source "payment" links between
        // multi-account journals and their reversals (month-end accruals, opening
        // balances) span AR and AP lines for different entities; pairing across
        // account or party would draw an open item down with an unrelated leg and
        // corrupt aging. Skip such pairings (advance the lagging pointer); a leg
        // with no same-account/same-party counterpart simply stays open (reported
        // as unallocated), which is the faithful outcome.
        if (
          payLines[pi]!.accountId !== appLines[ai]!.accountId ||
          payLines[pi]!.partyId !== appLines[ai]!.partyId ||
          payLines[pi]!.subsidiaryId !== appLines[ai]!.subsidiaryId ||
          payLines[pi]!.currency !== appLines[ai]!.currency ||
          payLines[pi]!.sign === appLines[ai]!.sign
        ) {
          if (payLines[pi]!.lineNo <= appLines[ai]!.lineNo) pi++;
          else ai++;
          continue;
        }
        const alloc = [remaining, payLines[pi]!.remaining, appLines[ai]!.remaining]
          .reduce((a, b) => (b < a ? b : a));
        if (alloc <= 0n) {
          if (payLines[pi]!.remaining <= 0n) pi++;
          else ai++;
          continue;
        }
        toInsert.push([
          payLines[pi]!.lineId,
          appLines[ai]!.lineId,
          alloc,
          payLines[pi]!.date,
          divRate(fromUnits(alloc), appLines[ai]!.fxRate),
          appLines[ai]!.currency,
        ]);
        payLines[pi]!.remaining -= alloc;
        appLines[ai]!.remaining -= alloc;
        remaining -= alloc;
        if (payLines[pi]!.remaining <= 0n) pi++;
        if (appLines[ai]!.remaining <= 0n) ai++;
      }
      unallocated += remaining;
    }

    // -- insert (same connection + transaction as the hydration reads) -----------
    for (let i = 0; i < toInsert.length; i += 1000) {
      const chunk = toInsert.slice(i, i + 1000);
      const values: string[] = [];
      const params: unknown[] = [orgId];
      for (const row of chunk) {
        const b = params.length;
        params.push(
          row[0], row[1], fromUnits(row[2]), fromUnits(row[2]),
          row[4], row[5], row[4], row[5], "1", "same_currency",
          `source application ${refKey}`, row[3],
        );
        values.push(`($1, $${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7}, $${b + 8}, $${b + 9}, $${b + 10}, $${b + 11}, $${b + 12})`);
        insertedUnits += row[2];
      }
      await client.query(
        `insert into applications
          (org_id, from_line_id, to_line_id, amount, source_amount,
           source_transaction_amount, source_transaction_currency,
           target_transaction_amount, target_transaction_currency,
           settlement_rate, settlement_rate_source, settlement_rate_reference, applied_on)
         values ${values.join(",")}`,
        params,
      );
      inserted += chunk.length;
    }
    await client.query("commit");
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  } finally {
    client.release();
  }

  return {
    pairs: target.size,
    inserted,
    insertedAmount: fromUnits(insertedUnits),
    alreadySettled,
    skippedNoLine,
    unallocated: fromUnits(unallocated),
  };
}

/**
 * Authoritative recompute of `documents.open_balance` for every posted document
 * of an org, set-based. The per-row `recompute_document_open_balance` function
 * is the source of truth; the `application_open_balance` trigger keeps it fresh
 * for normal single-row application changes, but bulk/out-of-band application
 * edits (repair scripts, historical loads) can leave the denormalized column
 * stale. Running this at the end of every sync makes open_balance — and thus
 * AR/AP aging + the open-item verification gate — trustworthy regardless of how
 * applications were written. Only drifted rows are touched. Returns the count
 * healed.
 */
export async function recomputeOpenBalances(orgId: string): Promise<number> {
  const res = (await db.execute(sql`
    update documents d
       set open_balance = c.ob
      from (
        select d.id,
               case when count(jl.id) = 0 then null
                    else sum(abs(jl.amount)) - coalesce(sum(ap.applied), 0) end as ob
          from documents d
          -- LEFT join: a posted document with NO open-item lines must resolve
          -- to null (matching recompute_document_open_balance), else a stale
          -- stored balance on such a document can never be healed.
          left join journal_lines jl on jl.entry_id = d.posted_entry_id and jl.is_open_item
          left join lateral (
            select sum(a.amount) as applied
              from applications a
             where (a.to_line_id = jl.id or a.from_line_id = jl.id)
               and a.unapplied_at is null
          ) ap on true
         where d.org_id = ${orgId} and d.status = 'posted' and d.posted_entry_id is not null
         group by d.id
      ) c
     where d.id = c.id and d.open_balance is distinct from c.ob`));
  return res.rowCount ?? 0;
}
