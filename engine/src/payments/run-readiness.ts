import { and, eq, inArray, sql } from "drizzle-orm";
import { db, schema, withOrgTransaction } from "../platform/db.ts";
import { evaluateBillsForRelease, recordReleaseCheck, type BillReleaseDecision } from "../compliance/compliance.ts";
import { PaymentError } from "./payment-errors.ts";
import { decryptAccountNumber, loadEftSettings, loadNachaSettings, loadSepaSettings, type EftSettings, type EftSettingsResult } from "./rail-settings.ts";
import { nachaCheckDigit } from "./rail-formatters.ts";
export interface RunBlocker {
  instructionId: string;
  payee: string;
  reason: string;
  /** 'bank' = payee bank details; 'compliance' = subcontractor compliance. */
  source?: "bank" | "compliance";
}

/**
 * Re-evaluate subcontractor compliance for every bill still in a run.
 *
 * A run created on Monday can be released on Friday, by which time a
 * certificate may have lapsed. The control therefore runs again at readiness
 * and at posting — a release is never authorised by a stale evaluation.
 */
export async function paymentRunComplianceDecisions(
  runId: string,
  orgId: string,
): Promise<Array<BillReleaseDecision & { instructionId: string; payee: string }>> {
  const rows = (await db.execute<{
      instruction_id: string;
      payee_party_id: string;
      payee: string;
      document_id: string;
      document_number: string;
      project_id: string | null;
      document_date: string;
      payment_amount: string;
      currency: string;
    }>(sql`
    select i.id as instruction_id, i.payee_party_id, p.display_name as payee,
           d.id as document_id, d.document_number, d.project_id, d.document_date,
           ri.payment_amount, ri.currency
      from payment_run_items ri
      join payment_instructions i on i.id = ri.payment_instruction_id and i.org_id = ri.org_id
      join documents d on d.id = ri.source_document_id and d.org_id = ri.org_id
      join parties p on p.id = i.payee_party_id and p.org_id = i.org_id
     where ri.payment_run_id = ${runId} and ri.org_id = ${orgId}
       and i.status <> 'cancelled' and ri.kind <> 'credit'
  `));
  if (rows.rows.length === 0) return [];
  const decisions = await evaluateBillsForRelease({
    orgId,
    bills: rows.rows.map((r) => ({
      documentId: r.document_id,
      documentNumber: r.document_number,
      partyId: r.payee_party_id,
      vendorName: r.payee,
      projectId: r.project_id,
      documentDate: r.document_date,
      amount: r.payment_amount,
      currency: r.currency,
    })),
  });
  return decisions.map((d, i) => ({
    ...d,
    instructionId: rows.rows[i]!.instruction_id,
    payee: rows.rows[i]!.payee,
  }));
}

/**
 * The bank-file rails that carry payee bank details and therefore gate on the
 * bank-details approval workflow (cheque/positive_pay print no account data).
 */
export type RailBankMethod = "ach" | "sepa" | "eft";

/**
 * The resolved — and control-checked — bank detail one instruction would put
 * on a rail file. `ok:false` carries the exact readiness reason so the run
 * view and every file writer speak the same control language; on success each
 * rail reads its own fields (ach→routingNumber/savings, sepa→iban/bic,
 * eft→institution/transit), all backed by the same decrypted account number.
 */
export type RailBankDetail =
  | { ok: false; reason: string }
  | {
      ok: true;
      routingNumber: string | null;
      iban: string | null;
      bic: string | null;
      institution: string | null;
      transit: string | null;
      accountNumber: string;
      savings: boolean;
    };

type BankDetailRow = {
  approved_at: string | null;
  is_active: boolean | null;
  currency: string;
  routing: Record<string, string> | null;
  account_number_encrypted: string | null;
};

/**
 * Resolve the bank detail a rail export would carry for one instruction, and
 * name the control it fails. This is THE single mechanism behind payee bank
 * evidence: `paymentRunReadiness` shows it as blockers, and every file writer
 * (CPA-005 / NACHA / SEPA) consumes its resolved values — what is displayed,
 * what is blocked, and what is exported can never diverge. An unapproved or
 * inactive revision fails here on every rail.
 */
function resolveRailBankDetail(
  method: RailBankMethod,
  row: BankDetailRow,
): RailBankDetail {
  if (!row.approved_at) return { ok: false, reason: "bank account is not approved" };
  if (!row.is_active) return { ok: false, reason: "bank account is inactive" };
  const routing = row.routing ?? {};
  if (method === "eft" && !/^\d{3}$/.test(routing.institution ?? "")) {
    return { ok: false, reason: "missing/invalid 3-digit institution number" };
  }
  if (method === "eft" && !/^\d{5}$/.test(routing.transit ?? "")) {
    return { ok: false, reason: "missing/invalid 5-digit transit number" };
  }
  if (!row.account_number_encrypted) {
    return { ok: false, reason: "missing account number" };
  }
  const accountNumber = decryptAccountNumber(row.account_number_encrypted);
  const aba = routing.aba ?? routing.routingNumber ?? routing.routing ?? "";
  const iban = (routing.iban ?? accountNumber).replace(/\s/g, "");
  if (
    method === "ach" &&
    (!/^\d{9}$/.test(aba) || nachaCheckDigit(aba.slice(0, 8)) !== aba[8])
  ) {
    return { ok: false, reason: "missing/invalid 9-digit routing number" };
  }
  if (method === "sepa" && !/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(iban)) {
    return { ok: false, reason: "missing/invalid IBAN" };
  }
  if (method === "eft" && row.currency !== "CAD") {
    return { ok: false, reason: `CPA-005 CAD file cannot carry ${row.currency}` };
  }
  return {
    ok: true,
    routingNumber: /^\d{9}$/.test(aba) ? aba : null,
    iban: /^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(iban) ? iban : null,
    bic: routing.bic ?? null,
    institution: routing.institution ?? null,
    transit: routing.transit ?? null,
    accountNumber,
    savings: routing.accountType === "savings",
  };
}

/**
 * Read every payable instruction's bank evidence under one transaction that
 * also validates it, closing the read-validate-export gap for all three rails
 * with one mechanism.
 *
 * Each referenced party_bank_accounts row is locked FOR UPDATE inside the same
 * transaction that resolves its detail. Under READ COMMITTED the locking read
 * re-reads the latest committed version once the lock is granted, so exactly
 * one of two outcomes is possible when a maker edit races an export:
 *
 *   - the edit committed first → this call sees `pending` + inactive and
 *     hard-blocks before anything is rendered; or
 *   - the export locked first → the edit waits behind it and the file carries
 *     the APPROVED revision the run was built against.
 *
 * A pending edit can never be what a payment file contains, and because the
 * validation runs here — before any caller renders bytes or writes artifacts —
 * a blocked export leaves no partial file and no partial audit trail.
 */
export async function lockRunBankEvidence(
  method: RailBankMethod,
  runId: string,
  orgId: string,
): Promise<Array<{ id: string; amount: string; payee: string; documentNumber: string | null; detail: Extract<RailBankDetail, { ok: true }> }>> {
  return withOrgTransaction(orgId, async () => {
    const instructions = (await db.execute<{
        id: string;
        amount: string;
        currency: string;
        payee: string;
        payee_bank_account_id: string | null;
        document_number: string | null;
      }>(sql`
      select i.id, i.amount, i.currency, p.display_name as payee,
             i.payee_bank_account_id, d.document_number
        from payment_instructions i
        join parties p on p.id = i.payee_party_id and p.org_id = i.org_id
        left join documents d on d.id = i.payment_document_id and d.org_id = i.org_id
       where i.payment_run_id = ${runId} and i.org_id = ${orgId} and i.status <> 'cancelled'
       order by p.display_name, i.id
    `));
    if (instructions.rows.length === 0) throw new PaymentError("run has no payable instructions");

    // Deterministic lock acquisition (single statement) keeps concurrent
    // exports of one run from deadlocking each other.
    const bankIds = [
      ...new Set(
        instructions.rows
          .map((r) => r.payee_bank_account_id)
          .filter((id): id is string => id !== null),
      ),
    ];
    const banks = bankIds.length > 0
      ? await db
          .select({
            id: schema.partyBankAccounts.id,
            approvedAt: schema.partyBankAccounts.approvedAt,
            isActive: schema.partyBankAccounts.isActive,
            routing: schema.partyBankAccounts.routing,
            accountNumberEncrypted: schema.partyBankAccounts.accountNumberEncrypted,
          })
          .from(schema.partyBankAccounts)
          .where(and(eq(schema.partyBankAccounts.orgId, orgId), inArray(schema.partyBankAccounts.id, bankIds)))
          .for("update")
      : [];
    const byId = new Map(banks.map((b) => [b.id, b]));

    const evidence: Array<{ id: string; amount: string; payee: string; documentNumber: string | null; detail: Extract<RailBankDetail, { ok: true }> }> = [];
    const blockers: string[] = [];
    for (const r of instructions.rows) {
      const bank = r.payee_bank_account_id ? byId.get(r.payee_bank_account_id) : undefined;
      if (!bank) {
        blockers.push(`${r.payee} (no approved bank account on file)`);
        continue;
      }
      // The CPA-005 currency control keys off the INSTRUCTION's currency — the
      // currency the run actually pays in.
      const detail = resolveRailBankDetail(method, {
        approved_at: bank.approvedAt,
        is_active: bank.isActive,
        currency: r.currency,
        routing: bank.routing,
        account_number_encrypted: bank.accountNumberEncrypted,
      });
      if (!detail.ok) {
        blockers.push(`${r.payee} (${detail.reason})`);
        continue;
      }
      evidence.push({ id: r.id, amount: r.amount, payee: r.payee, documentNumber: r.document_number, detail });
    }
    if (blockers.length > 0) {
      throw new PaymentError(`cannot generate the payment file: ${blockers.join("; ")}`);
    }
    return evidence;
  });
}

/**
 * Everything the run detail view and the file export need to agree on:
 * EFT settings state, per-instruction bank-detail blockers, and subcontractor
 * compliance blockers.
 */
export async function paymentRunReadiness(runId: string, orgId: string): Promise<{
  eft: EftSettingsResult;
  blockers: RunBlocker[];
}> {
  const runInfo = (await db.execute<{ method: string; rail: string | null }>(sql`
    select r.method, f.rail
      from payment_runs r
      left join payment_bank_profiles p on p.id = r.payment_bank_profile_id and p.org_id = r.org_id
      left join payment_formats f on f.id = p.payment_format_id and f.org_id = p.org_id
     where r.id = ${runId} and r.org_id = ${orgId}
  `));
  const method = runInfo.rows[0]?.method;
  let eft: EftSettingsResult;
  if (method === "ach") eft = await loadNachaSettings(orgId, runId) as EftSettingsResult;
  else if (method === "sepa") eft = await loadSepaSettings(orgId, runId) as EftSettingsResult;
  else if (method === "eft") eft = await loadEftSettings(orgId, runId);
  else eft = { ok: true, settings: {} as EftSettings };
  const rows = (await db.execute<{
      id: string;
      payee: string;
      payee_bank_account_id: string | null;
      approved_at: string | null;
      is_active: boolean | null;
      routing: Record<string, string> | null;
      account_number_encrypted: string | null;
      currency: string;
    }>(sql`
    select i.id, p.display_name as payee, i.payee_bank_account_id,
           b.approved_at, b.is_active, b.routing, b.account_number_encrypted, i.currency
      from payment_instructions i
      join parties p on p.id = i.payee_party_id and p.org_id = i.org_id
      left join party_bank_accounts b on b.id = i.payee_bank_account_id and b.org_id = i.org_id
     where i.payment_run_id = ${runId} and i.org_id = ${orgId} and i.status <> 'cancelled'
  `));

  const blockers: RunBlocker[] = [];
  for (const r of rows.rows) {
    if (method === "cheque" || method === "positive_pay") continue;
    if (!r.payee_bank_account_id) {
      blockers.push({ instructionId: r.id, payee: r.payee, reason: "no approved bank account on file" });
      continue;
    }
    // Only the three bank-detail rails carry account evidence; every other
    // method (and any custom value) is gated elsewhere or not at all.
    if (method !== "ach" && method !== "sepa" && method !== "eft") continue;
    const detail = resolveRailBankDetail(method, r);
    if (!detail.ok) {
      blockers.push({ instructionId: r.id, payee: r.payee, reason: detail.reason });
    }
  }
  for (const blocker of blockers) blocker.source = "bank";

  // Compliance is re-evaluated here rather than trusted from run creation, and
  // the outcome is frozen so the run's readiness state is evidenced, not just
  // displayed.
  const compliance = await paymentRunComplianceDecisions(runId, orgId);
  for (const decision of compliance) {
    if (decision.decision === "cleared") continue;
    await recordReleaseCheck({
      orgId,
      partyId: decision.partyId,
      documentId: decision.documentId,
      paymentRunId: runId,
      paymentInstructionId: decision.instructionId,
      stage: "readiness",
      decision: decision.decision,
      snapshot: { compliance: decision.compliance, lienWaiver: decision.lienWaiver, reasons: decision.reasons },
    });
    if (decision.decision !== "blocked") continue;
    blockers.push({
      instructionId: decision.instructionId,
      payee: decision.payee,
      reason: `${decision.documentNumber}: ${decision.reasons.join("; ")}`,
      source: "compliance",
    });
  }
  return { eft, blockers };
}
