import { sql } from "drizzle-orm";
import { assertWithholdingDepositEdit } from "../contractor-withholding/deposits.ts";
import {
  assertWithholdingRemittanceEdit,
  ContractorWithholdingError,
} from "../contractor-withholding/service.ts";
import { resolveCanadianGoodsTaxes } from "@openbooks/engine/tax";
import {
  assertGeneratedBillingEdit,
  BillingSourceIntegrityError,
} from "../projects/billing-source-integrity.ts";
import { postingPreconditionHooks } from "../journal/posting-preconditions.ts";
import { cmp } from "../money/money.ts";
import { checkProjectsWriteEnabled } from "../organization/feature-state.ts";
import { extraDimsSubsidiaryError, segmentRegistry } from "../organization/segments.ts";
import {
  DOCUMENT_EDIT_REVISION_CONFLICT,
  DocumentEditError,
} from "../records/document-edit-policy.ts";
import type {
  DocumentLineInput,
  DocumentEditInput,
  DocumentEditCurrent,
} from "./document-input.ts";
import { consolidationSourceRefusal } from "../records/consolidation-source-policy.ts";
import {
  DocumentFxError,
  documentFxState,
  planDocumentFxEdit,
  subsidiaryFunctionalCurrency,
  type DocumentFxEditPlan,
} from "./document-fx.ts";
import { effectivePostingDate } from "../journal/posting-contracts.ts";
import type {
  DocumentTransaction,
  GeneratedWithholdingUpdate,
  LockedEditDocument,
  PreparedDocumentLine,
  ValidatedHeaderDims,
} from "./document-write-context.ts";

/** The locked row is still this draft, and attaching a project respects the Projects gate. */
export async function assertLockedDraftEditable(
  tx: DocumentTransaction,
  args: {
    orgId: string;
    id: string;
    body: DocumentEditInput;
    current: DocumentEditCurrent;
    locked: LockedEditDocument;
  },
): Promise<void> {
  const { orgId, id, body, current, locked } = args;
  const consolidationRefusal = await consolidationSourceRefusal(tx, orgId, id);
  if (consolidationRefusal) throw new DocumentEditError(422, consolidationRefusal);
  // Attaching a project makes this draft a Projects disable-blocker
  // (open project documents), so a disable racing this edit must refuse
  // one side or the other. Fenced inside the write transaction, before
  // any write: clearing the project or editing anything else needs no
  // gate.
  if (body.projectId !== undefined && body.projectId !== null) {
    if (!(await checkProjectsWriteEnabled(orgId, tx))) {
      throw new DocumentEditError(422, "Projects feature is disabled");
    }
  }
  if (locked.kind !== current.kind)
    throw new DocumentEditError(409, DOCUMENT_EDIT_REVISION_CONFLICT);
  if (locked.status !== "draft") {
    throw new DocumentEditError(
      422,
      `a ${locked.status} document cannot be edited — return it to draft or create a controlled correction`,
    );
  }
}

/**
 * The subsidiary the edited draft posts to. Native goods tax sources are
 * revalidated under the write lock: a configuration change since preparation refuses.
 */
export async function revalidateNativeGoodsTax(
  tx: DocumentTransaction,
  args: {
    orgId: string;
    id: string;
    current: DocumentEditCurrent;
    body: DocumentEditInput;
    locked: LockedEditDocument;
    currency: string | undefined;
    headerCustom: Record<string, unknown> | null;
    preparedLines: PreparedDocumentLine[] | null;
  },
): Promise<string | null> {
  const { orgId, id, current, body, locked, currency, headerCustom, preparedLines } = args;
  let targetSubsidiaryId = body.subsidiaryId ?? locked.subsidiaryId;
  // Revalidate local statutory sources under the same transaction that
  // replaces the lines. Preflight cannot pin a later configuration edit.
  if (preparedLines) {
    const native = await resolveCanadianGoodsTaxes(
      orgId,
      {
        kind: current.kind,
        subsidiaryId: targetSubsidiaryId,
        documentDate: body.documentDate ?? current.documentDate,
        currency:
          currency ??
          (
            await tx.execute<{ currency: string }>(
              sql`select currency from documents where org_id=${orgId} and id=${id}`,
              "objects",
            )
          )[0]!.currency,
        selection: (headerCustom ?? current.custom)?.canadianGoodsTax,
      },
      preparedLines,
      tx,
    );
    if (!targetSubsidiaryId && native.size)
      targetSubsidiaryId = native.values().next().value!.snapshot.subsidiaryId;
    for (const [index, selected] of native)
      if (preparedLines[index]!.nativeGoodsTax?.fingerprint !== selected.snapshot.fingerprint)
        throw new DocumentEditError(
          409,
          "The native goods tax configuration changed during preparation — reload the invoice, review its supply terms and save it again",
        );
    if (preparedLines.some((line, index) => line.nativeGoodsTax && !native.has(index)))
      throw new DocumentEditError(
        409,
        "The invoice tax policy changed during preparation — reload it and save the intended supply assessment again",
      );
  }
  return targetSubsidiaryId;
}

/** Header and line custom-segment values are valid for the target subsidiary. */
export async function assertEditDimensions(
  tx: DocumentTransaction,
  args: {
    orgId: string;
    id: string;
    body: DocumentEditInput;
    locked: LockedEditDocument;
    headerDims: ValidatedHeaderDims;
    preparedLines: PreparedDocumentLine[] | null;
    targetSubsidiaryId: string | null;
    segments: Awaited<ReturnType<typeof segmentRegistry>>;
  },
): Promise<void> {
  const { orgId, id, body, locked, headerDims, preparedLines, targetSubsidiaryId, segments } = args;
  const effectiveHeaderDims =
    headerDims?.cleaned ??
    (locked.extraDims && typeof locked.extraDims === "object" && !Array.isArray(locked.extraDims)
      ? (locked.extraDims as Record<string, string | null>)
      : {});
  const headerNeedsDimensionCheck =
    (body.subsidiaryId !== undefined && body.subsidiaryId !== locked.subsidiaryId) ||
    body.extraDims !== undefined ||
    preparedLines !== null;
  if (headerNeedsDimensionCheck) {
    const headerDimensionError = await extraDimsSubsidiaryError(
      orgId,
      effectiveHeaderDims,
      targetSubsidiaryId ?? "",
      segments,
      tx,
    );
    if (headerDimensionError) throw new DocumentEditError(422, headerDimensionError);
  }
  if (preparedLines) {
    for (const [index, line] of preparedLines.entries()) {
      const error = await extraDimsSubsidiaryError(
        orgId,
        line.extraDims,
        targetSubsidiaryId ?? "",
        segments,
        tx,
      );
      if (error) throw new DocumentEditError(422, `Line ${index + 1}: ${error}`);
    }
  } else if (body.subsidiaryId !== undefined && body.subsidiaryId !== locked.subsidiaryId) {
    const existingDims = await tx.execute<{ extra_dims: Record<string, string | null> | null }>(
      sql`
          select extra_dims from document_lines
           where org_id = ${orgId} and document_id = ${id}
           order by line_number
           for update
        `,
      "objects",
    );
    for (const [index, line] of existingDims.entries()) {
      const error = await extraDimsSubsidiaryError(
        orgId,
        line.extra_dims ?? {},
        targetSubsidiaryId ?? "",
        segments,
        tx,
      );
      if (error) throw new DocumentEditError(422, `Line ${index + 1}: ${error}`);
    }
  }
}

/**
 * Generated billing, withholding and remittance sources own their lines: each
 * guard refuses a divergent edit, and the result is null when the stored lines stay.
 */
export async function applySourceIntegrityGuards(
  tx: DocumentTransaction,
  args: {
    orgId: string;
    id: string;
    current: DocumentEditCurrent;
    body: DocumentEditInput;
    currency: string | undefined;
    totals: { subtotal: string; taxTotal: string; total: string } | null;
    preparedLines: PreparedDocumentLine[] | null;
    submittedLineKeys: (string | null)[] | null;
    generatedWithholdingUpdates: GeneratedWithholdingUpdate[];
  },
): Promise<PreparedDocumentLine[] | null> {
  const { orgId, id, current, body, currency, totals, submittedLineKeys } = args;
  const { generatedWithholdingUpdates } = args;
  let { preparedLines } = args;
  try {
    const generated = await assertGeneratedBillingEdit(
      tx,
      orgId,
      id,
      { ...body, currency, ...(totals ?? {}) },
      preparedLines,
    );
    // Equivalent editor lines permit header edits, but the source rows own
    // their IDs, billable flags, lineage, and audit metadata. Never replace
    // those rows through the generic editor's smaller column set.
    if (generated) {
      if (preparedLines && current.kind === "vendor_bill") {
        const sourceLines = await tx.execute<{
          id: string;
          treatment: DocumentLineInput["withholdingTreatment"];
          cost: string | null;
        }>(
          sql`
              select id, withholding_treatment as treatment, withholding_materials_cost::text as cost
                from document_lines where org_id=${orgId} and document_id=${id} order by line_number
            `,
          "objects",
        );
        for (let index = 0; index < preparedLines.length; index++) {
          const line = preparedLines[index]!,
            sourceLine = sourceLines[index];
          const changed =
            sourceLine &&
            (sourceLine.treatment !== line.withholdingTreatment ||
              (sourceLine.cost == null
                ? line.withholdingMaterialsCost != null
                : line.withholdingMaterialsCost == null ||
                  cmp(sourceLine.cost, line.withholdingMaterialsCost) !== 0));
          if (!changed) continue;
          if (submittedLineKeys?.[index] !== sourceLine.id)
            throw new DocumentEditError(
              422,
              `Line ${index + 1}: reload the generated bill and retain the line identity before changing withholding inputs`,
            );
          generatedWithholdingUpdates.push({
            id: sourceLine.id,
            treatment: line.withholdingTreatment,
            cost: line.withholdingMaterialsCost,
          });
        }
      }
      preparedLines = null;
    }
  } catch (error) {
    if (error instanceof BillingSourceIntegrityError)
      throw new DocumentEditError(422, error.message);
    throw error;
  }

  try {
    if (
      await assertWithholdingDepositEdit(tx, orgId, id, preparedLines, {
        ...body,
        currency,
        ...(totals ?? {}),
      })
    )
      preparedLines = null;
    if (
      await assertWithholdingRemittanceEdit(tx, orgId, id, preparedLines, {
        ...body,
        currency,
        ...(totals ?? {}),
      })
    )
      preparedLines = null;
  } catch (error) {
    if (error instanceof ContractorWithholdingError)
      throw new DocumentEditError(
        422,
        error.remedy ? `${error.message} ${error.remedy}` : error.message,
      );
    throw error;
  }
  // A remittance bill is generated from its source entity whole: its
  // lines, header currency, and subsidiary are stamped at creation.
  // Any of the three changing refuses by name with the regenerate
  // remedy — including a header-only save that leaves the lines alone.
  const remittance = await postingPreconditionHooks
    .require("payroll")
    .assertRemittanceBillEdit(tx, orgId, id, preparedLines, {
      currency,
      subsidiaryId: body.subsidiaryId,
    });
  if (remittance) preparedLines = null;
  return preparedLines;
}

// Conversion children keep the source order's currency and party: credit
// control relieves order exposure only with same-currency, same-party
// posted billing, so a relabelled child would silently reprice billed
// totals across currencies or release another customer's commitment.
// Refuse a currency or party change away from the source order's
// values; deleting the draft and reconverting restores them.
// Stored uuids compare case-insensitively: the driver returns them
// lowercase, but the match must not depend on that.
export async function assertConversionChildIdentity(
  tx: DocumentTransaction,
  args: { orgId: string; id: string; body: DocumentEditInput; currency: string | undefined },
): Promise<void> {
  const { orgId, id, body, currency } = args;
  const wantedParty =
    body.partyId === undefined
      ? undefined
      : body.partyId === null
        ? null
        : body.partyId.toLowerCase();
  if (currency !== undefined || wantedParty !== undefined) {
    const child = (
      await tx.execute<{ currency: string; partyId: string | null; documentNumber: string }>(
        sql`
          select currency, party_id as "partyId", document_number as "documentNumber"
            from documents
           where id = ${id} and org_id = ${orgId}
        `,
        "objects",
      )
    )[0];
    const storedParty =
      child == null || child.partyId == null
        ? (child?.partyId ?? null)
        : child.partyId.toLowerCase();
    const currencyChange = currency !== undefined && child != null && currency !== child.currency;
    const partyChange = wantedParty !== undefined && child != null && wantedParty !== storedParty;
    if (currencyChange || partyChange) {
      // Only order sources establish conversion provenance. Other 'bills'
      // edges (for example field-ticket billing) are out of scope.
      const sources = await tx.execute<{
        kind: string;
        documentNumber: string;
        currency: string;
        partyId: string | null;
        partyName: string | null;
      }>(
        sql`
            select source.kind, source.document_number as "documentNumber", source.currency,
                   source.party_id as "partyId", party.display_name as "partyName"
              from document_links link
              join documents source
                on source.id = link.from_document_id
               and source.org_id = link.org_id
              left join parties party
                on party.id = source.party_id
               and party.org_id = link.org_id
             where link.org_id = ${orgId}
               and link.to_document_id = ${id}
               and link.link_type in ('bills', 'created_from')
               and source.kind in ('quote', 'sales_order', 'purchase_order')
             order by source.document_number
          `,
        "objects",
      );
      // Any conflicting source refuses: with several edges, picking one
      // to compare against would be arbitrary.
      if (currencyChange) {
        const conflict = sources.find((source) => source.currency !== currency);
        if (conflict) {
          throw new DocumentEditError(
            422,
            `currency cannot be changed from ${child!.currency} to ${currency} on ${child!.documentNumber}: ` +
              `it was converted from ${conflict.kind.replaceAll("_", " ")} ${conflict.documentNumber} (${conflict.currency}) and must keep the source order currency. ` +
              `Delete this draft and reconvert it from ${conflict.documentNumber} to restore the ${conflict.currency} billing.`,
          );
        }
      }
      if (partyChange) {
        const conflict = sources.find(
          (source) =>
            (source.partyId == null ? null : source.partyId.toLowerCase()) !== wantedParty,
        );
        if (conflict) {
          const sourceParty = conflict.partyName ?? "the source order party";
          throw new DocumentEditError(
            422,
            `party cannot be changed on ${child!.documentNumber}: ` +
              `it was converted from ${conflict.kind.replaceAll("_", " ")} ${conflict.documentNumber} and must keep the source order party (${sourceParty}). ` +
              `Delete this draft and reconvert it from ${conflict.documentNumber} to restore the original billing.`,
          );
        }
      }
    }
  }
}

// The explicit rate is decided against the identity the edited draft
// posts with — its currency, legal entity and functional currency, and
// effective posting date — under this transaction's row lock.
export async function planEditFx(
  tx: DocumentTransaction,
  args: {
    orgId: string;
    id: string;
    current: DocumentEditCurrent;
    body: DocumentEditInput;
    currency: string | undefined;
    targetSubsidiaryId: string | null;
  },
): Promise<DocumentFxEditPlan> {
  const { orgId, id, current, body, currency, targetSubsidiaryId } = args;
  let fxPlan: DocumentFxEditPlan;
  try {
    const fx = await documentFxState(tx, orgId, id);
    const fxSubsidiaryId = targetSubsidiaryId ?? null;
    const functionalCurrency =
      fxSubsidiaryId && (fx.evidence || body.explicitFx)
        ? await subsidiaryFunctionalCurrency(tx, orgId, fxSubsidiaryId)
        : null;
    fxPlan = planDocumentFxEdit({
      kind: current.kind,
      input: body.explicitFx,
      stored: fx.evidence,
      identity:
        fxSubsidiaryId && functionalCurrency
          ? {
              currency: currency ?? fx.currency,
              functionalCurrency,
              rateDate: effectivePostingDate({
                postingDate: body.postingDate !== undefined ? body.postingDate : fx.postingDate,
                documentDate: body.documentDate ?? fx.documentDate,
              }),
              subsidiaryId: fxSubsidiaryId,
            }
          : null,
    });
  } catch (error) {
    if (error instanceof DocumentFxError) throw new DocumentEditError(422, error.message);
    throw error;
  }
  return fxPlan;
}
