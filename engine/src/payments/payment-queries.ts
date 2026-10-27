import { contractorWithholdingScheme } from "../country-tax-packs/index.ts";
import { orgFeatureEnabled } from "../organization/org-feature-lock.ts";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "../platform/db.ts";
import { fromUnits, toUnits } from "../money/money.ts";
import { PaymentError } from "../payments-core/payment-errors.ts";
import { sameCurrencyAllocation, type AllocationInput } from "./settlement-policy.ts";
import {
  type PaymentKind,
  type OpenItemSide,
  type SuggestedApplication,
} from "./payment-contracts.ts";
import { paymentRunVisibleSql } from "../payments-core/payment-run-scope.ts";
import { subsidiaryVisibleFilter } from "../organization/subsidiary-scope.ts";
import { paymentRunReadiness } from "./run-readiness.ts";
import { openItemsForParty, paymentSubsidiaryScope } from "./open-item-queries.ts";

// Open-item and run-reservation readers live in their own modules; their
// public names stay importable from here so callers do not move.
export {
  creditItemsForParty,
  openItemsForParty,
  openItemsForSettlement,
  settlementRateObservations,
} from "./open-item-queries.ts";
export type { SettlementOpenItem, SettlementRateObservation } from "./open-item-queries.ts";
export {
  assertNoForeignRunReservation,
  foreignRunReservations,
  runReservationRefusal,
} from "./run-reservations.ts";
export type { RunReservation } from "./run-reservations.ts";

/** Resolve a party's organization-owned subsidiary boundary for payment routes. */
export async function paymentPartyScope(
  orgId: string,
  partyId: string,
): Promise<{ subsidiaryId: string | null } | null> {
  const rows = await db.execute<{ subsidiaryId: string | null }>(
    sql`
    select subsidiary_id as "subsidiaryId" from parties
     where id = ${partyId} and org_id = ${orgId}
  `,
    "objects",
  );
  return rows[0] ?? null;
}

/** Whether a requested payment subsidiary is active in the organization. */
export async function isActivePaymentSubsidiary(
  orgId: string,
  subsidiaryId: string,
): Promise<boolean> {
  const rows = await db.execute(
    sql`
    select id from subsidiaries
     where org_id = ${orgId} and id = ${subsidiaryId} and is_active
  `,
    "objects",
  );
  return rows.length > 0;
}

/** Resolve the organization-owned payment record used by its API boundary. */
export async function paymentDocumentScope(
  orgId: string,
  documentId: string,
): Promise<{ kind: PaymentKind; subsidiaryId: string | null } | null> {
  const rows = await db.execute<{ kind: PaymentKind; subsidiaryId: string | null }>(
    sql`
    select kind, subsidiary_id as "subsidiaryId" from documents
     where id = ${documentId} and kind in ('vendor_payment', 'customer_payment')
       and org_id = ${orgId}
  `,
    "objects",
  );
  return rows[0] ?? null;
}

/** Resolve a side-matched credit document before reading its settlements. */
export async function creditApplicationDocumentScope(
  orgId: string,
  documentId: string,
  side: OpenItemSide,
): Promise<{ partyId: string | null; subsidiaryId: string | null } | null> {
  const kinds =
    side === "ap" ? ["vendor_credit", "vendor_payment"] : ["customer_credit", "customer_payment"];
  const rows = await db.execute<{ partyId: string | null; subsidiaryId: string | null }>(
    sql`
    select party_id as "partyId", subsidiary_id as "subsidiaryId" from documents
     where id = ${documentId} and org_id = ${orgId}
       and kind in ${kinds}
  `,
    "objects",
  );
  return rows[0] ?? null;
}

/** Resolve the credit side and party for an organization-owned settlement. */
export async function creditApplicationSettlementScope(
  orgId: string,
  applicationId: string,
): Promise<{ kind: string | null; partyId: string | null } | null> {
  const rows = await db.execute<{ kind: string | null; partyId: string | null }>(
    sql`
    select credit.kind, credit.party_id as "partyId"
      from applications a
      join journal_lines jl on jl.id = a.from_line_id and jl.org_id = a.org_id
      join journal_entries je on je.id = jl.entry_id and je.org_id = a.org_id
      left join documents credit
        on credit.id = je.source_document_id and credit.org_id = a.org_id
     where a.id = ${applicationId} and a.org_id = ${orgId}
  `,
    "objects",
  );
  return rows[0] ?? null;
}

/** Payment-link record's legal-entity boundary, filtered to its organization. */
export async function paymentLinkScope(
  orgId: string,
  linkId: string,
): Promise<{ subsidiaryId: string | null } | null> {
  const rows = await db.execute<{ subsidiaryId: string | null }>(
    sql`
    select subsidiary_id as "subsidiaryId" from payment_links
     where id = ${linkId} and org_id = ${orgId}
  `,
    "objects",
  );
  return rows[0] ?? null;
}

/** Invoice's legal-entity boundary for payment-link list and creation. */
export async function paymentLinkDocumentScope(
  orgId: string,
  documentId: string,
): Promise<{ subsidiaryId: string | null } | null> {
  const rows = await db.execute<{ subsidiaryId: string | null }>(
    sql`
    select subsidiary_id as "subsidiaryId" from documents
     where id = ${documentId} and org_id = ${orgId}
  `,
    "objects",
  );
  return rows[0] ?? null;
}

/** Enabled provider names available to create an online payment link. */
export async function paymentLinkProviderOptions(orgId: string): Promise<{ provider: string }[]> {
  return db.execute<{ provider: string }>(
    sql`
    select provider from psp_provider_configs
     where org_id = ${orgId} and is_enabled and acceptance_enabled
       and default_bank_account_id is not null
     order by provider
  `,
    "objects",
  );
}

/** Outbound runs visible to a caller's organization and subsidiary grants. */
export async function listOutboundPaymentRuns(
  orgId: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
): Promise<Record<string, unknown>[]> {
  return db.execute<Record<string, unknown>>(
    sql`
    select r.id, r.run_number, r.status, r.method, r.scheduled_for, r.exported_at, r.created_at,
           a.number as bank_number, a.name as bank_name,
           count(i.id) filter (where i.status <> 'cancelled') as instruction_count,
           coalesce(sum(i.amount) filter (where i.status <> 'cancelled'), 0) as total
      from payment_runs r
      left join accounts a on a.id = r.bank_account_id and a.org_id = r.org_id
      left join payment_instructions i on i.payment_run_id = r.id and i.org_id = r.org_id
     where ${paymentRunVisibleSql(orgId, allowedSubsidiaryIds)} and r.direction = 'outbound'
     group by r.id, a.number, a.name
     order by r.created_at desc
     limit 200
  `,
    "objects",
  );
}

/** Whether every selected bill exists in the organization and allowed entities. */
export async function paymentRunBillsInScope(
  orgId: string,
  documentIds: readonly string[],
  allowedSubsidiaryIds: ReadonlySet<string>,
): Promise<boolean> {
  const rows = await db.execute<{ id: string; subsidiaryId: string | null }>(
    sql`
    select id, subsidiary_id as "subsidiaryId" from documents
     where org_id = ${orgId} and id = any(${`{${documentIds.join(",")}}`}::uuid[])
  `,
    "objects",
  );
  const visibleCount = rows.filter(
    (row) => row.subsidiaryId !== null && allowedSubsidiaryIds.has(row.subsidiaryId),
  ).length;
  return visibleCount === documentIds.length;
}

/** Run header for its detail response, scoped to its owning organization. */
export async function paymentRunDetail(
  orgId: string,
  runId: string,
): Promise<Record<string, unknown> | null> {
  const rows = await db.execute<Record<string, unknown>>(
    sql`
    select r.*, a.number as bank_number, a.name as bank_name
      from payment_runs r
      left join accounts a on a.id = r.bank_account_id and a.org_id = r.org_id
     where r.id = ${runId} and r.org_id = ${orgId}
  `,
    "objects",
  );
  return rows[0] ?? null;
}

/** Lock the visible payee identities before reading a run's instructions. */
export async function lockVisiblePaymentRunPayees(
  orgId: string,
  runId: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
): Promise<{ id: string }[]> {
  return db.execute<{ id: string }>(
    sql`
    select p.id from parties p
     where p.org_id = ${orgId} and p.id in (
       select i.payee_party_id from payment_instructions i
        where i.payment_run_id = ${runId} and i.org_id = ${orgId}
     )
     ${subsidiaryVisibleFilter(sql`p.subsidiary_id`, allowedSubsidiaryIds, { orgWideNull: true })}
     for share of p
  `,
    "objects",
  );
}

/** Instructions whose payees the caller may currently see. */
export async function paymentRunInstructions(
  orgId: string,
  runId: string,
  visiblePayeeIds: ReadonlySet<string> | null,
): Promise<Record<string, unknown>[]> {
  return db.execute<Record<string, unknown>>(
    sql`
    select i.id, i.amount, i.currency, i.status, p.display_name as payee,
           d.id as payment_document_id, d.document_number, d.status as payment_status
      from payment_instructions i
      join parties p on p.id = i.payee_party_id and p.org_id = i.org_id
      left join documents d on d.id = i.payment_document_id and d.org_id = i.org_id
     where i.payment_run_id = ${runId} and i.org_id = ${orgId}
       ${visiblePayeeIds === null ? sql`` : sql`and i.payee_party_id = any (${`{${[...visiblePayeeIds].join(",")}}`}::uuid[])`}
     order by p.display_name
  `,
    "objects",
  );
}

/** Load a run detail response while locking its visible payees for a stable scope view. */
export async function loadPaymentRunDetail(
  orgId: string,
  runId: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
): Promise<{
  run: Record<string, unknown>;
  instructions: Record<string, unknown>[];
  eftConfigured: boolean;
  eftMissing: string[];
  blockers: Awaited<ReturnType<typeof paymentRunReadiness>>["blockers"];
} | null> {
  const run = await paymentRunDetail(orgId, runId);
  if (!run) return null;

  return withOrgTransaction(orgId, async () => {
    const payees = await lockVisiblePaymentRunPayees(orgId, runId, allowedSubsidiaryIds);
    const visiblePayeeIds =
      allowedSubsidiaryIds === null ? null : new Set(payees.map((payee) => payee.id));
    const instructions = await paymentRunInstructions(orgId, runId, visiblePayeeIds);
    const readiness = await paymentRunReadiness(runId, orgId, visiblePayeeIds);
    return {
      run,
      instructions,
      eftConfigured: readiness.eft.ok,
      eftMissing: readiness.eft.ok ? [] : readiness.eft.missing,
      blockers: readiness.blockers,
    };
  });
}

/** Active SFTP destinations compatible with a run's bank profile. */
export async function paymentRunSftpServers(
  orgId: string,
  runId: string,
): Promise<Record<string, unknown>[]> {
  return db.execute<Record<string, unknown>>(
    sql`
    select s.id, s.name from payment_runs r
      join payment_bank_profiles p on p.id = r.payment_bank_profile_id and p.org_id = r.org_id
      join sftp_servers s on s.org_id = r.org_id and s.is_active and (p.sftp_server_id is null or p.sftp_server_id = s.id)
     where r.id = ${runId} and r.org_id = ${orgId} order by s.name
  `,
    "objects",
  );
}

/** Whether a settlement instruction is owned by the addressed run. */
export async function paymentInstructionInRun(
  orgId: string,
  runId: string,
  instructionId: string,
): Promise<boolean> {
  const rows = await db.execute(
    sql`
    select 1 from payment_instructions i join payment_runs r on r.id = i.payment_run_id and r.org_id = i.org_id
     where i.id = ${instructionId} and r.id = ${runId} and r.org_id = ${orgId}
  `,
    "objects",
  );
  return rows.length > 0;
}

/** Latest approved immutable file bytes available for an authorized run. */
export async function latestApprovedPaymentFile(
  orgId: string,
  runId: string,
): Promise<{
  id: string;
  filename: string;
  content_type: string;
  storage_kind: string;
  bytes: Buffer | null;
} | null> {
  const rows = await db.execute<{
    id: string;
    filename: string;
    content_type: string;
    storage_kind: string;
    bytes: Buffer | null;
  }>(
    sql`
    select pf.id, pf.filename, pf.content_type, fv.storage_kind, fb.bytes
      from payment_files pf
      join files fi on fi.id = pf.file_id and fi.org_id = ${orgId}
      join file_versions fv on fv.id = pf.file_version_id and fv.file_id = fi.id
      left join file_blobs fb on fb.version_id = fv.id
     where pf.payment_run_id = ${runId} and pf.org_id = ${orgId}
       and pf.status in ('approved', 'delivered')
     order by pf.sequence_number desc limit 1
  `,
    "objects",
  );
  return rows[0] ?? null;
}

/** File status after creation, constrained to its organization. */
export async function paymentFileStatus(
  orgId: string,
  fileId: string,
): Promise<string | undefined> {
  const rows = await db.execute<{ status: string }>(
    sql`select status from payment_files where id = ${fileId} and org_id = ${orgId}`,
    "objects",
  );
  return rows[0]?.status;
}
/**
 * Automated cash application: propose how an incoming amount settles a party's
 * open items. Prefers a reference-number hit, then an exact single-item match,
 * then oldest-first (FIFO) allocation. Pure over `openItemsForParty`, so the
 * caller confirms and posts via `postPaymentWithApplications`.
 */
export async function suggestApplications(
  partyId: string,
  amount: string,
  side: OpenItemSide = "ar",
  opts?: {
    reference?: string | null;
    sourceCurrency: string;
    orgId?: string;
    allowedSubsidiaryIds?: ReadonlySet<string> | null;
  },
): Promise<SuggestedApplication> {
  if (!opts?.sourceCurrency)
    throw new PaymentError("payment currency is required for automatic application");
  // Automated allocation is intentionally limited to open items already in the
  // payment currency. Cross-currency rows require explicit rate evidence and
  // source/target amounts from the accountant or bank advice.
  // Items a payment run has reserved are that run's to pay, never suggested.
  const items = (
    await openItemsForParty(partyId, side, opts.orgId, opts.allowedSubsidiaryIds)
  ).filter((item) => item.currency === opts.sourceCurrency && item.reservedByRun === null);
  const target = toUnits(amount);
  if (target <= 0n || items.length === 0) {
    return {
      allocations: [],
      applied: "0",
      remaining: fromUnits(target < 0n ? 0n : target),
      strategy: "none",
    };
  }

  // 1) reference match — the payment memo/ref names a specific invoice
  const ref = opts?.reference?.trim().toLowerCase();
  if (ref) {
    const m = items.find(
      (i) =>
        (i.documentNumber ?? "").toLowerCase() === ref ||
        (i.referenceNumber ?? "").toLowerCase() === ref,
    );
    if (m) {
      const take = toUnits(m.transactionOpen) <= target ? toUnits(m.transactionOpen) : target;
      return {
        allocations: [sameCurrencyAllocation(m.lineId, fromUnits(take))],
        applied: fromUnits(take),
        remaining: fromUnits(target - take),
        strategy: "reference",
      };
    }
  }

  // 2) exact single-item match — paid one invoice to the cent
  const exact = items.find((i) => toUnits(i.transactionOpen) === target);
  if (exact) {
    return {
      allocations: [sameCurrencyAllocation(exact.lineId, amount)],
      applied: amount,
      remaining: "0",
      strategy: "exact",
    };
  }

  // 3) FIFO oldest-first (openItemsForParty is ordered by due/posting date),
  // within the oldest item's receivable/payable account: one payment settles
  // one control account, so a mixed suggestion could never post.
  const allocations: AllocationInput[] = [];
  let remaining = target;
  const fifoAccount = items[0]!.accountId;
  for (const i of items.filter((item) => item.accountId === fifoAccount)) {
    if (remaining <= 0n) break;
    const take = toUnits(i.transactionOpen) <= remaining ? toUnits(i.transactionOpen) : remaining;
    if (take > 0n) {
      allocations.push(sameCurrencyAllocation(i.lineId, fromUnits(take)));
      remaining -= take;
    }
  }
  return {
    allocations,
    applied: fromUnits(target - remaining),
    remaining: fromUnits(remaining),
    strategy: allocations.length ? "fifo" : "none",
  };
}

/**
 * Full drawer payload for a payment document: header, stored draft
 * allocations, and (once posted) the live applications with their targets.
 */
export async function loadPaymentDocument(
  id: string,
  kind: PaymentKind,
  orgId: string,
  allowedSubsidiaryIds?: ReadonlySet<string> | null,
) {
  const doc = await db.execute<Record<string, unknown>>(
    sql`
    select d.*, (d.revision_seq)::text as updated_at,
           p.display_name as party_name, e.id as entry_id, e.entry_number,
           ba.id as bank_account_id_line, ba.number as bank_account_number, ba.name as bank_account_name,
           pe.status as posting_effect_status, pe.error as posting_effect_error,
           pe.updated_at::text as posting_effect_updated_at
      from documents d
      left join parties p on p.id = d.party_id and p.org_id = d.org_id
      left join journal_entries e on e.id = d.posted_entry_id and e.org_id = d.org_id
      left join posting_effects pe on pe.document_id = d.id and pe.org_id = d.org_id
      left join document_lines dl on dl.document_id = d.id and dl.org_id = d.org_id and dl.line_number = 1
      left join accounts ba on ba.id = coalesce((d.custom->>'bankAccountId')::uuid, dl.account_id) and ba.org_id = d.org_id
     where d.id = ${id} and d.kind = ${kind} and d.org_id = ${orgId}
       ${paymentSubsidiaryScope(sql`d.subsidiary_id`, allowedSubsidiaryIds)}
  `,
    "objects",
  );
  const row = doc[0];
  if (!row) return null;

  const custom = (row.custom ?? {}) as { bankAccountId?: string; allocations?: AllocationInput[] };
  const applied =
    row.status === "posted" && row.posted_entry_id
      ? await db.execute<Record<string, unknown>>(
          sql`
          select a.id, a.amount, a.source_amount,
                 a.source_transaction_amount, a.source_transaction_currency,
                 a.target_transaction_amount, a.target_transaction_currency,
                 a.settlement_rate, a.settlement_rate_source,
                 a.settlement_rate_reference, a.settlement_fx_rate_id,
                 a.fx_gain_loss_entry_id, a.applied_on,
                 te.entry_number as target_entry_number, te.posting_date as target_posting_date,
                 tl.due_date as target_due_date, abs(tl.amount) as target_amount,
                 abs(tl.txn_amount) as target_transaction_original,
                 td.id as target_document_id, td.document_number as target_document_number,
                 td.kind as target_document_kind, td.reference_number as target_reference_number
            from journal_lines jl
            join applications a on a.from_line_id = jl.id and a.org_id = jl.org_id and a.unapplied_at is null
            join journal_lines tl on tl.id = a.to_line_id and tl.org_id = jl.org_id
            join journal_entries te on te.id = tl.entry_id and te.org_id = tl.org_id
            left join documents td on td.id = te.source_document_id and td.org_id = te.org_id
           where jl.entry_id = ${row.posted_entry_id} and jl.org_id = ${orgId}
           order by te.posting_date, te.entry_number
        `,
          "objects",
        )
      : [];

  return {
    doc: row,
    bankAccountId: custom.bankAccountId ?? null,
    withholdingEnabled:
      kind === "vendor_payment" && (await orgFeatureEnabled(orgId, "contractorWithholding")),
    withholdingAuthorisationRequired:
      Array.isArray((row.custom as { withholdings?: unknown } | null)?.withholdings) &&
      (row.custom as { withholdings: Array<{ schemeCode?: string }> }).withholdings.some(
        (deduction) =>
          contractorWithholdingScheme(deduction.schemeCode ?? "")?.paymentAuthorisation ===
          "required",
      ),
    withholdingAuthorisationCurrency: Array.isArray(
      (row.custom as { withholdings?: unknown } | null)?.withholdings,
    )
      ? ((row.custom as { withholdings: Array<{ schemeCode?: string }> }).withholdings
          .map((deduction) => contractorWithholdingScheme(deduction.schemeCode ?? ""))
          .find((scheme) => scheme?.paymentAuthorisation === "required")?.currency ?? null)
      : null,
    allocations: custom.allocations ?? [],
    applied,
  };
}
