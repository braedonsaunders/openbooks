import { sql } from "drizzle-orm";
import { db, pool } from "../db.ts";
import { divRate, fromUnits, mulRate, toUnits } from "../money.ts";

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

interface OpenLine {
  lineId: string;
  remaining: bigint;
  remainingTransaction: bigint;
  date: string;
  lineNo: number;
  accountId: string;
  partyId: string | null;
  subsidiaryId: string;
  currency: string;
  fxRate: string;
  functionalCurrency: string;
  bookId: string;
  periodId: string;
  documentId: string;
  sign: string;
}

interface PendingApplication {
  fromLineId: string;
  toLineId: string;
  amount: bigint;
  sourceAmount: bigint;
  sourceTransactionAmount: bigint;
  targetTransactionAmount: bigint;
  date: string;
  currency: string;
  fxGainLossEntryId: string | null;
  fxAdjustment: bigint;
  paymentRef: string;
  sourceDocumentId: string;
  bookId: string;
  periodId: string;
  subsidiaryId: string;
  accountId: string;
  partyId: string | null;
  functionalCurrency: string;
}

/** Largest transaction-currency amount whose rounded carrying value fits a
 * functional-currency capacity. Both the source link and open-item caps are
 * functional amounts, while the application trigger independently caps each
 * side's transaction amount. */
function transactionCapacity(base: bigint, transaction: bigint, fxRate: string): bigint {
  let capacity = transaction;
  const byBase = toUnits(divRate(fromUnits(base), fxRate));
  if (byBase < capacity) capacity = byBase;
  while (capacity > 0n && toUnits(mulRate(fromUnits(capacity), fxRate)) > base) capacity--;
  return capacity;
}

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
    const lineRows = await client.query<{ ref: string; line_id: string; pdate: string; line_no: number; amt: string; txn_amt: string; account_id: string; party_id: string | null; subsidiary_id: string; currency: string; fx_rate: string; functional_currency: string; book_id: string; period_id: string; document_id: string; amount_sign: string }>(`
      select d.custom->>$2 as ref, l.id as line_id, e.posting_date::text as pdate,
             l.line_number as line_no, abs(l.amount) as amt, abs(l.txn_amount) as txn_amt,
             l.account_id as account_id, l.party_id as party_id,
             l.subsidiary_id, l.currency, l.fx_rate, s.base_currency as functional_currency,
             e.book_id, e.period_id, d.id as document_id, sign(l.amount) as amount_sign
        from journal_entries e
        join documents d on d.id = e.source_document_id and d.posted_entry_id = e.id and d.org_id = e.org_id
        join journal_lines l on l.entry_id = e.id and l.org_id = e.org_id and l.is_open_item
        join accounts a on a.id = l.account_id and a.org_id = l.org_id
        join subsidiaries s on s.id = l.subsidiary_id and s.org_id = l.org_id
       where e.status = 'posted' and d.org_id = $1
         and a.type in ('liability_payable', 'asset_receivable')
         and d.custom->>$2 is not null`, [orgId, refKey]);

    const linesByRef = new Map<string, OpenLine[]>();
    for (const r of lineRows.rows) {
      const arr = linesByRef.get(r.ref) ?? [];
      arr.push({
        lineId: r.line_id,
        remaining: toUnits(r.amt),
        remainingTransaction: toUnits(r.txn_amt),
        date: r.pdate,
        lineNo: r.line_no,
        accountId: r.account_id,
        partyId: r.party_id,
        subsidiaryId: r.subsidiary_id,
        currency: r.currency,
        fxRate: r.fx_rate,
        functionalCurrency: r.functional_currency,
        bookId: r.book_id,
        periodId: r.period_id,
        documentId: r.document_id,
        sign: r.amount_sign,
      });
      linesByRef.set(r.ref, arr);
    }
    for (const arr of linesByRef.values()) arr.sort((a, b) => a.lineNo - b.lineNo);

    // -- hydrate what's already applied ------------------------------------------
    // per line (both roles), to reduce remaining capacity. The carrying and
    // transaction amounts are independent caps on applications: the source
    // role consumes source_amount/source_transaction_amount, while the target
    // role consumes amount/target_transaction_amount.
    const usedByLine = new Map<string, { base: bigint; transaction: bigint }>();
    for (const side of ["from_line_id", "to_line_id"] as const) {
      const baseColumn = side === "from_line_id" ? "source_amount" : "amount";
      const transactionColumn = side === "from_line_id" ? "source_transaction_amount" : "target_transaction_amount";
      const used = await client.query<{ line_id: string; base_amt: string; txn_amt: string }>(
        `select ${side} as line_id, sum(${baseColumn}) as base_amt, sum(${transactionColumn}) as txn_amt
           from applications where org_id = $1 and unapplied_at is null group by 1`,
        [orgId],
      );
      for (const r of used.rows) {
        const prior = usedByLine.get(r.line_id) ?? { base: 0n, transaction: 0n };
        usedByLine.set(r.line_id, {
          base: prior.base + toUnits(r.base_amt),
          transaction: prior.transaction + toUnits(r.txn_amt),
        });
      }
    }
    for (const arr of linesByRef.values()) {
      for (const ol of arr) {
        const used = usedByLine.get(ol.lineId) ?? { base: 0n, transaction: 0n };
        ol.remaining = ol.remaining - used.base < 0n ? 0n : ol.remaining - used.base;
        ol.remainingTransaction = ol.remainingTransaction - used.transaction < 0n
          ? 0n
          : ol.remainingTransaction - used.transaction;
      }
    }

    // per (payment, applied) pair, to compute the missing delta:
    const existingPair = new Map<string, bigint>();
    const pairRows = await client.query<{ pay_ref: string; app_ref: string; amt: string }>(`
      select df.custom->>$2 as pay_ref, dt.custom->>$2 as app_ref, sum(ap.source_amount) as amt
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
    const toInsert: PendingApplication[] = [];

    for (const [key, want] of target) {
      const have = existingPair.get(key) ?? 0n;
      let remaining = want - have;
      if (remaining <= 0n) { alreadySettled++; continue; }
      const [paymentRef, appliedRef] = key.split("|");
      // `key` is assembled from both source references above, but keep the
      // parser total under `noUncheckedIndexedAccess` before using the refs as
      // map keys (and before storing the payment ref on a pending row).
      if (paymentRef === undefined || appliedRef === undefined) {
        skippedNoLine++;
        continue;
      }
      const payLines = linesByRef.get(paymentRef);
      const appLines = linesByRef.get(appliedRef);
      if (!payLines || !appLines) { skippedNoLine++; continue; }
      // Journal line numbers are only meaningful inside their own entry. They
      // do not provide an ordering relation between the payment and applied
      // documents, so a two-pointer merge can discard a valid match when the
      // compatible parties appear in opposite orders. For each payment line,
      // search the remaining applied lines for a compatible counterpart instead.
      // The arrays remain line-number sorted for deterministic allocation among
      // multiple compatible lines, but compatibility—not cross-entry position—
      // decides which rows can settle one another.
      for (const payLine of payLines) {
        while (
          remaining > 0n &&
          payLine.remaining > 0n &&
          payLine.remainingTransaction > 0n
        ) {
          const appLine = appLines.find(
            (candidate) =>
              candidate.remaining > 0n &&
              candidate.remainingTransaction > 0n &&
              candidate.lineId !== payLine.lineId &&
              candidate.accountId === payLine.accountId &&
              candidate.partyId === payLine.partyId &&
              candidate.subsidiaryId === payLine.subsidiaryId &&
              candidate.currency === payLine.currency &&
              candidate.sign !== payLine.sign,
          );
          if (!appLine) break;

          const sourceCapacity = transactionCapacity(
            remaining,
            payLine.remainingTransaction,
            payLine.fxRate,
          );
          const targetCapacity = transactionCapacity(
            appLine.remaining,
            appLine.remainingTransaction,
            appLine.fxRate,
          );
          const transactionAlloc = sourceCapacity < targetCapacity
            ? sourceCapacity
            : targetCapacity;
          if (transactionAlloc <= 0n) break;
          const sourceAmount = toUnits(
            mulRate(fromUnits(transactionAlloc), payLine.fxRate),
          );
          const targetAmount = toUnits(
            mulRate(fromUnits(transactionAlloc), appLine.fxRate),
          );
          const sourceSigned = payLine.sign === "-1" ? -sourceAmount : sourceAmount;
          const targetSigned = appLine.sign === "-1" ? -targetAmount : targetAmount;
          toInsert.push({
            fromLineId: payLine.lineId,
            toLineId: appLine.lineId,
            amount: targetAmount,
            sourceAmount,
            sourceTransactionAmount: transactionAlloc,
            targetTransactionAmount: transactionAlloc,
            date: payLine.date,
            currency: payLine.currency,
            fxGainLossEntryId: null,
            fxAdjustment: -(sourceSigned + targetSigned),
            paymentRef,
            sourceDocumentId: payLine.documentId,
            bookId: payLine.bookId,
            periodId: payLine.periodId,
            subsidiaryId: payLine.subsidiaryId,
            accountId: payLine.accountId,
            partyId: payLine.partyId,
            functionalCurrency: payLine.functionalCurrency,
          });
          payLine.remaining -= sourceAmount;
          payLine.remainingTransaction -= transactionAlloc;
          appLine.remaining -= targetAmount;
          appLine.remainingTransaction -= transactionAlloc;
          remaining -= sourceAmount;
        }
        if (remaining <= 0n) break;
      }
      unallocated += remaining;
    }

    // A foreign-currency settlement may consume different functional carrying
    // values on its two sides even though the transaction amounts match. Post
    // one realized-FX journal per payment document and link every application
    // in that payment to the immutable evidence entry.
    const fxGroups = new Map<string, PendingApplication[]>();
    for (const row of toInsert) {
      // Keep independent control dimensions in separate entries. A source
      // payment can carry several AR/AP parties or subsidiaries; combining
      // their adjustments would book the aggregate to whichever account
      // happened to be encountered first.
      const groupKey = [
        row.paymentRef,
        row.subsidiaryId,
        row.accountId,
        row.partyId ?? "",
        row.functionalCurrency,
      ].join("|");
      const group = fxGroups.get(groupKey) ?? [];
      group.push(row);
      fxGroups.set(groupKey, group);
    }
    const fxAccountByCurrency = new Map<string, string>();
    for (const group of fxGroups.values()) {
      const adjustment = group.reduce((total, row) => total + row.fxAdjustment, 0n);
      if (adjustment === 0n) continue;
      const first = group[0]!;
      let fxAccountId = fxAccountByCurrency.get(first.functionalCurrency);
      if (!fxAccountId) {
        const fxAccount = await client.query<{ account_id: string | null }>(
          `select settings->'controlAccounts'->>'fxRealizedGainLoss' as account_id
             from orgs where id = $1`,
          [orgId],
        );
        fxAccountId = fxAccount.rows[0]?.account_id ?? undefined;
        if (!fxAccountId) {
          throw new Error("realized FX gain/loss account is not configured");
        }
        fxAccountByCurrency.set(first.functionalCurrency, fxAccountId);
      }
      const fxEntry = await client.query<{ id: string }>(
        `insert into journal_entries
          (org_id, book_id, subsidiary_id, entry_number, posting_date,
           period_id, memo, status, source_document_id, origin)
         values ($1, $2, $3, $4, $5, $6, $7, 'draft', $8, 'fx_settlement')
         returning id`,
        [
          orgId,
          first.bookId,
          first.subsidiaryId,
          `${first.sourceDocumentId}-FX`,
          first.date,
          first.periodId,
          `Realized FX settlement — ${first.sourceDocumentId}`,
          first.sourceDocumentId,
        ],
      );
      const fxEntryId = fxEntry.rows[0]!.id;
      await client.query(
        `insert into journal_lines
          (org_id, entry_id, line_number, account_id, subsidiary_id,
           amount, currency, txn_amount, fx_rate, party_id, is_open_item, memo)
         values
          ($1, $2, 1, $3, $4, $5, $6, $5, 1, $7, false, $8),
          ($1, $2, 2, $9, $4, $10, $6, $10, 1, null, false, $8)`,
        [
          orgId,
          fxEntryId,
          first.accountId,
          first.subsidiaryId,
          fromUnits(adjustment),
          first.functionalCurrency,
          first.partyId,
          `Realized FX settlement — ${first.sourceDocumentId}`,
          fxAccountId,
          fromUnits(-adjustment),
        ],
      );
      await client.query(
        `update journal_entries
            set status = 'posted', posted_at = now()
          where id = $1 and org_id = $2`,
        [fxEntryId, orgId],
      );
      for (const row of group) row.fxGainLossEntryId = fxEntryId;
    }

    // -- insert (same connection + transaction as the hydration reads) -----------
    for (let i = 0; i < toInsert.length; i += 1000) {
      const chunk = toInsert.slice(i, i + 1000);
      const values: string[] = [];
      const params: unknown[] = [orgId];
      for (const row of chunk) {
        const b = params.length;
        params.push(
          row.fromLineId,
          row.toLineId,
          fromUnits(row.amount),
          fromUnits(row.sourceAmount),
          fromUnits(row.sourceTransactionAmount),
          row.currency,
          fromUnits(row.targetTransactionAmount),
          row.currency,
          "1",
          "same_currency",
          `source application ${refKey}`,
          row.date,
          row.fxGainLossEntryId,
        );
        values.push(`($1, $${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7}, $${b + 8}, $${b + 9}, $${b + 10}, $${b + 11}, $${b + 12}, $${b + 13})`);
        insertedUnits += row.amount;
      }
      await client.query(
        `insert into applications
          (org_id, from_line_id, to_line_id, amount, source_amount,
           source_transaction_amount, source_transaction_currency,
           target_transaction_amount, target_transaction_currency,
           settlement_rate, settlement_rate_source, settlement_rate_reference,
           applied_on, fx_gain_loss_entry_id)
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
          left join journal_lines jl on jl.entry_id = d.posted_entry_id and jl.org_id = d.org_id and jl.is_open_item
          left join lateral (
            select sum(a.amount) as applied
              from applications a
             where (a.to_line_id = jl.id or a.from_line_id = jl.id)
               and a.org_id = d.org_id
               and a.unapplied_at is null
          ) ap on true
         where d.org_id = ${orgId} and d.status = 'posted' and d.posted_entry_id is not null
         group by d.id
      ) c
     where d.id = c.id and d.org_id = ${orgId} and d.open_balance is distinct from c.ob`));
  return res.rowCount ?? 0;
}
