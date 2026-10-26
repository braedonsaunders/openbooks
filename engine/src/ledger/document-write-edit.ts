import { sql } from "drizzle-orm";
import { commercialDocumentKindConfig } from "../records/commercial-document-kind.ts";
import { documentRevisionCounterSql } from "../records/revision.ts";
import { db } from "../platform/db.ts";
import { cmp } from "../money/money.ts";
import { runRecordFlows } from "../flows/index.ts";
import {
  captureTransactionAuditSnapshot,
  recordTransactionAudit,
  transactionSnapshotsMatch,
} from "../records/transaction-audit.ts";
import { promoteCrmAccount } from "../crm/crm.ts";
import { docKindConfig } from "../records/document-kinds.ts";
import {
  loadCustomFieldAccessDefs,
  loadFieldDefs,
  UNATTRIBUTED_CUSTOM_FIELD_VIEWER,
  type CustomFieldViewer,
} from "../records/custom-fields.ts";
import { segmentRegistry, validateExtraDims } from "../organization/segments.ts";
import { assertDocumentSegmentDependencies } from "../organization/segment-dependencies.ts";
import { resolveExternalRefPair } from "../records/external-ref.ts";
import type { TenderInput } from "@openbooks/engine/sales/document-tenders";
import {
  DocumentEditError,
  requireDocumentEditRevision,
  runDocumentVersionedTransaction,
} from "../records/document-edit-policy.ts";
import type { DocumentEditInput, DocumentEditCurrent } from "./document-input.ts";
import type {
  DocumentEditContext,
  DocumentTransaction,
  DocumentUpdateFlowEvent,
  GeneratedWithholdingUpdate,
  LockedEditDocument,
  PreparedDocumentLine,
  ValidatedHeaderDims,
} from "./document-write-context.ts";
import {
  applyControlAccountChoice,
  applyFundingOverride,
  assertEditHeaderReferences,
  assertHeaderOnlyEditTaxCurrent,
  mergeSuppliedHeaderCustom,
  resolveEditCurrency,
  writeEditedHeader,
} from "./document-write-header.ts";
import {
  applyCashCloseout,
  applyTillDropLinkage,
  parseSuppliedTenders,
  replaceEditedTenders,
} from "./document-write-cash.ts";
import { prepareEditedLines, type EditedLines } from "./document-write-lines.ts";
import { reattachLineProvenance } from "./document-write-provenance.ts";
import {
  applyInventoryAllowanceSelections,
  applyInventoryReturnSelections,
  assertVendorCreditReturnDispositions,
} from "./document-write-returns.ts";
import {
  applySourceIntegrityGuards,
  assertConversionChildIdentity,
  assertEditDimensions,
  assertLockedDraftEditable,
  planEditFx,
  revalidateNativeGoodsTax,
} from "./document-write-guards.ts";
import { replaceDocumentLines, writeGeneratedWithholdingInputs } from "./document-write-replace.ts";

/**
 * Apply a header + lines edit to a draft posting document: the one writer of a
 * document's header and lines for the drawer, the public API, imports and
 * corrections, so every caller gets the same validation, audit and flows.
 * Approval snapshots and posted history are immutable; rejected records return
 * to draft before editing, and posted corrections use controlled
 * reversals/adjustments. Callers own auth + status/lock guards.
 */
export async function applyDocumentEdit(
  id: string,
  current: DocumentEditCurrent,
  body: DocumentEditInput,
  ctx: DocumentEditContext,
  /**
   * Join a caller-owned transaction instead of opening one: validation reads
   * and the versioned write all ride the caller's tx, so the caller's claim
   * and this edit commit or roll back together. The caller must fire the
   * deferred on_update event itself (see ctx.deferFlows) after committing.
   */
  scope?: { tx: DocumentTransaction },
): Promise<DocumentUpdateFlowEvent | undefined> {
  const prepared = await prepareDocumentEdit(id, current, body, ctx, scope);
  return commitDocumentEdit(prepared, scope);
}

/** A persisted line's flow-relevant fields, read before the lines are replaced. */
type FlowLineSnapshot = {
  lineNumber: number;
  accountId: string | null;
  departmentId: string | null;
  projectId: string | null;
  amount: string;
};

/** Everything a save validated before its write transaction opens. */
interface PreparedDocumentEdit extends EditedLines {
  id: string;
  current: DocumentEditCurrent;
  body: DocumentEditInput;
  ctx: DocumentEditContext;
  orgId: string;
  userId: string;
  customFieldViewer: CustomFieldViewer;
  expectedRevision: ReturnType<typeof requireDocumentEditRevision>;
  currency: string | undefined;
  external: ReturnType<typeof resolveExternalRefPair>;
  segments: Awaited<ReturnType<typeof segmentRegistry>>;
  lineAccessDefs: Awaited<ReturnType<typeof loadCustomFieldAccessDefs>>;
  headerDims: ValidatedHeaderDims;
  headerCustom: Record<string, unknown> | null;
  tenderInputs: TenderInput[] | undefined;
}

/** Validate the header, custom values, cash details and lines; no row is written. */
async function prepareDocumentEdit(
  id: string,
  current: DocumentEditCurrent,
  body: DocumentEditInput,
  ctx: DocumentEditContext,
  scope?: { tx: DocumentTransaction },
): Promise<PreparedDocumentEdit> {
  const cfg =
    ctx.commercialKind === current.kind
      ? commercialDocumentKindConfig(ctx.commercialKind)
      : docKindConfig(current.kind);
  if (!cfg) throw new DocumentEditError(422, `kind "${current.kind}" is not editable`);
  if (current.status !== "draft") {
    throw new DocumentEditError(
      422,
      `a ${current.status} document cannot be edited — return it to draft or create a controlled correction`,
    );
  }
  const { orgId, userId } = ctx;
  const customFieldViewer = ctx.customFieldViewer ?? UNATTRIBUTED_CUSTOM_FIELD_VIEWER;
  const referenceSubsidiaryId = body.subsidiaryId ?? current.subsidiaryId;
  // Reference-account ownership is scoped to the document's subsidiary. With
  // no subsidiary on either side only org-wide accounts apply: interpolating
  // a null id as `${x}::uuid` emits `= ::uuid` and the query dies as a
  // syntax error instead of refusing by name.
  const referenceSubsidiaryScope = referenceSubsidiaryId
    ? sql`(a.subsidiary_id is null or a.subsidiary_id = ${referenceSubsidiaryId}::uuid)`
    : sql`a.subsidiary_id is null`;
  // Validation reads ride the caller's tx when one owns this edit, so they
  // observe the caller's uncommitted claim (the fresh row's own currency);
  // every other read is committed reference data either way.
  const runner = scope?.tx ?? db;

  // Every call edits a row that already exists. Internal create/correction
  // paths read its exact persisted token first; no row shape may authorize a
  // missing revision.
  const expectedRevision = requireDocumentEditRevision(body.expectedUpdatedAt);

  await assertEditHeaderReferences({ current, body, ctx, cfg, runner });
  const currency = await resolveEditCurrency({
    current,
    body,
    orgId,
    runner,
    referenceSubsidiaryId,
  });

  // The external (source, ref) pair is all or nothing: a lone half would
  // slip the dedupe index, so refuse it here with the remedy instead of
  // letting storage answer with a bare constraint code.
  const external = resolveExternalRefPair({
    externalRef: body.externalRef,
    externalSource: body.externalSource,
  });
  if (external.action === "refuse") throw new DocumentEditError(422, external.message);

  // custom-field validation (header + line) against the live definitions
  // applyDocumentEdit can participate in a caller-owned transaction (posted
  // correction initialization). Do not overlap queries on that one pinned
  // node-postgres client; concurrent client.query calls are unsupported and
  // can reorder protocol messages under load.
  const headerDefs = await loadFieldDefs("documents", current.kind);
  const lineDefs = await loadFieldDefs("document_lines", current.kind);
  const headerAccessDefs = await loadCustomFieldAccessDefs("documents", current.kind);
  const lineAccessDefs = await loadCustomFieldAccessDefs("document_lines", current.kind);
  const segments = await segmentRegistry(orgId);
  const headerDims =
    body.extraDims === undefined ? null : validateExtraDims(body.extraDims, segments);
  if (headerDims && !headerDims.ok) throw new DocumentEditError(422, headerDims.error!);
  let headerCustom = await mergeSuppliedHeaderCustom({
    current,
    body,
    orgId,
    headerDefs,
    headerAccessDefs,
    customFieldViewer,
  });
  await assertHeaderOnlyEditTaxCurrent({
    id,
    current,
    body,
    headerCustom,
    currency,
    runner,
    orgId,
  });
  headerCustom = await applyFundingOverride({
    cfg,
    body,
    current,
    headerCustom,
    runner,
    orgId,
    ctx,
    referenceSubsidiaryScope,
  });
  headerCustom = await applyControlAccountChoice({
    body,
    current,
    headerCustom,
    runner,
    orgId,
    ctx,
    referenceSubsidiaryScope,
  });
  const tenderInputs = parseSuppliedTenders(current, body, headerCustom);
  applyTillDropLinkage(current, body, headerCustom);
  await applyCashCloseout({ runner, orgId, id, current, body, tenderInputs, headerCustom });
  const lines = await prepareEditedLines({
    id,
    current,
    body,
    ctx,
    runner,
    referenceSubsidiaryScope,
    currency,
    headerCustom,
    lineDefs,
    segments,
  });
  return {
    id,
    current,
    body,
    ctx,
    orgId,
    userId,
    customFieldViewer,
    expectedRevision,
    currency,
    external,
    segments,
    lineAccessDefs,
    headerDims,
    headerCustom,
    tenderInputs,
    ...lines,
  };
}

/** Lock, revalidate and write the prepared edit in one transaction, then fire or return on_update. */
async function commitDocumentEdit(
  prepared: PreparedDocumentEdit,
  scope?: { tx: DocumentTransaction },
): Promise<DocumentUpdateFlowEvent | undefined> {
  const { id, current, body, ctx, orgId, userId, expectedRevision, totals } = prepared;
  // All writes + the GL-Impact re-materialization happen in one transaction, so
  // a GL edit into a closed period rolls the whole edit back (nothing partial).
  // The row lock and exact revision comparison are the first operations in that same
  // transaction: a concurrent writer cannot slip between the check and the
  // header/line replacement.
  const { preparedLines, oldLines } = await runDocumentVersionedTransaction<
    DocumentTransaction,
    LockedEditDocument,
    WrittenDocumentEdit
  >({
    expectedRevision,
    // A caller-owned tx is joined, not nested: node-postgres cannot overlap
    // queries on one client, and a nested COMMIT would release the caller's
    // claim early.
    transaction: (work) => (scope ? work(scope.tx) : db.transaction(work)),
    lock: async (tx) =>
      (
        await tx.execute<LockedEditDocument>(
          sql`
        select kind, status, party_id as "partyId", subsidiary_id as "subsidiaryId", extra_dims as "extraDims",
               ${documentRevisionCounterSql(sql.raw("revision_seq"))} as "updatedAt"
          from documents
         where id = ${id} and org_id = ${orgId}
         for update
      `,
          "objects",
        )
      )[0] ?? null,
    mutate: (tx, locked) => writeDocumentEdit(tx, locked, prepared),
  });

  // on_update flows fire AFTER the edit commits (unless the caller opts out).
  // The edit-shape data rides on the EVENT (previousTotal / totalChanged /
  // changedFields / changedLineFields). runRecordFlows never throws into the
  // caller and cannot veto the saved edit; it is awaited so it runs inside the
  // caller's RLS org scope.
  if (ctx.runFlows === false) return undefined;
  const updateEvent = documentUpdateFlowEvent({
    current,
    body,
    ctx,
    totals,
    preparedLines,
    oldLines,
  });
  // A caller-owned transaction defers the event: firing now would run flows
  // against an uncommitted row over a separate connection. The caller fires
  // it after its own commit, preserving on_create → on_update order.
  if (ctx.deferFlows) return updateEvent;
  await runRecordFlows(updateEvent, current.kind, id, { orgId, userId });
  return undefined;
}

/** What the edit transaction wrote: the replaced lines (null when the stored lines stay) and the lines it replaced. */
interface WrittenDocumentEdit {
  preparedLines: PreparedDocumentLine[] | null;
  oldLines: FlowLineSnapshot[];
}

/** The steps of one edit inside its locked transaction, in order; every refusal rolls the whole edit back. */
async function writeDocumentEdit(
  tx: DocumentTransaction,
  locked: LockedEditDocument,
  prepared: PreparedDocumentEdit,
): Promise<WrittenDocumentEdit> {
  const {
    id,
    current,
    body,
    ctx,
    orgId,
    userId,
    customFieldViewer,
    currency,
    external,
    segments,
    lineAccessDefs,
    headerDims,
    headerCustom,
    tenderInputs,
    totals,
    entryPlan,
    submittedLineKeys,
  } = prepared;
  let { preparedLines } = prepared;
  const generatedWithholdingUpdates: GeneratedWithholdingUpdate[] = [];
  await assertLockedDraftEditable(tx, { orgId, id, body, current, locked });
  const targetSubsidiaryId = await revalidateNativeGoodsTax(tx, {
    orgId,
    id,
    current,
    body,
    locked,
    currency,
    headerCustom,
    preparedLines,
  });
  await assertEditDimensions(tx, {
    orgId,
    id,
    body,
    locked,
    headerDims,
    preparedLines,
    targetSubsidiaryId,
    segments,
  });
  if (preparedLines && submittedLineKeys) {
    await reattachLineProvenance(tx, {
      orgId,
      id,
      current,
      body,
      preparedLines,
      submittedLineKeys,
      entryPlan,
      lineAccessDefs,
      customFieldViewer,
    });
  }

  // AFTER reattachment: an explicit selection on this save must win over
  // the stored one, or changing a return source would silently keep the
  // old movement while the drawer showed the new one.
  if (preparedLines && body.lines) {
    await applyInventoryReturnSelections(
      tx,
      orgId,
      locked.kind,
      body.partyId ?? locked.partyId,
      body.subsidiaryId ?? locked.subsidiaryId,
      body.lines,
      preparedLines,
    );
    applyInventoryAllowanceSelections(locked.kind, body.lines, preparedLines);
    // RMA inspection creates an unfinished vendor-return draft before
    // the operator chooses its supplier receipt. That initial create is
    // the only save allowed to defer disposition; later line saves still
    // require a receipt or allowance, and posting always requires one.
    if (locked.kind === "vendor_credit" && !ctx.deferVendorReturnDisposition) {
      await assertVendorCreditReturnDispositions(tx, orgId, preparedLines);
    }
  }

  preparedLines = await applySourceIntegrityGuards(tx, {
    orgId,
    id,
    current,
    body,
    currency,
    totals,
    preparedLines,
    submittedLineKeys,
    generatedWithholdingUpdates,
  });
  await assertConversionChildIdentity(tx, { orgId, id, body, currency });
  const fxPlan = await planEditFx(tx, {
    orgId,
    id,
    current,
    body,
    currency,
    targetSubsidiaryId,
  });

  const auditBefore = await captureTransactionAuditSnapshot(tx, id, ctx.orgId);
  await writeGeneratedWithholdingInputs(tx, { ctx, orgId, id, generatedWithholdingUpdates });
  // Read under the document lock for line-level flow change detection.
  const oldLines = await tx.execute<FlowLineSnapshot>(
    sql`
    select line_number as "lineNumber", account_id as "accountId", department_id as "departmentId",
           project_id as "projectId", amount
      from document_lines
     where document_id = ${id} and org_id = ${ctx.orgId}
     order by line_number
  `,
    "objects",
  );

  if (preparedLines) {
    await replaceDocumentLines(tx, {
      orgId,
      userId,
      id,
      preparedLines,
      submittedLineKeys,
      entryPlan,
    });
  }
  await replaceEditedTenders(tx, { orgId, id, userId, ctx, tenderInputs, totals });
  await writeEditedHeader(tx, {
    id,
    orgId,
    userId,
    body,
    external,
    headerDims,
    targetSubsidiaryId,
    currency,
    fxPlan,
    headerCustom,
    totals,
  });
  await establishCustomerParty(tx, { orgId, userId, id, current, body });

  // Segment value dependencies, checked on the saved lines with header
  // defaults inherited, exactly as posting will read them.
  await assertDocumentSegmentDependencies(tx, orgId, id);

  if (auditBefore) {
    const auditAfter = await captureTransactionAuditSnapshot(tx, id, ctx.orgId);
    if (!auditAfter) throw new Error(`document ${id} disappeared during amendment`);
    // A save that changes nothing writes no audit row: the UPDATE above
    // always bumps the write stamps, so the comparison ignores them (and
    // the re-minted line identity of an identical line rewrite) and only
    // material content decides.
    if (!transactionSnapshotsMatch(auditBefore, auditAfter)) {
      await recordTransactionAudit(tx, {
        orgId,
        documentId: id,
        action: "update",
        actorId: userId,
        source: ctx.source,
        reason: body.amendmentReason?.trim(),
        before: auditBefore,
        after: auditAfter,
      });
    }
  }
  return { preparedLines, oldLines };
}

/** An AR document makes its party a customer: core AR state, with CRM on or off. */
async function establishCustomerParty(
  tx: DocumentTransaction,
  args: {
    orgId: string;
    userId: string;
    id: string;
    current: DocumentEditCurrent;
    body: DocumentEditInput;
  },
): Promise<void> {
  const { orgId, userId, id, current, body } = args;
  const effectivePartyId = body.partyId !== undefined ? body.partyId : current.partyId;
  if (
    effectivePartyId &&
    [
      "customer_invoice",
      "customer_credit",
      "customer_payment",
      "cash_sale",
      "cash_refund",
    ].includes(current.kind)
  ) {
    const promotion = await promoteCrmAccount(tx, {
      orgId,
      partyId: effectivePartyId,
      actorId: userId,
      toStage: "customer",
      sourceKind: current.kind,
      sourceId: id,
    });
    // An AR document makes the party a customer: core AR state the
    // hold and limit checks depend on, with CRM on or off.
    if (!promotion.customerRoleActive) {
      throw new Error("customer role was not established while saving the document");
    }
  }
}

/** The on_update event, carrying the edit's shape (previous total, changed header and line fields). */
function documentUpdateFlowEvent(args: {
  current: DocumentEditCurrent;
  body: DocumentEditInput;
  ctx: DocumentEditContext;
  totals: { subtotal: string; taxTotal: string; total: string } | null;
  preparedLines: PreparedDocumentLine[] | null;
  oldLines: FlowLineSnapshot[];
}): DocumentUpdateFlowEvent {
  const { current, body, ctx, totals, preparedLines, oldLines } = args;
  const newTotal = totals?.total ?? current.total;
  const newTaxTotal = totals?.taxTotal ?? current.taxTotal;
  const changedFields: string[] = [];
  if (cmp(newTotal, current.total) !== 0) changedFields.push("total");
  if (cmp(newTaxTotal, current.taxTotal) !== 0) changedFields.push("taxTotal");
  if (body.partyId !== undefined && body.partyId !== current.partyId) changedFields.push("partyId");
  const changedLineFields = new Set<string>();
  if (preparedLines) {
    const maxLen = Math.max(oldLines.length, preparedLines.length);
    for (let i = 0; i < maxLen; i++) {
      const o = oldLines[i];
      const n = preparedLines[i];
      if (!o || !n) {
        changedLineFields.add("accountId").add("departmentId").add("projectId").add("amount");
        break;
      }
      if (o.accountId !== n.accountId) changedLineFields.add("accountId");
      if ((o.departmentId ?? null) !== (n.departmentId ?? null))
        changedLineFields.add("departmentId");
      if ((o.projectId ?? null) !== (n.projectId ?? null)) changedLineFields.add("projectId");
      if (cmp(o.amount, n.amount) !== 0) changedLineFields.add("amount");
    }
  }
  const updateEvent: DocumentUpdateFlowEvent = {
    kind: "on_update",
    source: ctx.source,
    previousTotal: current.total,
    totalChanged: cmp(newTotal, current.total) !== 0,
    changedFields,
    changedLineFields: [...changedLineFields],
    old: { total: current.total, taxTotal: current.taxTotal },
  };
  return updateEvent;
}
