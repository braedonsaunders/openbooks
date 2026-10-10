import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { createScriptJournal } from "../ledger/journal-writes.ts";
import { importStatement } from "../banking/statement-import.ts";
import { createMatch } from "../banking/matching.ts";
import { startReconciliation, markReconciled } from "../banking/reconciliation.ts";
import { fromUnits, toUnits } from "../money/money.ts";
import { scenarioRecordId, type DemoContext } from "./scenarios.ts";
import { SampleCompanyError } from "./provisioning-failures.ts";

/** Separate accounts keep new evidence independent of already reconciled history. */
export async function installOperatingBanking(c: DemoContext): Promise<void> {
  const ctx = { orgId: c.orgId, userId: c.actorId, allowedSubsidiaryIds: new Set([c.subsidiaryId]) };
  const date = c.operationDate ?? c.date;
  for (const [index, key] of ["operations-bank", "reserve-bank", "payroll-bank", "settlement-bank"].entries()) {
    const accountId = scenarioRecordId(c, "accounts", key);
    // An operator-owned or completed session is never rewound by sample refresh.
    const prior = (await db.execute<{ id: string; status: string }>(sql`select id,status from reconciliations where org_id=${c.orgId} and account_id=${accountId} order by through_date desc,id limit 1`)).rows[0];
    if (prior) continue;
    const entries: Array<{ entryId: string; date: string; amount: string; description: string; bankTransactionId: string }> = [];
    const amounts = index === 0 ? ["50000.00", "1250.00", "850.00", "-275.00", "-480.00", "-75.00"] : index === 1 ? ["25000.00", "25.00", "-10.00"] : ["18000.00", "-35.00", "15.00"];
    let closing = 0n;
    for (const [n, amount] of amounts.entries()) {
      const description = n === 0 ? "Synthetic operating capital funding" : amount.startsWith("-") ? "Synthetic bank service and treasury charges" : "Synthetic treasury income and fee credits";
      const offset = n === 0 ? scenarioRecordId(c, "accounts", "capital") : amount.startsWith("-") ? c.accounts.expense : c.accounts.revenue;
      const ref = `industry-demo:${c.orgId}:${key}:${n}`;
      const posted = await createScriptJournal(c.orgId, c.actorId, { documentDate: date, subsidiaryId: c.subsidiaryId, memo: description,
        lines: [{ accountId, amount }, { accountId: offset, amount: fromUnits(-toUnits(amount)) }] }, { post: true, idempotencyKey: ref, allowedSubsidiaryIds: ctx.allowedSubsidiaryIds });
      if (!posted.entryId || posted.approvalPending) throw new SampleCompanyError("Operating cash examples require independent journal approval; review Flows before refreshing.");
      entries.push({ entryId: posted.entryId, date, amount, description, bankTransactionId: ref });
      closing += toUnits(amount);
    }
    {
      const payments = (await db.execute<{ entryId: string; date: string; amount: string; description: string; documentId: string }>(sql`
        select e.id as "entryId",e.posting_date::text as date,l.txn_amount::text as amount,d.memo as description,d.id as "documentId"
        from journal_lines l join journal_entries e on e.org_id=l.org_id and e.id=l.entry_id
        join documents d on d.org_id=e.org_id and d.posted_entry_id=e.id
        where l.org_id=${c.orgId} and l.account_id=${accountId} and e.status='posted'
          and (d.external_source='industry_demo' or (d.kind in ('vendor_payment','customer_payment') and d.memo like 'Demonstration operating %')) order by d.kind,d.document_number
      `)).rows;
      for (const payment of payments) {
        entries.push({ ...payment, bankTransactionId: `industry-demo:${c.orgId}:${key}:${payment.documentId}` });
        closing += toUnits(payment.amount);
      }
    }
    const csv = ["date,amount,description,reference", ...entries.map(entry => `${entry.date},${entry.amount},${entry.description},${entry.bankTransactionId}`)].join("\n");
    await importStatement({ accountId, source: "csv", statementDate: date, openingBalance: "0.00", closingBalance: fromUnits(closing), currency: c.currency,
      lines: entries.map(entry => ({ postedOn: entry.date, amount: entry.amount, description: entry.description, bankTransactionId: entry.bankTransactionId })),
      sourceEvidence: { content: csv, filename: `${key}-synthetic.csv`, contentType: "text/csv" } }, ctx);
    const reconciliation = await startReconciliation({ accountId, throughDate: date, statementBalance: fromUnits(closing) }, ctx);
    for (const entry of entries) {
      const statement = (await db.execute<{ id: string }>(sql`select id from bank_statement_lines where org_id=${c.orgId} and account_id=${accountId} and bank_transaction_id=${entry.bankTransactionId}`)).rows[0];
      const journal = (await db.execute<{ id: string }>(sql`select id from journal_lines where org_id=${c.orgId} and entry_id=${entry.entryId} and account_id=${accountId}`)).rows;
      if (!statement || journal.length !== 1) throw new SampleCompanyError("Native bank statement or posted cash line could not be read back for matching.");
      await createMatch({ reconciliationId: reconciliation.id, statementLineId: statement.id, journalLineIds: [journal[0]!.id] }, ctx);
    }
    await markReconciled(reconciliation.id, ctx);
  }
}
