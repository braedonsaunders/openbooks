import "server-only";
import { db } from "@openbooks/engine/platform/db";
import {
  obligationAttribution,
  previewRevenueRecognition,
  recognitionScopeRowExists,
  revenueContractAttribution,
  runRevenueRecognition,
} from "@openbooks/engine/revenue/recognition";
import { subsidiaryScopeAllows } from "@openbooks/engine/organization/scope";
import { businessToday, isIsoCalendarDate } from "@openbooks/engine/platform/business-date/module";
import { syncProjectRevenueContracts } from "@openbooks/engine/projects/revenue";
import { isUuid } from "@/lib/list-params";

export interface RevenueRecognitionPreviewInput {
  asOfDate?: string | null;
  obligationId?: string | null;
  contractId?: string | null;
  bookId?: string | null;
  periodId?: string | null;
}

export type RevenueRecognitionPreviewOutcome =
  | { ok: true; preview: Awaited<ReturnType<typeof previewRevenueRecognition>> }
  | { ok: false; error: string; field?: string };

async function ownedId(
  orgId: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
  raw: string | null | undefined,
  table:
    "accounting_books" | "accounting_periods" | "performance_obligations" | "revenue_contracts",
): Promise<{ ok: true; id: string | null } | { ok: false }> {
  const id = raw?.trim().toLowerCase() || null;
  if (!id) return { ok: true, id: null };
  if (!isUuid(id)) return { ok: false };
  if (table === "performance_obligations") {
    const attribution = await obligationAttribution(db, orgId, id);
    if (!attribution || !subsidiaryScopeAllows(allowedSubsidiaryIds, attribution.subsidiaryId))
      return { ok: false };
    return { ok: true, id };
  }
  if (table === "revenue_contracts") {
    const attribution = await revenueContractAttribution(db, orgId, id);
    if (!attribution || !subsidiaryScopeAllows(allowedSubsidiaryIds, attribution.subsidiaryId))
      return { ok: false };
    return { ok: true, id };
  }
  const exists = await recognitionScopeRowExists(db, orgId, table, id);
  return exists ? { ok: true, id } : { ok: false };
}

/** Validate scope ids and produce the same read-only preview used by the Run drawer. */
export async function buildRevenueRecognitionPreview(
  orgId: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
  input: RevenueRecognitionPreviewInput,
): Promise<RevenueRecognitionPreviewOutcome> {
  const asOfDate = input.asOfDate?.trim() || (await businessToday(orgId));
  if (!isIsoCalendarDate(asOfDate))
    return { ok: false, error: "invalid_as_of_date", field: "asOfDate" };
  const book = await ownedId(orgId, allowedSubsidiaryIds, input.bookId, "accounting_books");
  if (!book.ok) return { ok: false, error: "book_not_found", field: "bookId" };
  const period = await ownedId(orgId, allowedSubsidiaryIds, input.periodId, "accounting_periods");
  if (!period.ok) return { ok: false, error: "period_not_found", field: "periodId" };
  const obligation = await ownedId(
    orgId,
    allowedSubsidiaryIds,
    input.obligationId,
    "performance_obligations",
  );
  if (!obligation.ok) return { ok: false, error: "obligation_not_found", field: "obligationId" };
  const contract = await ownedId(
    orgId,
    allowedSubsidiaryIds,
    input.contractId,
    "revenue_contracts",
  );
  if (!contract.ok) return { ok: false, error: "contract_not_found", field: "contractId" };

  const allowed = allowedSubsidiaryIds === null ? undefined : [...allowedSubsidiaryIds];
  if (allowed?.length === 0) {
    return {
      ok: true,
      preview: {
        asOfDate,
        obligationId: obligation.id,
        contractId: contract.id,
        bookId: book.id,
        periodId: period.id,
        rows: [],
        postableCount: 0,
        skippedCount: 0,
        totalAmount: "0",
        totalDebits: "0",
        totalCredits: "0",
        balanced: true,
        projectSyncPending: false,
        warnings: [],
        fingerprint: "",
      } as Awaited<ReturnType<typeof previewRevenueRecognition>>,
    };
  }
  return {
    ok: true,
    preview: await previewRevenueRecognition(orgId, {
      asOfDate,
      obligationId: obligation.id ?? undefined,
      contractId: contract.id ?? undefined,
      bookId: book.id ?? undefined,
      periodId: period.id ?? undefined,
      allowedSubsidiaryIds: allowed,
    }),
  };
}

export interface RunRevenueRecognitionInput {
  asOfDate: string;
  obligationId?: string;
  contractId?: string;
  bookId?: string;
  periodId?: string;
  fingerprint?: string;
}

/** Synchronize project contracts when needed, then call the native recognition runner. */
export async function executeRevenueRecognitionRun(
  orgId: string,
  actorId: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
  input: RunRevenueRecognitionInput,
) {
  const allowed = allowedSubsidiaryIds === null ? undefined : [...allowedSubsidiaryIds];
  if (allowed?.length === 0) {
    return {
      posted: 0,
      skipped: 0,
      totalAmount: "0",
      entries: [],
      problems: [],
    };
  }
  const projectSync = input.fingerprint
    ? null
    : await syncProjectRevenueContracts(orgId, actorId, input.asOfDate, undefined, allowed);
  const result = await runRevenueRecognition(
    orgId,
    input.asOfDate,
    actorId,
    input.obligationId,
    allowed,
    input.fingerprint
      ? {
          fingerprint: input.fingerprint,
          scope: {
            asOfDate: input.asOfDate,
            obligationId: input.obligationId,
            contractId: input.contractId,
            bookId: input.bookId,
            periodId: input.periodId,
            allowedSubsidiaryIds: allowed,
          },
        }
      : undefined,
  );
  if (projectSync) {
    result.problems.push(...projectSync.problems);
    if (projectSync.skipped) result.problems.push(projectSync.skipped);
  }
  return result;
}
