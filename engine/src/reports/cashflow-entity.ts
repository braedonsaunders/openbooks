import { sql, type SQL } from "drizzle-orm";
import { subsidiaryVisibleFilter } from "../organization/subsidiary-scope.ts";
import { db, withOrgTransaction } from "../platform/db.ts";

export async function loadCashflowEntityPartyScope(
  orgId: string,
  partyId: string,
): Promise<{ subsidiaryId: string | null } | undefined> {
  return withOrgTransaction(
    orgId,
    async () => {
      const rows = await db.execute<{ subsidiaryId: string | null }>(
        sql`
        select subsidiary_id as "subsidiaryId"
          from parties
         where id = ${partyId} and org_id = ${orgId}
         limit 1
      `,
        "objects",
      );
      return rows[0];
    },
    { readOnly: true },
  );
}

export interface CashflowPaymentMetricRow {
  pid: string;
  days: string | number | null;
  paid: string | number | null;
  func: string | null;
  date: string | null;
}

export interface CashflowRecentPaymentRow {
  doc_id: string;
  doc_kind: string;
  document_number: string | null;
  entry_id: string;
  date: string | null;
  func_amount: string;
  func: string | null;
}

export async function loadCashflowEntityRows(input: {
  orgId: string;
  partyId: string;
  side: "ar" | "ap";
  today: string;
  allowedSubsidiaryIds: ReadonlySet<string> | null;
  statementBook: SQL;
}): Promise<{ payments: CashflowPaymentMetricRow[]; recent: CashflowRecentPaymentRow[] }> {
  return withOrgTransaction(
    input.orgId,
    async () => {
      const accountType = input.side === "ar" ? "asset_receivable" : "liability_payable";
      const settlementKinds =
        input.side === "ar" ? sql`'customer_payment', 'deposit'` : sql`'vendor_payment', 'check'`;
      const [payments, recent] = await Promise.all([
        db.execute<CashflowPaymentMetricRow>(
          sql`
          select pe.source_document_id as pid,
                 sum(ap.amount * (pe.posting_date - be.posting_date))
                   / nullif(sum(ap.amount), 0) as days,
                 sum(ap.amount) as paid,
                 coalesce(psub.base_currency, o.base_currency) as func,
                 pe.posting_date::text as date
            from applications ap
            join journal_lines bl on bl.id = ap.to_line_id and bl.org_id = ap.org_id
            join journal_entries be on be.id = bl.entry_id and be.org_id = ap.org_id
            join journal_lines pl on pl.id = ap.from_line_id and pl.org_id = ap.org_id
            join journal_entries pe on pe.id = pl.entry_id and pe.org_id = ap.org_id
            join accounts ba on ba.id = bl.account_id and ba.org_id = ap.org_id
            join documents sp on sp.id = pe.source_document_id and sp.org_id = ap.org_id
            left join subsidiaries psub on psub.id = pl.subsidiary_id and psub.org_id = ap.org_id
            join orgs o on o.id = ap.org_id
           where ap.org_id = ${input.orgId} and ba.type = ${accountType}
             and ap.unapplied_at is null and bl.party_id = ${input.partyId}
             and pe.posting_date >= ${input.today}::date - interval '12 months'
             and pe.posting_date <= ${input.today}
             and sp.kind in (${settlementKinds})
             ${subsidiaryVisibleFilter(sql`bl.subsidiary_id`, input.allowedSubsidiaryIds)}
             ${subsidiaryVisibleFilter(sql`be.subsidiary_id`, input.allowedSubsidiaryIds)}
             ${subsidiaryVisibleFilter(sql`pl.subsidiary_id`, input.allowedSubsidiaryIds)}
             ${subsidiaryVisibleFilter(sql`pe.subsidiary_id`, input.allowedSubsidiaryIds)}
             ${subsidiaryVisibleFilter(sql`sp.subsidiary_id`, input.allowedSubsidiaryIds)}
           group by pe.source_document_id, coalesce(psub.base_currency, o.base_currency), pe.posting_date
        `,
          "objects",
        ),
        db.execute<CashflowRecentPaymentRow>(
          sql`
          select d.id as doc_id, d.kind as doc_kind, d.document_number, je.id as entry_id,
                 coalesce(d.document_date, d.posting_date)::text as date,
                 round(abs(d.total) * d.fx_rate, 4) as func_amount,
                 coalesce(sub.base_currency, o.base_currency) as func
            from documents d
            join journal_entries je on je.source_document_id = d.id and je.org_id = d.org_id
              and je.status in ('posted', 'reversed') and je.book_id = ${input.statementBook}
            left join subsidiaries sub on sub.id = d.subsidiary_id and sub.org_id = d.org_id
            join orgs o on o.id = d.org_id
           where d.org_id = ${input.orgId} and d.party_id = ${input.partyId}
             and d.voided_at is null and d.status = 'posted'
             and d.kind in (${settlementKinds})
             ${subsidiaryVisibleFilter(sql`d.subsidiary_id`, input.allowedSubsidiaryIds)}
             ${subsidiaryVisibleFilter(sql`je.subsidiary_id`, input.allowedSubsidiaryIds)}
           order by coalesce(d.document_date, d.posting_date) desc
           limit 200
        `,
          "objects",
        ),
      ]);
      return { payments, recent };
    },
    { readOnly: true },
  );
}
