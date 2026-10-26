import { sql } from "drizzle-orm";
import { db, type SqlExecutor } from "../platform/db.ts";
import { assertBillingReleasable, BillingReleaseRefusedError } from "./billing-provenance.ts";
import { projectRetainageHeldSql } from "../projects/construction-billing.ts";
import { add, cmp, neg } from "../money/money.ts";
import { voidRemedyHooks } from "../journal/void-remedy-contributors.ts";
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

/**
 * Un-count a voided pay run.
 *
 * Reversing the GL is not enough for payroll: the payroll subledger is
 * `pay_runs` + `pay_stubs`, and EVERY consumer of it selects on
 * `pay_runs.run_status = 'committed'` with no predicate on the document's
 * status. Leaving a voided run committed therefore keeps it counted in
 * statutory year-to-date (CPP/CPP2/EI room, US wage bases), WCB annual room,
 * the EHT exemption, T4/T4 Summary/W-2/941 and the remittance summary — so the
 * next run under-deducts against consumed room and the CRA is billed for
 * withholdings that no longer exist. One status write retires the run from all
 * of them at once.
 *
 * The two other claims a commit made must also be released:
 *
 * - `time_entries.payroll_batch_ref` — commit stamps the period's approved
 *   hours with the run id so they are never paid twice. If the void left the
 *   stamp, those hours could never be paid at all.
 * - `entitlement_ledger` movements keyed to the run (vacation/banked-hours
 *   accruals and payouts). Balances are SUM(ledger) with no run-status
 *   predicate, so a voided accrual would stay in the employee's bank. These are
 *   REVERSED, not deleted, dated on the same reversal date as the GL entry so
 *   the entitlement liability and its GL account move together.
 *
 * A run that has been PAID needs no special handling here: the payment applies
 * to the run's open net-pay items, so the generic "live payments or credits
 * applied" guard above already refuses the void.
 */
export async function releaseVoidedPayRun(
  tx: Pick<typeof db, "execute">,
  orgId: string,
  documentId: string,
  actorId: string,
): Promise<void> {
  // A posted remittance bill is an AP payment obligation backed by this
  // run's accrued liabilities. Refuse the source void until that bill is
  // itself reversed; otherwise the bill would remain payable after the
  // payroll subledger has been removed from statutory YTD and the next
  // remittance could pay the same money twice. Locking the bill rows gives
  // this check the same ordering as posting's remittance freshness guard.
  const covered = (
    await tx.execute<{ document_number: string }>(
      sql`
    select bill.document_number
      from pay_runs r
      join documents bill
        on bill.org_id = r.org_id and bill.kind = 'vendor_bill' and bill.status = 'posted'
       and bill.custom ? 'payrollRemittance'
       and bill.custom->'payrollRemittance'->>'from' <= r.pay_date::text
       and bill.custom->'payrollRemittance'->>'to' >= r.pay_date::text
     where r.org_id = ${orgId} and r.document_id = ${documentId}
     order by bill.created_at, bill.id
     limit 1
     for update of bill
  `,
      "objects",
    )
  )[0];
  if (covered) {
    throw new DocumentVoidError(
      `this pay run is covered by posted payroll remittance bill ${covered.document_number}; void the remittance bill first`,
    );
  }

  // A voided source with a committed retro top-up double-pays on reissue:
  // refuse while any non-voided dependent retro run is committed. All such
  // rows are locked first in document order; commitPayRun holds this same
  // row to its flip and never locks the source, so either order serializes.
  const dependents = await tx.execute<{
    document_number: string;
    run_status: string;
    doc_status: string;
  }>(
    sql`
    select retro_doc.document_number, rr.run_status, retro_doc.status as doc_status
      from payroll_retro_settlements st
      join pay_runs rr
        on rr.org_id = st.org_id and rr.document_id = st.retro_pay_run_document_id
      join documents retro_doc
        on retro_doc.id = rr.document_id and retro_doc.org_id = rr.org_id
     where st.org_id = ${orgId} and st.source_pay_run_document_id = ${documentId}
       and rr.run_status <> 'voided'
     order by rr.document_id
     for update of rr
  `,
    "objects",
  );
  const blocking = dependents.find(
    (row) => row.run_status === "committed" && row.doc_status !== "voided",
  );
  if (blocking) {
    throw new DocumentVoidError(
      `this pay run is settled by committed retro pay run ${blocking.document_number}; void the retro run first`,
    );
  }

  await voidRemedyHooks
    .require("payroll")
    .releaseRunInputs(tx, { orgId, runDocumentId: documentId });

  const run = await tx.execute<{ document_id: string }>(
    sql`
    update pay_runs
       set run_status = 'voided', updated_at = now(), updated_by = ${actorId}
     where org_id = ${orgId} and document_id = ${documentId}
       and run_status <> 'voided'
     returning document_id
  `,
    "objects",
  );
  if (run.length === 0) return; // already released (idempotent replay)

  await tx.execute(sql`
    update time_entries
       set payroll_batch_ref = null, updated_at = now()
     where org_id = ${orgId} and payroll_batch_ref = ${documentId}
  `);

  // One reversal movement per (run, plan, employee): the unique index
  // entitlement_ledger_run_movement keeps void replay idempotent, and the CAS
  // above already refuses a second void of this run — so a conflict here
  // means some OTHER writer recorded adjustment movements for it, and
  // silently dropping the reversal would leave entitlement balances wrong
  // forever behind a run marked voided. Count the groups the reversal owes
  // and refuse the void (this whole transaction rolls back) if the insert
  // could not write every one of them.
  const owed = (
    await tx.execute<{ n: string }>(
      sql`
    select count(*)::text as n
      from (
        select l.plan_id, l.employee_party_id
          from entitlement_ledger l
         where l.org_id = ${orgId} and l.pay_run_document_id = ${documentId}
           and l.kind <> 'adjustment'
         group by l.org_id, l.plan_id, l.employee_party_id
        having sum(l.amount) <> 0
      ) owed_groups
  `,
      "objects",
    )
  )[0];
  const reversed = await tx.execute<{ id: string }>(
    sql`
    insert into entitlement_ledger
      (org_id, plan_id, employee_party_id, movement_date, amount, hours, kind,
       pay_run_document_id, note, created_by, updated_by)
    select l.org_id, l.plan_id, l.employee_party_id,
           max(l.movement_date),
           -sum(l.amount), -sum(l.hours), 'adjustment', ${documentId},
           'Reversal: voided pay run',
           (select void_requested_by from documents where id = ${documentId} and org_id = ${orgId}),
           (select void_requested_by from documents where id = ${documentId} and org_id = ${orgId})
      from entitlement_ledger l
     where l.org_id = ${orgId} and l.pay_run_document_id = ${documentId}
       and l.kind <> 'adjustment'
     group by l.org_id, l.plan_id, l.employee_party_id
    having sum(l.amount) <> 0
    -- A prior adjustment returns no row and the required reversal count refuses the void below.
    on conflict do nothing
    returning id
  `,
    "objects",
  );
  if (Number(owed?.n ?? 0) !== reversed.length) {
    throw new DocumentVoidError(
      "entitlement adjustments already exist for this pay run, so the void cannot reverse its entitlements once; reload the run and review its entitlement adjustments before voiding",
    );
  }
}
