import { sql } from "drizzle-orm";
import { db, type SqlExecutor } from "../platform/db.ts";
import { assertBillingReleasable, BillingReleaseRefusedError } from "./billing-provenance.ts";
import { projectRetainageHeldSql } from "../projects/construction-billing.ts";
import { add, cmp, neg } from "../money/money.ts";
import { DocumentVoidError } from "./document-void-shared.ts";

/**
 * Retainage lifecycle fence for source reversal. A posted draw invoice/bill
 * whose holdback supports live retainage releases cannot be voided out from
 * under them. Capacity semantics mirror release creation on each side:
 *
 * - Customer: held retainage is GL money (posted + reversed entries net), so
 *   posted releases are already sunk in the held balance and must NOT be
 *   counted again — only pending (not yet posted, not voided) releases can be
 *   stranded. A void that would drive the held balance itself negative is
 *   still refused, because a pending count of zero is greater than negative
 *   availability.
 * - Vendor: held retainage is subledger money (posted billed applications),
 *   which never nets posted releases, so every non-voided release bill counts.
 *
 * Runs inside the caller's void transaction after the document lock is held,
 * taking the same project/subcontract row lock release creation takes, so a
 * concurrent release cannot reserve the support being removed. Draft deletes
 * need no equivalent: drafts never contribute to held money on either side.
 */
export async function assertRetainageDrawVoidable(
  tx: Pick<typeof db, "execute">,
  orgId: string,
  documentId: string,
  doc: Record<string, unknown>,
): Promise<void> {
  const kind = String(doc.kind);
  if (kind !== "customer_invoice" && kind !== "vendor_bill") return;
  if (doc.posted_entry_id == null) return;
  const control = (
    await tx.execute<{ account: string | null }>(
      sql`
    select settings->'controlAccounts'->>${kind === "customer_invoice" ? "retainageReceivable" : "retainagePayable"} as account
      from orgs where id = ${orgId}
  `,
      "objects",
    )
  )[0]?.account;
  if (!control) return;
  if (kind === "customer_invoice") {
    // Support removed, per project: the negative retainage-receivable lines
    // this void reverses. A release invoice carries a positive line, so it
    // never matches and reverses freely.
    const removed = (
      await tx.execute<{ project_id: string; removed: string }>(
        sql`
      select project_id, coalesce(sum(-amount), 0)::text as removed
        from document_lines
       where org_id = ${orgId} and document_id = ${documentId}
         and account_id = ${control}::uuid and amount < 0
       group by project_id
    `,
        "objects",
      )
    ).filter((row) => cmp(row.removed, "0") > 0);
    for (const { project_id: projectId, removed: drawSupport } of removed) {
      await tx.execute(
        sql`select id from projects where org_id = ${orgId} and id = ${projectId} for update`,
      );
      const held = String(
        (
          await tx.execute<{ held: string | number }>(
            projectRetainageHeldSql(orgId, projectId, control),
            "objects",
          )
        )[0]?.held ?? "0",
      );
      const pending = (
        await tx.execute<{ reserved: string; release_number: string | null }>(
          sql`
        select coalesce(sum(d.total), 0)::text as reserved, min(d.document_number) as release_number
          from pay_applications pa
          join documents d on d.id = pa.invoice_document_id and d.org_id = pa.org_id
         where pa.org_id = ${orgId} and pa.project_id = ${projectId} and pa.kind = 'retainage_release'
           and pa.status in ('invoiced', 'posted') and d.status not in ('posted', 'voided')
      `,
          "objects",
        )
      )[0];
      if (cmp(String(pending?.reserved ?? "0"), add(held, neg(drawSupport))) > 0) {
        throw new DocumentVoidError(
          `this application supports retainage release ${pending?.release_number ?? "(pending)"} — reverse the retainage release first`,
        );
      }
    }
    return;
  }
  // Vendor draw bill: support is the billed application's retained amount,
  // which leaves held money when the void returns the application to approved.
  const draws = (
    await tx.execute<{ subcontract_id: string; support: string }>(
      sql`
    select vpa.subcontract_id, coalesce(sum(vpa.retainage_this_period), 0)::text as support
      from vendor_pay_applications vpa
     where vpa.org_id = ${orgId} and vpa.vendor_bill_document_id = ${documentId} and vpa.status = 'billed'
     group by vpa.subcontract_id
  `,
      "objects",
    )
  ).filter((row) => cmp(row.support, "0") > 0);
  for (const { subcontract_id: subcontractId, support: drawSupport } of draws) {
    await tx.execute(
      sql`select id from subcontracts where org_id = ${orgId} and id = ${subcontractId} for update`,
    );
    const balance = (
      await tx.execute<{ held: string; released: string; release_number: string | null }>(
        sql`
      select coalesce(sum(case when d.status = 'posted' then vpa.retainage_this_period else 0 end), 0)::text as held,
             coalesce((select sum(vrr.amount) from vendor_retainage_releases vrr
                        join documents rd on rd.id = vrr.vendor_bill_document_id and rd.org_id = vrr.org_id
                       where vrr.org_id = ${orgId} and vrr.subcontract_id = ${subcontractId} and rd.status <> 'voided'), 0)::text as released,
             (select min(rd.document_number) from vendor_retainage_releases vrr
                join documents rd on rd.id = vrr.vendor_bill_document_id and rd.org_id = vrr.org_id
               where vrr.org_id = ${orgId} and vrr.subcontract_id = ${subcontractId} and rd.status <> 'voided') as release_number
        from vendor_pay_applications vpa
        left join documents d on d.id = vpa.vendor_bill_document_id and d.org_id = vpa.org_id
       where vpa.org_id = ${orgId} and vpa.subcontract_id = ${subcontractId} and vpa.status = 'billed'
    `,
        "objects",
      )
    )[0];
    if (
      cmp(String(balance?.released ?? "0"), add(String(balance?.held ?? "0"), neg(drawSupport))) > 0
    ) {
      throw new DocumentVoidError(
        `this subcontract draw supports retainage release ${balance?.release_number ?? "(pending)"} — reverse the retainage release first`,
      );
    }
  }
}

/** Translate the billing-release fence into a void refusal so its named
 * remedy reaches the operator instead of surfacing as a server error. */
export async function refuseDrawReleaseBehindLaterDraws(
  executor: SqlExecutor,
  orgId: string,
  documentId: string,
): Promise<void> {
  try {
    await assertBillingReleasable(executor, orgId, documentId);
  } catch (error) {
    if (error instanceof BillingReleaseRefusedError)
      throw new DocumentVoidError(error.message, 409);
    throw error;
  }
}

/**
 * A released payroll bank file or fulfilled non-cash benefit locks its pay run against voiding.
 * Runs in the REQUEST path before the reservation, so the operator sees the
 * file number and its remedy instead of the generic draft/status refusal the
 * zero-row reservation falls back to — and again at COMPLETION, which stays
 * the race backstop for a release landing between request and completion.
 * Lock order matches completion (artifact rows first): a release either
 * finishes first and is refused here, or waits until the void makes the run
 * ineligible for release.
 */
export async function refuseUnavailablePayRunVoid(
  executor: Pick<typeof db, "execute">,
  orgId: string,
  documentId: string,
): Promise<void> {
  // Provider fulfillment is independent of a bank payment. Reversing its
  // payroll representation does not revoke the delivered gift or benefit;
  // correction must preserve that issuance evidence and adjust payroll.
  const fulfilled = (
    await executor.execute<{ code: string; external_ref: string }>(
      sql`
    select p.code, a.external_ref from hrm_benefit_awards a
      join hrm_benefit_programs p on p.org_id = a.org_id and p.id = a.program_id
     where a.org_id = ${orgId} and a.pay_run_document_id = ${documentId}
       and a.status = 'delivered' and p.delivery_method = 'external' and a.external_ref is not null
     order by a.id for update of a
  `,
      "objects",
    )
  )[0];
  if (fulfilled)
    throw new DocumentVoidError(
      `this pay run represents fulfilled non-cash benefit ${fulfilled.code} (provider reference ${fulfilled.external_ref}); voiding payroll does not cancel provider fulfillment — record an adjusting benefit award and a correcting payroll run instead`,
    );
  const bankFiles = await executor.execute<{
    file_number: string;
    release_count: number;
  }>(
    sql`
    select f.file_number, f.release_count
      from pay_run_bank_files f
     where f.org_id = ${orgId} and f.pay_run_document_id = ${documentId}
     order by f.file_number, f.id
     for update of f
  `,
    "objects",
  );
  const releasedBankFile = bankFiles.find((file) => file.release_count > 0);
  if (releasedBankFile) {
    throw new DocumentVoidError(
      `this pay run has released EFT bank file ${releasedBankFile.file_number}; record the payment or reverse it at the bank and mark the artifact before voiding`,
    );
  }
}
