import { z } from "zod";
import { createHash } from "node:crypto";
import { civilDateInput } from "@/lib/api/civil-date";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { getFile, getFileBlob } from "@/lib/file-cabinet";
import { fileViewer } from "../../../file-cabinet/lib";
import type { Authz } from "../../../../../lib/authz";
import {
  activateBenefitProgram,
  addProgramMembership,
  closeBenefitProgram,
  listBenefitApprovalPolicies,
  listProgramMemberships,
  removeProgramMembership,
  updateBenefitProgram,
  getBenefitProgram,
  settleIncentivePeriod,
  reconcileIncentivePeriod,
  sourceEvidenceNativePreviewDigest,
  recordSourceEvidencedFirstIncentiveAward,
  parseRetainedSourceArtifact,
  combineRetainedSourceClaims,
  type VerifiedSourceArtifact,
  type RetainedSourceArtifactSelection,
} from "@openbooks/engine/hrm/benefits";
import { BenefitsError } from "@openbooks/engine/hrm/benefits/errors";
import { db } from "@openbooks/engine/platform/database";
import { isUuid } from "../../../../../lib/list-params";
import { benefitsErrorResponse } from "../../benefits/_lib";
import { addMemberBody, benefitProgramPatchBody } from "../bodies";

/**
 * One employer-defined program: read, edit a draft or active program, activate, close, or
 * manage membership. Reads need hrm.benefits.read; every move needs
 * hrm.benefits.manage with the employment scope rechecked inside the
 * engine transaction.
 */
export const runtime = "nodejs";

const uuid = z.string().refine(isUuid, "must be a valid id");
const jsonPointer = z
  .string()
  .max(1024)
  .refine((value) => value === "" || value.startsWith("/"), "must be a JSON Pointer");
const sourceFieldPointers = z
  .object({
    sourceRowRefPointer: jsonPointer.optional(),
    amountPointer: jsonPointer.optional(),
    currencyPointer: jsonPointer.optional(),
    periodFromPointer: jsonPointer.optional(),
    periodToPointer: jsonPointer.optional(),
    sourceIssueDatePointer: jsonPointer.optional(),
    sourcePaidDatePointer: jsonPointer.optional(),
  })
  .strict();
const pdfFieldSelection = z.strictObject({
  quote: z.string().min(1).max(4000),
  value: z.string().min(1).max(300),
  format: z.enum([
    "text",
    "decimal",
    "grouped-decimal",
    "iso-date",
    "us-date",
    "iso-timestamp-date",
  ]),
});
const pdfSelection = z.strictObject({
  page: z.number().int().min(1).max(2000),
  anchor: z.string().min(1).max(4000),
  fields: z.strictObject({
    sourceRowRef: pdfFieldSelection.optional(),
    value: pdfFieldSelection.optional(),
    currency: pdfFieldSelection.optional(),
    periodFrom: pdfFieldSelection.optional(),
    periodTo: pdfFieldSelection.optional(),
    sourceIssueDate: pdfFieldSelection.optional(),
    sourcePaidDate: pdfFieldSelection.optional(),
  }),
});
const retainedSourceArtifactInput = z
  .object({
    fileId: uuid,
    versionId: uuid,
    rowPointer: jsonPointer,
    sourceFields: sourceFieldPointers.optional(),
    pdfSelection: pdfSelection.optional(),
  })
  .strict();
const sourceEvidenceAction = z.object({
  expectedProgramRevision: z.number().int().positive(),
  employmentId: uuid,
  periodFrom: civilDateInput(),
  periodTo: civilDateInput(),
  asOf: civilDateInput(),
  sourceEvidenceClass: z.enum(["missing-source-identity", "source-paid-above-native-measure"]),
  sourceArtifacts: z.array(retainedSourceArtifactInput).min(1).max(5),
  nativeCurrencyBasis: z
    .strictObject({ confirmed: z.literal(true), reason: z.string().trim().min(8).max(2000) })
    .optional(),
  requestKey: uuid.optional(),
  expectedNativePreviewDigest: z
    .string()
    .regex(/^[0-9a-f]{64}$/i)
    .optional(),
  governingDecisionAttestation: z
    .object({
      basis: z.string().trim().min(8).max(2000),
      reason: z.string().trim().min(8).max(2000),
      confirmed: z.literal(true),
    })
    .optional(),
  mappingAttestation: z
    .object({
      basis: z.string().trim().min(8).max(2000),
      reason: z.string().trim().min(8).max(2000),
      confirmed: z.literal(true),
    })
    .optional(),
  reason: z.string().trim().min(8).max(2000).optional(),
});
const previewSourceEvidenceAction = sourceEvidenceAction.extend({
  action: z.literal("previewSourceEvidence"),
});
const recordSourceEvidenceFirstAction = sourceEvidenceAction.extend({
  action: z.literal("recordSourceEvidenceFirst"),
  requestKey: uuid,
  expectedNativePreviewDigest: z.string().regex(/^[0-9a-f]{64}$/i),
  mappingAttestation: z.object({
    basis: z.string().trim().min(8).max(2000),
    reason: z.string().trim().min(8).max(2000),
    confirmed: z.literal(true),
  }),
  reason: z.string().trim().min(8).max(2000),
});

type RetainedSourceArtifactInput = z.infer<typeof retainedSourceArtifactInput>;

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isPositiveAmount(value: string): boolean {
  if (!/^-?\d+(?:\.\d{1,4})?$/.test(value)) return false;
  return BigInt(value.replace(".", "")) > 0n;
}

/** Exact 4-place units for advisory preview arithmetic; the engine remeasures authoritatively. */
function units4(value: unknown): bigint | null {
  if (typeof value !== "string" || !/^-?\d+(?:\.\d{1,4})?$/.test(value)) return null;
  const negative = value.startsWith("-");
  const [whole = "0", fraction = ""] = value.replace("-", "").split(".");
  const units = BigInt(whole) * 10000n + BigInt(fraction.padEnd(4, "0"));
  return negative ? -units : units;
}

type PreviewProjectMargin = {
  projects: readonly { shares: readonly { employmentId: string; value: string }[] }[];
  carryForward?: Readonly<Record<string, string>>;
};

function previewProjectMargin(snapshot: Record<string, unknown>): PreviewProjectMargin | null {
  const candidate =
    snapshot.kind === "incentive-measure"
      ? snapshot.projectMargin
      : snapshot.kind === "incentive-native-measure-without-award"
        ? snapshot.measuredSource
        : undefined;
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) return null;
  const margin = candidate as PreviewProjectMargin & { metric?: unknown };
  if (margin.metric !== "project_margin" || !Array.isArray(margin.projects)) return null;
  for (const project of margin.projects) {
    if (!Array.isArray(project?.shares)) return null;
    for (const share of project.shares) {
      if (typeof share?.employmentId !== "string" || units4(share?.value) === null) return null;
    }
  }
  return margin;
}

async function loadRetainedSourceArtifacts(
  authz: Authz,
  inputs: readonly RetainedSourceArtifactInput[],
  nativeCurrency?: string,
): Promise<{
  artifacts: VerifiedSourceArtifact[];
  claims: {
    sourceRowRef: string;
    value: string;
    currency: string;
    periodFrom: string;
    periodTo: string;
    sourceIssueDate: string;
    sourcePaidDate?: string;
  };
}> {
  const artifacts: VerifiedSourceArtifact[] = [];
  const parsedRows: Awaited<ReturnType<typeof parseRetainedSourceArtifact>>[] = [];
  const viewer = fileViewer(authz);
  for (const input of inputs) {
    const file = await getFile(authz.user.orgId, input.fileId.toLowerCase(), viewer);
    if (!file || file.isInactive)
      throw new BenefitsError(
        "NOT_FOUND",
        "selected retained source file is unavailable or outside your Cabinet access",
      );
    const versionId = input.versionId.toLowerCase();
    const version = file.versions.find((entry) => entry.id.toLowerCase() === versionId);
    if (!version || !version.contentHash || !/^[0-9a-f]{64}$/i.test(version.contentHash)) {
      throw new BenefitsError(
        "REFUSED",
        "selected Cabinet version is not retained with a verifiable content hash",
      );
    }
    const blob = await getFileBlob(authz.user.orgId, file.id, viewer, versionId);
    if (
      !blob ||
      blob.versionId.toLowerCase() !== versionId ||
      blob.bytes.length !== version.sizeBytes ||
      sha256(blob.bytes) !== version.contentHash.toLowerCase()
    ) {
      throw new BenefitsError(
        "REFUSED",
        "selected Cabinet version bytes do not match the retained version hash and size",
      );
    }
    if (blob.bytes.length > 10_000_000)
      throw new BenefitsError(
        "REFUSED",
        "selected source file exceeds the supported retained evidence size",
      );
    const parsed = await parseRetainedSourceArtifact(blob.bytes, blob.contentType, input);
    parsedRows.push(parsed);
    const rowObject = parsed.row;
    artifacts.push({
      fileId: file.id.toLowerCase(),
      versionId,
      filename: blob.filename,
      contentType: blob.contentType,
      sha256: version.contentHash.toLowerCase(),
      sizeBytes: blob.bytes.length,
      bytesBase64: blob.bytes.toString("base64"),
      rowPointer: input.rowPointer,
      rowSha256: parsed.rowSha256,
      row: rowObject,
      ...(input.sourceFields ? { sourceFields: input.sourceFields } : {}),
      ...(input.pdfSelection ? { pdfSelection: input.pdfSelection } : {}),
    });
  }
  const claims = combineRetainedSourceClaims(parsedRows, nativeCurrency);
  return { artifacts, claims };
}

export const GET = defineRoute({
  permission: "hrm.benefits.read",
  feature: "hrm",
  params: z.object({ id: z.string().min(1) }),
  handler: async ({ authz: gate, params: routeParams }) => {
    const { id } = routeParams;
    if (!isUuid(id))
      return NextResponse.json({ error: "program id must be a uuid" }, { status: 400 });
    try {
      const program = await getBenefitProgram(db, gate.user.orgId, gate.user.id, id);
      const members = await listProgramMemberships({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        programId: id,
      });
      const approvalPolicies = await listBenefitApprovalPolicies({
        orgId: gate.user.orgId,
        actorId: gate.user.id,
        programId: id,
      });
      return NextResponse.json({ program, members, approvalPolicies });
    } catch (e) {
      return benefitsErrorResponse(e);
    }
  },
});

export const PATCH = defineRoute({
  permission: "hrm.benefits.manage",
  feature: "hrm",
  params: z.object({ id: z.string().min(1) }),
  body: benefitProgramPatchBody,
  handler: async ({ authz: gate, params: routeParams, body }) => {
    const { id } = routeParams;
    if (!isUuid(id))
      return NextResponse.json({ error: "program id must be a uuid" }, { status: 400 });
    const base = { orgId: gate.user.orgId, actorId: gate.user.id, programId: id };
    try {
      switch (body.action) {
        case "update": {
          // The typed body spreads through whole, so an active program's
          // `changeEffectiveFrom` reaches the service beside its reason.
          const program = await updateBenefitProgram({
            ...base,
            ...body,
            scopeIds: body.scopeIds ?? undefined,
            scopeCustomerIds: body.scopeCustomerIds ?? undefined,
            scopeDepartmentIds: body.scopeDepartmentIds ?? undefined,
            scopeExcludedProjectIds: body.scopeExcludedProjectIds ?? undefined,
            sourceAccountIds: body.sourceAccountIds ?? undefined,
            reason: body.reason,
          });
          return NextResponse.json({ program });
        }
        case "activate": {
          const program = await activateBenefitProgram({ ...base, reason: body.reason });
          return NextResponse.json({ program });
        }
        case "close": {
          const program = await closeBenefitProgram({ ...base, reason: body.reason });
          return NextResponse.json({ program });
        }
      }
    } catch (e) {
      return benefitsErrorResponse(e);
    }
  },
});

export const POST = defineRoute({
  permission: "hrm.benefits.manage",
  feature: "hrm",
  params: z.object({ id: z.string().min(1) }),
  body: z.discriminatedUnion("action", [
    z.object({
      action: z.literal("settle"),
      periodFrom: civilDateInput(),
      periodTo: civilDateInput().nullish(),
    }),
    previewSourceEvidenceAction,
    recordSourceEvidenceFirstAction,
    addMemberBody,
    z.object({
      action: z.literal("removeMember"),
      membershipId: z.string().refine(isUuid, "must be a valid id"),
      reason: z.string().trim().min(1).max(2000),
      effectiveTo: civilDateInput().nullish(),
    }),
  ]),
  handler: async ({ authz: gate, params: routeParams, body }) => {
    const { id } = routeParams;
    if (!isUuid(id))
      return NextResponse.json({ error: "program id must be a uuid" }, { status: 400 });
    const base = { orgId: gate.user.orgId, actorId: gate.user.id, programId: id };
    try {
      if (body.action === "settle") {
        const settled = await settleIncentivePeriod({
          orgId: gate.user.orgId,
          actorId: gate.user.id,
          programId: id,
          periodFrom: body.periodFrom,
          periodTo: body.periodTo ?? body.periodFrom,
        });
        return NextResponse.json({ settled });
      }
      if (body.action === "previewSourceEvidence" || body.action === "recordSourceEvidenceFirst") {
        const isAboveNativeMeasure =
          body.sourceEvidenceClass === "source-paid-above-native-measure";
        if (
          isAboveNativeMeasure &&
          !body.sourceArtifacts.some(
            (artifact) =>
              artifact.sourceFields?.sourcePaidDatePointer !== undefined ||
              artifact.pdfSelection?.fields.sourcePaidDate !== undefined,
          )
        ) {
          throw new BenefitsError(
            "INVALID_INPUT",
            "select the issued row's source paid date field for a source-paid-above-native-measure obligation",
          );
        }
        if (
          isAboveNativeMeasure &&
          body.action === "recordSourceEvidenceFirst" &&
          !body.governingDecisionAttestation
        ) {
          throw new BenefitsError(
            "INVALID_INPUT",
            "attest the governing decision with its basis and reason before recording a source payment above the native measure",
          );
        }
        const currentProgram = await getBenefitProgram(db, gate.user.orgId, gate.user.id, id);
        if (currentProgram.revision !== body.expectedProgramRevision) {
          throw new BenefitsError(
            "REFUSED",
            `program revision changed from ${body.expectedProgramRevision} to ${currentProgram.revision} — refresh the native preview and review the retained source rows again`,
          );
        }
        const retained = await loadRetainedSourceArtifacts(
          gate,
          body.sourceArtifacts,
          body.nativeCurrencyBasis ? currentProgram.currency : undefined,
        );
        if (
          retained.claims.periodFrom !== body.periodFrom ||
          retained.claims.periodTo !== body.periodTo
        ) {
          throw new BenefitsError(
            "REFUSED",
            "selected source row earning dates differ from the requested program period",
          );
        }
        if (isAboveNativeMeasure && !retained.claims.sourcePaidDate) {
          throw new BenefitsError(
            "INVALID_INPUT",
            "select the issued row's source paid date field for a source-paid-above-native-measure obligation",
          );
        }
        const native = await reconcileIncentivePeriod({
          orgId: gate.user.orgId,
          actorId: gate.user.id,
          programId: id,
          periodFrom: body.periodFrom,
          periodTo: body.periodTo,
          asOf: body.asOf,
        });
        const nativeSnapshot =
          native.preview?.sourceSnapshot ?? native.nativeMeasureOnly?.sourceSnapshot;
        if (!nativeSnapshot)
          throw new BenefitsError(
            "REFUSED",
            "native period preview has no retained measurement to compare with the source row",
          );
        const measuredFact = nativeSnapshot.measured;
        const nativeMeasuredValue =
          native.preview?.computation.measuredValue ??
          (measuredFact !== null &&
          typeof measuredFact === "object" &&
          !Array.isArray(measuredFact) &&
          typeof (measuredFact as Record<string, unknown>).value === "string"
            ? ((measuredFact as Record<string, unknown>).value as string)
            : null);
        if (nativeMeasuredValue === null)
          throw new BenefitsError(
            "REFUSED",
            "the retained native snapshot has no exact measured value; refresh the native period measurement",
          );
        const target =
          native.preview?.visibleRecipients.find(
            (recipient) => recipient.employmentId === body.employmentId,
          ) ?? null;
        const margin = previewProjectMargin(nativeSnapshot);
        const targetCarryForward = margin?.carryForward?.[body.employmentId] ?? null;
        const affected =
          margin === null
            ? []
            : margin.projects.filter((project) =>
                project.shares.some((share) => share.employmentId === body.employmentId),
              );
        const targetShareTotal = affected.reduce(
          (sum, project) =>
            sum +
            project.shares
              .filter((share) => share.employmentId === body.employmentId)
              .reduce((projectSum, share) => projectSum + (units4(share.value) ?? 0n), 0n),
          0n,
        );
        const canRecordAboveNativeMeasure =
          margin !== null &&
          (target === null || !isPositiveAmount(target.value)) &&
          targetCarryForward !== null &&
          (units4(targetCarryForward) ?? 0n) < 0n &&
          affected.length > 0 &&
          affected.every((project) => project.shares.length === 1) &&
          targetShareTotal < 0n;
        const nativePreview = {
          currentProgramRevision: currentProgram.revision,
          effectivePolicyRevision:
            native.preview?.programRevision ?? native.nativeMeasureOnly!.programRevision,
          digest: sourceEvidenceNativePreviewDigest({
            periodFrom: body.periodFrom,
            periodTo: body.periodTo,
            asOf: body.asOf,
            nativeSnapshot,
          }),
          targetRecipient: target
            ? { value: target.value, capped: target.capped, explanation: target.explanation }
            : null,
          measuredValue: nativeMeasuredValue,
          nativePoolAvailable:
            native.preview !== null && isPositiveAmount(native.preview.computation.totalAwarded),
          targetCarryForward,
          canRecordFirstObligation: isAboveNativeMeasure
            ? canRecordAboveNativeMeasure
            : native.preview !== null &&
              isPositiveAmount(native.preview.computation.totalAwarded) &&
              (target === null || !isPositiveAmount(target.value)),
        };
        const sourceEvidencePreview = {
          sourceRowRef: retained.claims.sourceRowRef,
          sourceRow: retained.artifacts[0]!.row,
          sourceIssueDate: retained.claims.sourceIssueDate,
          ...(retained.claims.sourcePaidDate
            ? { sourcePaidDate: retained.claims.sourcePaidDate }
            : {}),
          periodFrom: retained.claims.periodFrom,
          periodTo: retained.claims.periodTo,
          ...(body.asOf ? { asOf: body.asOf } : {}),
          value: retained.claims.value,
          currency: retained.claims.currency,
          sourceEvidenceClass: body.sourceEvidenceClass,
          ...(body.nativeCurrencyBasis
            ? {
                currencyEvidence: {
                  kind: "reviewed-native-program-payroll-currency",
                  currency: currentProgram.currency,
                  reason: body.nativeCurrencyBasis.reason,
                },
              }
            : {}),
          nativeMeasurementAsOf: body.asOf,
          artifacts: retained.artifacts.map((artifact) => ({
            fileId: artifact.fileId,
            versionId: artifact.versionId,
            filename: artifact.filename,
            sha256: artifact.sha256,
            rowPointer: artifact.rowPointer,
            rowSha256: artifact.rowSha256,
            row: artifact.row,
            ...(artifact.pdfSelection ? { pdfSelection: artifact.pdfSelection } : {}),
          })),
          nativePreview,
        };
        if (body.action === "previewSourceEvidence") {
          return NextResponse.json({ sourceEvidencePreview });
        }
        const recordBase = {
          orgId: gate.user.orgId,
          actorId: gate.user.id,
          programId: id,
          expectedProgramRevision: body.expectedProgramRevision,
          requestKey: body.requestKey,
          employmentId: body.employmentId,
          periodFrom: retained.claims.periodFrom,
          periodTo: retained.claims.periodTo,
          asOf: body.asOf,
          value: retained.claims.value,
          currency: retained.claims.currency,
          ...(body.nativeCurrencyBasis ? { nativeCurrencyBasis: body.nativeCurrencyBasis } : {}),
          sourceIssueDate: retained.claims.sourceIssueDate,
          sourceSystem: "cabinet-retained",
          sourceRowRef: retained.claims.sourceRowRef,
          sourceArtifacts: body.sourceArtifacts.map(
            (artifact): RetainedSourceArtifactSelection => ({
              fileId: artifact.fileId.toLowerCase(),
              versionId: artifact.versionId.toLowerCase(),
              rowPointer: artifact.rowPointer,
              ...(artifact.sourceFields ? { sourceFields: artifact.sourceFields } : {}),
              ...(artifact.pdfSelection ? { pdfSelection: artifact.pdfSelection } : {}),
            }),
          ),
          expectedNativePreviewDigest: body.expectedNativePreviewDigest,
          mappingAttestation: {
            employmentId: body.employmentId,
            basis: body.mappingAttestation.basis,
            reason: body.mappingAttestation.reason,
            confirmed: true as const,
          },
          reason: body.reason,
        };
        const award = isAboveNativeMeasure
          ? await recordSourceEvidencedFirstIncentiveAward({
              ...recordBase,
              sourceEvidenceClass: "source-paid-above-native-measure",
              sourcePaidDate: retained.claims.sourcePaidDate!,
              governingDecisionAttestation: {
                basis: body.governingDecisionAttestation!.basis,
                reason: body.governingDecisionAttestation!.reason,
                confirmed: true,
              },
            })
          : await recordSourceEvidencedFirstIncentiveAward({
              ...recordBase,
              sourceEvidenceClass: "missing-source-identity",
            });
        return NextResponse.json({ award, sourceEvidencePreview });
      }
      if (body.action === "addMember") {
        const member = await addProgramMembership({
          ...base,
          employmentId: body.employmentId,
          reason: body.reason,
          effectiveFrom: body.effectiveFrom,
          effectiveTo: body.effectiveTo ?? null,
          weight: body.weight ?? null,
          role: body.role ?? null,
          excluded: body.excluded === true,
        });
        return NextResponse.json({ member });
      }
      const member = await removeProgramMembership({
        ...base,
        membershipId: body.membershipId,
        reason: body.reason,
        effectiveTo: body.effectiveTo ?? null,
      });
      return NextResponse.json({ member });
    } catch (e) {
      return benefitsErrorResponse(e);
    }
  },
});
