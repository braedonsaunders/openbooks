import { and, eq } from "drizzle-orm";
import { db, schema } from "../platform/db.ts";
import { businessToday } from "../platform/business-date.ts";
import { toUnits } from "../money/money.ts";
import { assertNotSandbox } from "../organization/sandbox-guard.ts";
import { PaymentError } from "./payment-errors.ts";
import { buildCpa005File, type Cpa005Payment } from "./rail-cpa005.ts";
import { buildNachaFile, loadNachaSettings, type NachaEntry } from "./rail-nacha.ts";
import { buildSepaFile, loadSepaSettings } from "./rail-sepa.ts";
import { lockRunBankEvidence, paymentRunReadiness } from "./run-readiness.ts";
// ---------------------------------------------------------------------------
// CPA Standard 005 file
// ---------------------------------------------------------------------------

/**
 * Assemble and build the CPA-005 file for a payment run. Throws PaymentError
 * with every blocking problem (settings or payee bank details) — no partial
 * or fake files. The file creation number derives from the run number
 * sequence, so re-downloading the same run reproduces the same number.
 */
export async function loadCpa005RunFile(
  runId: string,
  orgId: string,
): Promise<{ filename: string; content: string; runNumber: string }> {
  await assertNotSandbox(orgId, "generate EFT payment file");
  const [run] = await db.select().from(schema.paymentRuns).where(and(eq(schema.paymentRuns.id, runId), eq(schema.paymentRuns.orgId, orgId)));
  if (!run) throw new PaymentError("payment run not found");
  if (run.status === "cancelled") throw new PaymentError("run is cancelled");
  if (run.method !== "eft") throw new PaymentError(`CPA-005 export applies to EFT runs, not ${run.method}`);

  const { eft, blockers } = await paymentRunReadiness(runId, orgId);
  if (!eft.ok) {
    throw new PaymentError(
      `EFT origination is not configured on the payment bank profile: ${eft.missing.join(", ")}.`,
    );
  }
  if (blockers.length > 0) {
    throw new PaymentError(
      `cannot generate the EFT file: ${blockers.map((b) => `${b.payee} (${b.reason})`).join("; ")}`,
    );
  }

  // The readiness pass above is advisory display state re-checked for its side
  // effects (compliance release checks); the file itself is built ONLY from
  // evidence locked and re-validated atomically here, so an edit landing
  // between the two stages can never steer the file.
  const evidence = await lockRunBankEvidence("eft", runId, orgId);

  const today = await businessToday(orgId);
  const fundsDate = new Date(`${run.scheduledFor ?? today}T00:00:00`);
  const payments: Cpa005Payment[] = evidence.map((e) => {
    const units = toUnits(e.amount);
    if (units % 100n !== 0n) {
      throw new PaymentError(`instruction for ${e.payee} has sub-cent precision (${e.amount})`);
    }
    return {
      amountCents: units / 100n,
      fundsDate,
      institution: e.detail.institution!,
      transit: e.detail.transit!,
      accountNumber: e.detail.accountNumber,
      payeeName: e.payee,
      crossReference: e.documentNumber ?? e.id.slice(0, 19),
    };
  });

  const numeric = run.runNumber.replace(/\D/g, "");
  const fileCreationNumber = ((Number(numeric || "1") - 1) % 9999) + 1;

  const content = buildCpa005File({
    settings: eft.settings,
    fileCreationNumber,
    fileCreationDate: new Date(`${today}T00:00:00`),
    payments,
  });
  return { filename: `CPA005-${run.runNumber}.txt`, content, runNumber: run.runNumber };
}

// ---------------------------------------------------------------------------
// NACHA (US ACH) — orgs.settings.nacha
// ---------------------------------------------------------------------------

export async function loadNachaRunFile(runId: string, orgId: string): Promise<{ filename: string; content: string; runNumber: string }> {
  await assertNotSandbox(orgId, "generate ACH payment file");
  const [run] = await db.select().from(schema.paymentRuns).where(and(eq(schema.paymentRuns.id, runId), eq(schema.paymentRuns.orgId, orgId)));
  if (!run) throw new PaymentError("payment run not found");
  if (run.status === "cancelled") throw new PaymentError("run is cancelled");
  if (run.method !== "ach") throw new PaymentError(`NACHA export applies to ACH runs, not ${run.method}`);
  const settings = await loadNachaSettings(orgId, runId);
  if (!settings.ok) throw new PaymentError(`ACH origination is not configured on the payment bank profile: ${settings.missing.join(", ")}`);

  // Bank evidence is locked and approval-checked in the same transaction that
  // feeds the file: a concurrent maker edit either waits behind this snapshot
  // (the file carries the approved revision) or committed first (this
  // hard-blocks on its unapproved state). It can never steer the entry data.
  const evidence = await lockRunBankEvidence("ach", runId, orgId);

  const entries: NachaEntry[] = evidence.map((e) => {
    const units = toUnits(e.amount);
    if (units % 100n !== 0n) throw new PaymentError(`instruction for ${e.payee} has sub-cent precision (${e.amount})`);
    return {
      transactionCode: e.detail.savings ? "32" : "22",
      routingNumber: e.detail.routingNumber!,
      accountNumber: e.detail.accountNumber,
      amountCents: units / 100n,
      individualId: (e.documentNumber ?? e.id).slice(0, 15),
      individualName: e.payee,
    };
  });
  const today = await businessToday(orgId);
  const effectiveDate = new Date(`${run.scheduledFor ?? today}T00:00:00`);
  const content = buildNachaFile({ settings: settings.settings, effectiveDate, creationDate: new Date(`${today}T00:00:00`), entries });
  return { filename: `NACHA-${run.runNumber}.ach`, content, runNumber: run.runNumber };
}

// ---------------------------------------------------------------------------
// SEPA — pain.001.001.03 credit transfer, orgs.settings.sepa
// ---------------------------------------------------------------------------

export async function loadSepaRunFile(runId: string, orgId: string): Promise<{ filename: string; content: string; runNumber: string }> {
  await assertNotSandbox(orgId, "generate SEPA payment file");
  const [run] = await db.select().from(schema.paymentRuns).where(and(eq(schema.paymentRuns.id, runId), eq(schema.paymentRuns.orgId, orgId)));
  if (!run) throw new PaymentError("payment run not found");
  if (run.status === "cancelled") throw new PaymentError("run is cancelled");
  if (run.method !== "sepa") throw new PaymentError(`SEPA export applies to SEPA runs, not ${run.method}`);
  const settings = await loadSepaSettings(orgId, runId);
  if (!settings.ok) throw new PaymentError(`SEPA origination is not configured on the payment bank profile: ${settings.missing.join(", ")}`);

  // Same locked-evidence mechanism as the ACH and EFT writers: the creditor
  // IBAN/BIC are resolved from bank rows that were approved and active at the
  // instant of export, or the export fails outright.
  const evidence = await lockRunBankEvidence("sepa", runId, orgId);

  const payments = evidence.map((e) => ({
    endToEndId: e.documentNumber ?? e.id,
    amount: e.amount,
    creditorName: e.payee,
    creditorIban: e.detail.iban!,
    creditorBic: e.detail.bic,
    remittance: e.documentNumber,
  }));
  const today = await businessToday(orgId);
  const content = buildSepaFile({
    settings: settings.settings,
    messageId: `MSG-${run.runNumber}`,
    creationDateTime: `${today}T00:00:00`,
    executionDate: run.scheduledFor ?? today,
    payments,
  });
  return { filename: `SEPA-${run.runNumber}.xml`, content, runNumber: run.runNumber };
}

/** Dispatch a payment run to its bank file by method (eft→CPA-005, ach→NACHA, sepa→pain.001). */
export async function loadRunFile(runId: string, orgId: string): Promise<{ filename: string; content: string; runNumber: string; contentType: string }> {
  const [run] = await db.select().from(schema.paymentRuns).where(and(eq(schema.paymentRuns.id, runId), eq(schema.paymentRuns.orgId, orgId)));
  if (!run) throw new PaymentError("payment run not found");
  if (run.method === "ach") return { ...(await loadNachaRunFile(runId, orgId)), contentType: "text/plain; charset=us-ascii" };
  if (run.method === "sepa") return { ...(await loadSepaRunFile(runId, orgId)), contentType: "application/xml" };
  return { ...(await loadCpa005RunFile(runId, orgId)), contentType: "text/plain; charset=us-ascii" };
}
