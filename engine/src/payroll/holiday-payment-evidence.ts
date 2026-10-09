import { sql } from "drizzle-orm";
import { actorHasPermission } from "../organization/actor-permissions.ts";
import { actorAllowedSubsidiaryIds } from "../organization/actor-subsidiaries.ts";
import type { SqlExecutor } from "../platform/db.ts";
import { isUuid } from "../platform/uuid.ts";
import { PayrollError } from "./error.ts";
import { requirePayrollFeature } from "./feature-gate.ts";
import { readAdjudicatedHolidayPayment } from "./holiday-payment-contract.ts";
import { bindHolidayPaymentSource, readHolidayPaymentSourceReference, type RetainedHolidayPaymentSource, type SourceBoundHolidayPayment } from "./holiday-payment-source.ts";
import { payrollSubsidiaryInScope } from "./scope.ts";
import { takeEmployeeConfigurationFence } from "./fences.ts";

/** Prepare frozen evidence inside the owning command transaction. The
 * File Cabinet grant callback must use its native ACL resolver in the same
 * organization context. This read grants neither approval nor settlement. */
export async function loadHolidayPaymentEvidence(
  tx: SqlExecutor,
  input: {
    orgId: string;
    actorId: string;
    instruction: unknown;
    source: unknown;
    authorizeFile: (fileId: string) => Promise<boolean>;
  },
): Promise<SourceBoundHolidayPayment & { readonly subsidiaryId: string }> {
  if (!isUuid(input.orgId) || !isUuid(input.actorId) ||
      !await actorHasPermission(tx, input.orgId, input.actorId, "payroll.run")) {
    throw new PayrollError("A signed-in payroll operator is required to propose unpaid holiday pay.");
  }
  await requirePayrollFeature(tx, input.orgId);
  const instruction = readAdjudicatedHolidayPayment(input.instruction);
  const reference = readHolidayPaymentSourceReference(input.source);
  // The payroll configuration fence precedes subject row locks, matching
  // calculation/commit ordering and keeping approval measurements stable.
  await takeEmployeeConfigurationFence(tx, input.orgId, instruction.employeePartyId);
  const party = (await tx.execute<{ subsidiaryId: string | null }>(sql`
    select subsidiary_id as "subsidiaryId" from parties
     where org_id=${input.orgId} and id=${instruction.employeePartyId} for share
  `)).rows[0];
  const scope = await actorAllowedSubsidiaryIds(tx, input.orgId, input.actorId);
  if (!party?.subsidiaryId || !payrollSubsidiaryInScope(scope, party.subsidiaryId)) {
    throw new PayrollError("Select an employee belonging to a legal entity within your payroll authority.");
  }
  if (typeof input.authorizeFile !== "function" || await input.authorizeFile(reference.fileId) !== true) {
    throw new PayrollError("You need File Cabinet read access to the retained holiday instruction before proposing payment.");
  }
  // file_versions has no org_id: the tenant boundary is the joined parent.
  // Older retained versions remain admissible after a replacement upload.
  const retained = (await tx.execute<RetainedHolidayPaymentSource>(sql`
    select f.org_id as "orgId", f.id as "fileId", v.id as "versionId",
           v.version_number as "versionNumber", v.content_hash as "contentHash",
           f.is_inactive as "fileInactive", folder.is_inactive as "folderInactive"
      from files f
      join folders folder on folder.org_id=f.org_id and folder.id=f.folder_id
      join file_versions v on v.file_id=f.id
     where f.org_id=${input.orgId} and f.id=${reference.fileId} and v.id=${reference.versionId}
     for share of f, folder, v
  `)).rows[0] ?? null;
  return { ...bindHolidayPaymentSource(input.orgId, instruction, reference, retained), subsidiaryId: party.subsidiaryId };
}
