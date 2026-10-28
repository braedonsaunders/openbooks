import "server-only";
import {
  lockAndCheckPayrollRunPopulation,
  type PayrollSubsidiaryScope,
} from "@openbooks/engine/payroll/scope";
import { db } from "@openbooks/engine/platform/db";
import { assertPayRunNotStale } from "@openbooks/engine/payroll/readiness";
import { submitAndReleaseIfUngated } from "@openbooks/engine/flows/module";
import { assemblePayRunEvidence } from "../payroll-evidence";

/** Assemble evidence and route a pay run through the configured approval flow. */
export async function submitPayRunForApproval(input: {
  orgId: string;
  userId: string;
  documentId: string;
  allowedSubsidiaryIds: PayrollSubsidiaryScope;
}): Promise<{ ok: true; evidence: unknown; gated: boolean } | { ok: false; error: string }> {
  const { orgId, userId, documentId, allowedSubsidiaryIds } = input;
  await lockAndCheckPayrollRunPopulation(db, orgId, documentId, allowedSubsidiaryIds);
  await assertPayRunNotStale(orgId, documentId, db, allowedSubsidiaryIds);
  const evidence = await assemblePayRunEvidence(orgId, userId, documentId, allowedSubsidiaryIds);
  const submission = await submitAndReleaseIfUngated("pay_run", documentId, userId);
  if (submission.flowError) return { ok: false, error: submission.flowError };
  return { ok: true, evidence, gated: submission.gated };
}
