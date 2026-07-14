import { suiteql } from "../netsuite.ts";
import { fromUnits, toUnits } from "../money.ts";
import type { MigrationSource, SourceChanges, SourceTransaction, SourceTrialBalanceRow } from "./source.ts";

/** NetSuite adapter: posted GL via transactionaccountingline. */

interface TalRow {
  tid: string; ttype: string; trandate: string; tranid?: string;
  entity?: string; dept?: string; acct?: string; debit?: string; credit?: string;
  modified: string;
}

function usDateToIso(us: string): string {
  const m = us.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) throw new Error(`bad NetSuite date: ${us}`);
  return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
}

export class NetSuiteSource implements MigrationSource {
  readonly name = "netsuite";

  async changesSince(since: Date | null): Promise<SourceChanges> {
    // High-water mark from NetSuite's clock, not ours.
    const nowRows = await suiteql<{ now: string }>(
      "SELECT TO_CHAR(SYSDATE, 'YYYY-MM-DD HH24:MI:SS') AS now FROM DUAL",
    );
    const syncedThrough = new Date(nowRows[0].now.replace(" ", "T") + "Z");

    const sinceClause = since
      ? `AND t.lastmodifieddate >= TO_DATE('${since.toISOString().slice(0, 19).replace("T", " ")}', 'YYYY-MM-DD HH24:MI:SS')`
      : "";
    const rows = await suiteql<TalRow>(`
      SELECT t.id AS tid, t.type AS ttype, t.trandate, t.tranid,
             t.entity AS entity, tl.department AS dept,
             tal.account AS acct, tal.debit, tal.credit,
             TO_CHAR(t.lastmodifieddate, 'YYYY-MM-DD HH24:MI:SS') AS modified
        FROM transactionaccountingline tal
        JOIN transaction t ON t.id = tal.transaction
        LEFT JOIN transactionline tl
               ON tl.transaction = tal.transaction AND tl.id = tal.transactionline
       WHERE tal.posting = 'T' ${sinceClause}
    `);

    const byTxn = new Map<string, TalRow[]>();
    for (const r of rows) {
      const arr = byTxn.get(r.tid);
      if (arr) arr.push(r);
      else byTxn.set(r.tid, [r]);
    }

    const transactions: SourceTransaction[] = [];
    for (const [tid, txnRows] of byTxn) {
      const first = txnRows[0];
      const lines = txnRows
        .filter((r) => r.acct)
        .map((r) => ({
          accountRef: String(r.acct),
          amount: fromUnits(toUnits(r.debit ?? "0") - toUnits(r.credit ?? "0")),
          departmentRef: r.dept ? String(r.dept) : null,
          partyRef: first.entity ? String(first.entity) : null,
        }))
        .filter((l) => toUnits(l.amount) !== 0n);
      transactions.push({
        sourceRef: tid,
        type: first.ttype,
        number: first.tranid ?? null,
        date: usDateToIso(first.trandate),
        memo: `NetSuite ${first.ttype} ${first.tranid ?? ""}`.trim(),
        lines,
      });
    }
    return { transactions, syncedThrough };
  }

  async trialBalance(): Promise<SourceTrialBalanceRow[]> {
    const rows = await suiteql<{ acct?: string; d: string; c: string }>(`
      SELECT tal.account AS acct, SUM(COALESCE(tal.debit,0)) AS d, SUM(COALESCE(tal.credit,0)) AS c
        FROM transactionaccountingline tal
       WHERE tal.posting = 'T'
       GROUP BY tal.account
    `);
    return rows
      .filter((r) => r.acct)
      .map((r) => ({ accountRef: String(r.acct), balance: fromUnits(toUnits(r.d) - toUnits(r.c)) }));
  }
}
