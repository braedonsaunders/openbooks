/** Controlled posted-document correction command. Adapters provide draft editing,
 * while the engine owns source locking, revision/scope checks and retained evidence. */
import { sql } from 'drizzle-orm'
import { db, schema, withOrgTransaction } from '../platform/db.ts'
import { actorHasPermission } from '../organization/actor-permissions.ts'
import { acquireOrgFeatureGateLock, lockAndCheckOrgFeature } from '../organization/org-feature-lock.ts'
import { DOC_KIND_FEATURE } from '../records/document-kind-features.ts'
import { documentKindPermissions } from '../records/document-kind-permissions.ts'
import { actorAllowedSubsidiaryIds } from '../organization/actor-subsidiaries.ts'
import { subsidiaryScopeAllows } from '../organization/subsidiary-scope.ts'
import { documentRevisionCounterSql } from '../records/revision.ts'
import {
  DocumentEditError, requireDocumentEditRevision, validateCorrectionReason,
  runDocumentVersionedTransaction, assertNoExistingDocumentCorrection, buildReversalLinkEvidence,
} from '../records/document-edit-policy.ts'
import { requestDocumentVoid, suggestVoidReversalDate } from './document-void.ts'
import { loadDocumentEditCurrent } from './document-service.ts'
import type { DocumentEditInput, DocumentEditCurrent } from './document-input.ts'
import { resolveCoveringPeriod } from '../periods/period-resolution.ts'
import { closeModuleForDocument } from '../periods/period-policy.ts'
import { postEntry } from '../journal/post-entry.ts'
import { nextFreeEntryNumber } from '../records/entry-number.ts'
import { loadFieldDefs } from '../records/custom-fields.ts'
import { neg } from '../money/money.ts'
import {
  postedCorrectionFieldClass,
  type PostedCorrectionOutcome,
} from './posted-correction-fields.ts'
import type { PostEntryLineInput } from '../journal/post-entry.ts'

type DocumentTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0]
export interface CorrectionContext {
  orgId: string
  userId: string
  source: 'ui' | 'api' | 'mcp' | 'assistant' | 'posted_correction'
  runFlows?: boolean
}
/** Transitional editor port: callbacks participate in the ambient organization
 * transaction. No callback may commit, dispatch flows or perform external work. */
export interface CorrectionDraftWriter {
  createDraft(kind: string, options: {
    allowedSubsidiaryIds: ReadonlySet<string> | null
    subsidiaryId: string | null
    runFlows: false
    source: CorrectionContext['source']
  }): Promise<{ id: string; documentNumber: string }>
  applyEdit(id: string, current: DocumentEditCurrent, input: DocumentEditInput,
    context: CorrectionContext): Promise<unknown>
}

/**
 * Named refusal for a posted-document correction the ledger will not take.
 * `code` lets callers branch (the drawer maps the closed-period refusal to
 * localized remedy copy); `remedy` names the supported path forward and is
 * part of the public result the API boundary forwards unchanged.
 */
export type PostedCorrectionRefusalCode = "closed-period" | "no-changes";

export class PostedCorrectionError extends DocumentEditError {
  readonly code: PostedCorrectionRefusalCode;
  readonly remedy: string;
  constructor(status: number, message: string, code: PostedCorrectionRefusalCode, remedy: string) {
    super(status, message);
    this.name = "PostedCorrectionError";
    this.code = code;
    this.remedy = remedy;
  }
}

/** DocumentEditInput keys grouped by the posted-correction column they write. */
const POSTED_METADATA_COLUMNS = {
  memo: "memo",
  referenceNumber: "reference_number",
  internalNotes: "internal_notes",
  workCompletedOn: "work_completed_on",
} as const;

const POSTED_DIMENSION_COLUMNS = {
  departmentId: "department_id",
  projectId: "project_id",
  locationId: "location_id",
  classId: "class_id",
} as const;

type DimensionField = keyof typeof POSTED_DIMENSION_COLUMNS;

function isDimensionField(field: string): field is DimensionField {
  return field in POSTED_DIMENSION_COLUMNS;
}

/** Header scalar body keys compared against the stored source row. */
const POSTED_HEADER_FIELDS = [
  "partyId", "paymentCardId", "documentDate", "dueDate", "postingDate",
  "expectedPayDate", "subsidiaryId", "currency", "billingMethod",
  "isFinalInvoice", "paymentHoldReason", "externalRef", "externalSource",
  ...Object.keys(POSTED_METADATA_COLUMNS),
  ...Object.keys(POSTED_DIMENSION_COLUMNS),
] as const;

/** Line fields whose every change re-books amounts, so any of them is financial.
 * `custom` rides separately: the writer merges supplied keys over the stored
 * bag, so only supplied keys compare (stored-only native evidence is never a
 * touch). `taxAmount` without an override is derived from the code, never a
 * touch on its own. */
const POSTED_LINE_MATERIAL_FIELDS = [
  // taxInputAmount is excluded: it is never operator input (the edit API
  // takes amount, which persists as the input column), so its stored value
  // can never name a touch the body did not also carry as amount.
  "accountId", "itemId", "description", "quantity", "unit", "unitPrice",
  "amount", "taxCodeId", "taxGroupId", "taxAmount",
  "taxOverridden", "partyId", "departmentId", "projectId", "locationId",
  "classId", "workFrom", "workTo",
] as const;

const POSTED_LINE_IDENTITY_FIELDS: ReadonlySet<string> = new Set(["lineId"]);

function normalizeCorrectionScalar(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed === "" ? null : trimmed;
  }
  return value;
}

function normalizeCorrectionDecimal(value: unknown): unknown {
  const scalar = normalizeCorrectionScalar(value);
  if (typeof scalar !== "string") return scalar;
  if (!/^-?\d+(\.\d+)?$/.test(scalar)) return scalar;
  const negated = scalar.startsWith("-");
  const digits = (negated ? scalar.slice(1) : scalar).replace(/^0+(?=\d)/, "").replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
  return `${negated ? "-" : ""}${digits === "" ? "0" : digits}`;
}

function canonicalCorrectionLine(line: Record<string, unknown>): Record<string, unknown> {
  const canonical: Record<string, unknown> = {};
  const overridden = (line.taxOverridden ?? null) === true;
  for (const field of POSTED_LINE_MATERIAL_FIELDS) {
    if (field === "taxAmount" && !overridden) {
      canonical[field] = null;
      continue;
    }
    // Lines replace wholesale (delete + reinsert with ?? null defaults), so
    // an absent key reads as null exactly as the writer persists it. Header
    // fields keep undefined-means-untouched; lines must not.
    const value = line[field] ?? null;
    canonical[field] = ["quantity", "unitPrice", "amount", "taxAmount"].includes(field)
      ? normalizeCorrectionDecimal(value)
      : normalizeCorrectionScalar(value);
  }
  return canonical;
}

/** Supplied line-custom keys the stored bag does not already carry as-is. */
function changedLineCustomKeys(
  line: Record<string, unknown>,
  storedCustom: unknown,
): string[] {
  const supplied = line.custom;
  if (!supplied || typeof supplied !== "object" || Array.isArray(supplied)) return [];
  const stored = (storedCustom && typeof storedCustom === "object" && !Array.isArray(storedCustom)
    ? storedCustom
    : {}) as Record<string, unknown>;
  return Object.entries(supplied as Record<string, unknown>)
    .filter(([, value]) => value !== undefined)
    .filter(([key, value]) => JSON.stringify(value ?? null) !== JSON.stringify(stored[key] ?? null))
    .map(([key]) => `lineCustom.${key}`);
}

function isEmptyCorrectionValue(value: unknown): boolean {
  const scalar = normalizeCorrectionScalar(value);
  if (scalar === null || scalar === false) return true;
  if (Array.isArray(scalar)) return scalar.length === 0;
  if (scalar !== null && typeof scalar === "object") return Object.keys(scalar).length === 0;
  return false;
}

function correctionLineCarriesExtra(line: Record<string, unknown>): boolean {
  return Object.entries(line).some(([key, value]) =>
    !POSTED_LINE_IDENTITY_FIELDS.has(key) &&
    !(POSTED_LINE_MATERIAL_FIELDS as readonly string[]).includes(key) &&
    key !== "custom" &&
    !isEmptyCorrectionValue(value),
  );
}

interface CorrectionSourceHeader {
  kind: string;
  status: string;
  subsidiaryId: string | null;
  documentNumber: string;
  documentDate: string;
  custom: Record<string, unknown>;
  extraDims: Record<string, unknown>;
  [field: string]: unknown;
}

async function loadCorrectionSource(
  runner: { execute: DocumentTransaction["execute"] },
  orgId: string,
  sourceId: string,
): Promise<CorrectionSourceHeader | null> {
  const rows = (await runner.execute<Record<string, unknown>>(sql`
    select kind, status, subsidiary_id as "subsidiaryId",
           document_number as "documentNumber",
           document_date::text as "documentDate",
           posting_date::text as "postingDate", due_date::text as "dueDate",
           expected_pay_date::text as "expectedPayDate",
           party_id as "partyId", payment_card_id as "paymentCardId",
           memo, reference_number as "referenceNumber",
           internal_notes as "internalNotes",
           work_completed_on::text as "workCompletedOn",
           department_id as "departmentId", project_id as "projectId",
           location_id as "locationId", class_id as "classId",
           currency, billing_method as "billingMethod",
           is_final_invoice as "isFinalInvoice",
           payment_hold_reason as "paymentHoldReason",
           external_ref as "externalRef", external_source as "externalSource",
           custom, extra_dims as "extraDims"
      from documents
     where id = ${sourceId} and org_id = ${orgId}
  `)).rows[0] as CorrectionSourceHeader | undefined;
  if (!rows) return null;
  return { ...rows, custom: (rows.custom ?? {}) as Record<string, unknown>, extraDims: (rows.extraDims ?? {}) as Record<string, unknown> };
}

/** Body keys that differ from the stored source row: the correction's touch set. */
function changedCorrectionFields(
  source: CorrectionSourceHeader,
  storedLines: Array<{ canonical: Record<string, unknown>; custom: unknown }>,
  body: DocumentEditInput,
): string[] {
  const changed: string[] = [];
  const input = body as unknown as Record<string, unknown>;
  for (const field of POSTED_HEADER_FIELDS) {
    if (input[field] === undefined) continue;
    const before = normalizeCorrectionScalar(source[field]);
    const after = normalizeCorrectionScalar(input[field]);
    if (JSON.stringify(before) !== JSON.stringify(after)) changed.push(field);
  }
  if (input.extraDims !== undefined &&
      JSON.stringify(input.extraDims ?? {}) !== JSON.stringify(source.extraDims)) {
    changed.push("extraDims");
  }
  // The writer merges supplied custom keys over the stored bag, so only
  // supplied keys compare: stored-only native evidence is never a touch.
  if (input.custom !== undefined && typeof input.custom === "object" && input.custom !== null) {
    const custom = input.custom as Record<string, unknown>;
    for (const key of Object.keys(custom)) {
      if (custom[key] === undefined) continue;
      if (JSON.stringify(custom[key] ?? null) !== JSON.stringify(source.custom[key] ?? null)) {
        changed.push(`custom.${key}`);
      }
    }
  }
  if (input.lines !== undefined && Array.isArray(input.lines)) {
    const lines = input.lines as Array<Record<string, unknown>>;
    const sameLength = lines.length === storedLines.length;
    // storedLines pairs the canonical material shape with the raw custom
    // bag; line custom merges supplied-only like the header bag, so only
    // supplied keys compare (stored-only native evidence is never a touch).
    const sameShape = sameLength && lines.every((line, index) => {
      const stored = storedLines[index] as { canonical: Record<string, unknown>; custom: unknown };
      return JSON.stringify(canonicalCorrectionLine(line)) === JSON.stringify(stored.canonical) &&
        changedLineCustomKeys(line, stored.custom).length === 0 &&
        !correctionLineCarriesExtra(line);
    });
    if (!sameShape) changed.push("lines");
  }
  if (input.unsplitDistributionGroups !== undefined &&
      Array.isArray(input.unsplitDistributionGroups) &&
      input.unsplitDistributionGroups.length > 0) {
    changed.push("lines");
  }
  return [...new Set(changed)];
}

interface PostedCorrectionPlan {
  sourceId: string;
  outcome: PostedCorrectionOutcome;
  /** Changed fields grouped by class; empty when nothing material changed. */
  changedFields: string[];
  metadataFields: string[];
  /** Normalized incoming values for every touched metadata and dimension field. */
  metadataAfter: Record<string, unknown>;
  dimensionAfter: Partial<Record<DimensionField, string | null>>;
  dimensionFields: DimensionField[];
  headerOnlyDimensions: DimensionField[];
  reclassDimensions: Array<{ field: DimensionField; before: string; after: string }>;
  customMetadata: Record<string, unknown>;
  source: CorrectionSourceHeader;
  reason: string;
}

/**
 * Classify a posted-document amendment without writing anything: the
 * authoritative touch set the executors and the UI consequence preview share.
 * Dimension fields split by whether posted legs carry the dimension — a
 * header-only link corrects in place, carried dimensions move through a
 * balanced reclass entry.
 */
export async function planPostedCorrection(
  sourceId: string,
  body: DocumentEditInput,
  orgId: string,
): Promise<PostedCorrectionPlan> {
  const reason = validateCorrectionReason(body.amendmentReason);
  const source = await loadCorrectionSource(db, orgId, sourceId);
  if (!source) throw new DocumentEditError(404, "not found");
  if (source.status !== "posted") {
    throw new DocumentEditError(422, "only a posted document can create a correcting replacement");
  }
  const storedLines = (await db.execute<Record<string, unknown>>(sql`
    select account_id as "accountId", item_id as "itemId", description,
           quantity::text as quantity, unit, unit_price::text as "unitPrice",
           amount::text as amount, tax_code_id as "taxCodeId",
           tax_group_id as "taxGroupId", tax_input_amount::text as "taxInputAmount",
           tax_amount::text as "taxAmount", tax_overridden as "taxOverridden",
           party_id as "partyId", department_id as "departmentId",
           project_id as "projectId", location_id as "locationId",
           class_id as "classId", work_from::text as "workFrom",
           work_to::text as "workTo", coalesce(custom, '{}'::jsonb) as "custom"
      from document_lines
     where org_id = ${orgId} and document_id = ${sourceId}
     order by line_number, id
  `)).rows.map((row) => ({
    // The edit API takes the gross input amount, which persists as
    // tax_input_amount; the net amount column is derived from it. An
    // untouched inclusive-tax row round-trips gross-to-gross, so the
    // canonical amount compares against the input column, never the net.
    canonical: canonicalCorrectionLine({ ...row, amount: row.taxInputAmount ?? row.amount }),
    custom: row.custom,
  }));
  const changed = changedCorrectionFields(source, storedLines, body);
  const defs = await loadFieldDefs("documents", source.kind);
  const defKeys = new Set(defs.map((def) => def.key));
  const classes = new Map(changed.map((field) => [field, postedCorrectionFieldClass(field, defKeys)]));
  if ([...classes.values()].some((value) => value === "financial")) {
    return {
      sourceId, outcome: "void-and-reissue", changedFields: changed,
      metadataFields: [], metadataAfter: {}, dimensionAfter: {},
      dimensionFields: [], headerOnlyDimensions: [],
      reclassDimensions: [], customMetadata: {}, source, reason,
    };
  }
  const metadataFields = changed.filter((field) => classes.get(field) === "metadata");
  const dimensionFields = changed.filter(isDimensionField);
  const metadataAfter: Record<string, unknown> = {};
  for (const field of metadataFields) {
    metadataAfter[field] = normalizeCorrectionScalar((body as unknown as Record<string, unknown>)[field]);
  }
  const dimensionAfter: Partial<Record<DimensionField, string | null>> = {};
  for (const field of dimensionFields) {
    dimensionAfter[field] = normalizeCorrectionScalar((body as unknown as Record<string, unknown>)[field]) as string | null;
  }
  const customMetadata: Record<string, unknown> = {};
  for (const field of changed) {
    if (field.startsWith("custom.") && classes.get(field) === "metadata") {
      customMetadata[field.slice("custom.".length)] = (body.custom as Record<string, unknown>)[field.slice("custom.".length)];
    }
  }
  if (changed.length === 0) {
    throw new PostedCorrectionError(
      422,
      "the amendment carries no changes — nothing was written",
      "no-changes",
      "edit a field before saving the correction",
    );
  }
  const headerOnlyDimensions: DimensionField[] = [];
  const reclassDimensions: Array<{ field: DimensionField; before: string; after: string }> = [];
  for (const field of dimensionFields) {
    const before = normalizeCorrectionScalar(source[field]) as string | null;
    const after = normalizeCorrectionScalar((body as unknown as Record<string, unknown>)[field]) as string | null;
    if (before === after || before == null || after == null) {
      headerOnlyDimensions.push(field);
      continue;
    }
    const carried = (await db.execute<{ found: number }>(sql`
      select 1 as found
        from journal_lines line
        join journal_entries entry
          on entry.id = line.entry_id and entry.org_id = line.org_id
       where entry.org_id = ${orgId} and entry.source_document_id = ${sourceId}
         and entry.status = 'posted'
         and ${sql.raw(`line.${POSTED_DIMENSION_COLUMNS[field]}`)} = ${before}
       limit 1
    `)).rows.length > 0;
    if (carried) reclassDimensions.push({ field, before, after });
    else headerOnlyDimensions.push(field);
  }
  return {
    sourceId,
    outcome: reclassDimensions.length > 0 ? "reclass" : "metadata-correction",
    changedFields: changed, metadataFields, metadataAfter, dimensionAfter,
    dimensionFields, headerOnlyDimensions, reclassDimensions,
    customMetadata, source, reason,
  };
}

/**
 * Refuse a ledger-moving correction whose original period is closed. The
 * reversal belongs to the entry's own date and period — the same rule the
 * void action defaults to — so a closed original period refuses with the
 * controlled-reopen remedy instead of voiding revenue into another period
 * (and another fiscal year) by default.
 */
export async function refuseClosedOriginalPeriod(
  runner: { execute: DocumentTransaction["execute"] },
  orgId: string,
  plan: PostedCorrectionPlan,
): Promise<void> {
  const suggestion = await suggestVoidReversalDate(runner, orgId, {
    id: plan.sourceId,
    kind: plan.source.kind,
    documentDate: plan.source.documentDate,
    subsidiaryId: plan.source.subsidiaryId,
  });
  if (suggestion.suggestedOpen && !suggestion.fallbackToOpenPeriod &&
      suggestion.suggestedDate === suggestion.originalDate) {
    return;
  }
  const period = suggestion.originalPeriodName ?? plan.source.documentDate;
  const fiscalYear = suggestion.originalFiscalYear != null ? ` FY${suggestion.originalFiscalYear}` : "";
  throw new PostedCorrectionError(
    422,
    `the ${plan.source.kind} posts in ${period}${fiscalYear}, which is closed — a posted amendment cannot void and reissue it into another period`,
    "closed-period",
    "request a controlled period reopen, or post a credit note or adjusting entry in an open period instead of amending the locked document",
  );
}

/**
 * The scope, permission, feature, lineage and status gates every
 * posted-document correction path shares — in-place metadata, reclass and
 * void-and-reissue alike amend history, so a header edit never skips a check
 * the reissue would have faced. Returns the actor's subsidiary scope for the
 * replacement draft.
 */
async function authorizePostedCorrection(
  tx: DocumentTransaction,
  sourceId: string,
  source: { kind: string; status: string; subsidiaryId: string | null },
  ctx: CorrectionContext,
): Promise<ReadonlySet<string> | null> {
  const allowed = await actorAllowedSubsidiaryIds(tx, ctx.orgId, ctx.userId)
  if (!subsidiaryScopeAllows(allowed, source.subsidiaryId)) {
    throw new DocumentEditError(404, 'not found')
  }
  const permissions = documentKindPermissions(source.kind)
  if (!permissions) {
    throw new DocumentEditError(422, 'this transaction type requires its dedicated correction workflow')
  }
  for (const permission of new Set([permissions.edit, permissions.approve])) {
    if (!await actorHasPermission(tx, ctx.orgId, ctx.userId, permission)) {
      throw new DocumentEditError(403, `missing permission: ${permission}`)
    }
  }
  const feature = DOC_KIND_FEATURE[source.kind]
  if (feature && !await lockAndCheckOrgFeature(tx, ctx.orgId, feature)) {
    throw new DocumentEditError(422, 'enable the transaction feature in Company Settings → Features before creating a correction')
  }
  const existingCorrection = (await tx.execute<{ documentNumber: string }>(sql`
    select replacement.document_number as "documentNumber"
      from document_links link
      join documents replacement
        on replacement.id = link.from_document_id
       and replacement.org_id = link.org_id
     where link.org_id = ${ctx.orgId}
       and link.to_document_id = ${sourceId}
       and link.link_type = 'reverses'
     limit 1
  `)).rows[0]
  assertNoExistingDocumentCorrection(existingCorrection?.documentNumber ?? null)
  if (source.status !== 'posted') {
    throw new DocumentEditError(422, 'only a posted document can create a correcting replacement')
  }
  return allowed
}

export async function createPostedCorrection(
  sourceId: string,
  body: DocumentEditInput,
  ctx: CorrectionContext,
  writer: CorrectionDraftWriter,
): Promise<{ id: string; documentNumber: string; kind: string }> {
  const expectedRevision = requireDocumentEditRevision(body.expectedUpdatedAt)
  const reason = validateCorrectionReason(body.amendmentReason)

  return await withOrgTransaction(ctx.orgId, async () => runDocumentVersionedTransaction<
    DocumentTransaction,
    { kind: string; status: string; subsidiaryId: string | null; documentDate: string; updatedAt: string },
    { id: string; documentNumber: string; kind: string }
  >({
    expectedRevision,
    transaction: (work) => db.transaction(work),
    // The source revision is authoritative only while this lock is held. The
    // caller's outer command transaction (when present) is reused, so the lock
    // spans every dependent replacement write.
    lock: async (tx) => {
      await acquireOrgFeatureGateLock(tx, ctx.orgId)
      return (await tx.execute<{
      kind: string
      status: string
      subsidiaryId: string | null
      documentDate: string
      updatedAt: string
    }>(sql`
      select kind, status, subsidiary_id as "subsidiaryId",
             document_date::text as "documentDate",
             ${documentRevisionCounterSql(sql.raw('revision_seq'))} as "updatedAt"
       from documents
       where id = ${sourceId} and org_id = ${ctx.orgId}
       for update
    `)).rows[0] ?? null
    },
    mutate: async (tx, source) => {
      const allowed = await authorizePostedCorrection(tx, sourceId, source, ctx)
      // The replacement inherits the source's (already scope-gated)
      // subsidiary unless the body re-homes it; the factory validates the
      // result against the actor's real scope, never the org root.
      const replacement = await writer.createDraft(source.kind, {
        allowedSubsidiaryIds: allowed,
        subsidiaryId: body.subsidiaryId ?? source.subsidiaryId,
        runFlows: false,
        source: ctx.source,
      })
      const row = await loadDocumentEditCurrent(replacement.id, ctx.orgId)
      if (!row) throw new Error(`replacement document ${replacement.id} disappeared during initialization`)
      if (row.kind !== source.kind || row.status !== 'draft' || !subsidiaryScopeAllows(allowed, row.subsidiaryId)) {
        throw new DocumentEditError(422, 'the replacement must be a draft of the same transaction type in an authorized subsidiary')
      }
      await writer.applyEdit(
        replacement.id,
        row,
        {
          ...body,
          // A reissue replaces the source transaction, so it inherits the
          // source's date unless the amendment moves it. A fresh draft
          // defaults to today, which would strand the replacement in a later
          // period the locked original cannot post back into.
          documentDate: body.documentDate ?? source.documentDate,
          expectedUpdatedAt: row.updatedAt,
          // The drawer copies the SOURCE document's rows into the correction
          // body, identities included: on the fresh replacement those are
          // foreign, so the copy boundary treats every copied line as new.
          lines: body.lines?.map((line) => {
            if (line.lineId === undefined || line.lineId === null) return line
            const copy = { ...line }
            delete copy.lineId
            return copy
          }),
        },
        {
          ...ctx,
          source: 'posted_correction',
          runFlows: false,
        },
      )
      const edited = await loadDocumentEditCurrent(replacement.id, ctx.orgId)
      if (!edited || edited.kind !== source.kind || edited.status !== 'draft' || !subsidiaryScopeAllows(allowed, edited.subsidiaryId)) {
        throw new DocumentEditError(422, 'the correction editor did not retain an authorized draft; reload and retry the correction')
      }
      const stamped = await tx.execute<{ id: string }>(sql`
        update documents
           set custom = coalesce(custom, '{}'::jsonb) ||
             ${JSON.stringify({
               correctionOf: sourceId,
               correctionReason: reason,
             })}::jsonb,
               updated_at = greatest(
                 clock_timestamp(),
                 updated_at + interval '1 microsecond'
               ),
               updated_by = ${ctx.userId}
         where id = ${replacement.id} and org_id = ${ctx.orgId}
         returning id
      `)
      if (stamped.rows.length !== 1) {
        throw new DocumentEditError(409, 'the replacement could not be saved; reload the source and retry the correction')
      }
      await tx.insert(schema.documentLinks).values({
        orgId: ctx.orgId,
        ...buildReversalLinkEvidence({
          fromDocumentId: replacement.id,
          toDocumentId: sourceId,
          reason,
          requestedBy: ctx.userId,
        }),
        createdBy: ctx.userId,
        updatedBy: ctx.userId,
      })
      await tx.execute(sql`
        insert into audit_log
          (org_id, table_name, row_id, action, changes, actor_id, request_id)
        values (
          ${ctx.orgId}, 'documents', ${replacement.id}, 'insert',
          ${JSON.stringify({
            mode: 'posted_correction_draft',
            sourceDocumentId: sourceId,
            reason,
          })}::jsonb,
          ${ctx.userId}, 'posted_correction'
        )
      `)
      return { ...replacement, kind: source.kind }
    },
  }))
  }

interface ReclassPostedLeg {
  bookId: string;
  accountId: string;
  subsidiaryId: string | null;
  amount: string;
  currency: string;
  txnAmount: string;
  fxRate: string;
  partyId: string | null;
  departmentId: string | null;
  projectId: string | null;
  locationId: string | null;
  classId: string | null;
  memo: string | null;
  extraDims: Record<string, unknown>;
  custom: Record<string, unknown>;
}

/**
 * The header writes one in-place correction applies: metadata columns,
 * header-only dimension links, and the tenant custom merge. The caller holds
 * the source row lock; the revision token was already compared.
 */
function inPlaceCorrectionWrites(plan: PostedCorrectionPlan): {
  sets: Array<ReturnType<typeof sql>>;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
} {
  const sets: Array<ReturnType<typeof sql>> = [];
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  for (const field of plan.metadataFields) {
    const column = POSTED_METADATA_COLUMNS[field as keyof typeof POSTED_METADATA_COLUMNS];
    if (!column) continue;
    before[field] = normalizeCorrectionScalar(plan.source[field]);
    after[field] = plan.metadataAfter[field] ?? null;
    const nextMeta = after[field] as string | null;
    sets.push(nextMeta == null ? sql`${sql.raw(column)} = null` : sql`${sql.raw(column)} = ${nextMeta}`);
  }
  // Reclassified dimensions re-point the header link too, so operational
  // reports that inherit the header dimension follow the reclass.
  for (const field of [...plan.headerOnlyDimensions, ...plan.reclassDimensions.map((dim) => dim.field)]) {
    const column = POSTED_DIMENSION_COLUMNS[field];
    before[field] = normalizeCorrectionScalar(plan.source[field]);
    after[field] = plan.dimensionAfter[field] ?? null;
    const next = after[field] as string | null;
    sets.push(next == null ? sql`${sql.raw(column)} = null` : sql`${sql.raw(column)} = ${next}::uuid`);
  }
  return { sets, before, after };
}

async function writeInPlaceCorrectionAudit(
  tx: DocumentTransaction,
  orgId: string,
  sourceId: string,
  userId: string,
  mode: "posted_metadata_correction" | "posted_dimension_header" | "posted_dimension_reclass",
  reason: string,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): Promise<void> {
  await tx.execute(sql`
    insert into audit_log
      (org_id, table_name, row_id, action, changes, actor_id, request_id)
    values (
      ${orgId}, 'documents', ${sourceId}, 'update',
      ${JSON.stringify({ mode, reason, before, after, ...extra })}::jsonb,
      ${userId}, 'posted_correction'
    )
  `);
}

/**
 * Move posted amounts between dimensions with a balanced reclass entry dated
 * in the original's own period — the same period the void rule would keep —
 * then re-point the document's header link so operational reports (project
 * invoiced-to-date via line-override-then-header inheritance) follow the new
 * dimension. The source legs stay immutable; the mirrors are never open
 * items, so aging and applications are untouched.
 */
async function applyDimensionReclass(
  tx: DocumentTransaction,
  plan: PostedCorrectionPlan,
  ctx: CorrectionContext,
): Promise<{ reclassEntryIds: string[] }> {
  const module = closeModuleForDocument(plan.source.kind);
  const covering = await resolveCoveringPeriod(tx, ctx.orgId, plan.source.documentDate);
  if (!covering) {
    throw new PostedCorrectionError(
      422,
      `no accounting period covers ${plan.source.documentDate} — generate the period before reclassifying the posted ${plan.source.kind}`,
      "closed-period",
      "generate the covering period, or post a credit note or adjusting entry in an open period instead",
    );
  }
  const legs = (await tx.execute<ReclassPostedLeg>(sql`
    select entry.book_id as "bookId", line.account_id as "accountId",
           line.subsidiary_id as "subsidiaryId",
           line.amount::text as amount, line.currency,
           line.txn_amount::text as "txnAmount", line.fx_rate::text as "fxRate",
           line.party_id as "partyId", line.department_id as "departmentId",
           line.project_id as "projectId", line.location_id as "locationId",
           line.class_id as "classId", line.memo,
           coalesce(line.extra_dims, '{}'::jsonb) as "extraDims",
           coalesce(line.custom, '{}'::jsonb) as "custom"
      from journal_lines line
      join journal_entries entry
        on entry.id = line.entry_id and entry.org_id = line.org_id
     where entry.org_id = ${ctx.orgId} and entry.source_document_id = ${plan.sourceId}
       and entry.status = 'posted'
     order by entry.book_id, line.line_number, line.id
  `)).rows;
  const subsidiaryId = plan.source.subsidiaryId ??
    legs.find((leg) => leg.subsidiaryId != null)?.subsidiaryId ?? null;
  if (!subsidiaryId) {
    throw new DocumentEditError(422, "the reclass needs a legal entity — the posted document and its legs carry none");
  }
  const currency = plan.source.currency ?? legs.find((leg) => leg.currency != null)?.currency ?? null;
  const reclassEntryIds: string[] = [];
  const books = [...new Set(legs.map((leg) => leg.bookId))];
  for (const bookId of books) {
    const mirrors: PostEntryLineInput[] = [];
    for (const leg of legs.filter((row) => row.bookId === bookId)) {
      for (const dim of plan.reclassDimensions) {
        if (leg[dim.field] !== dim.before) continue;
        const carried = {
          accountId: leg.accountId,
          subsidiaryId: leg.subsidiaryId ?? subsidiaryId,
          currency: leg.currency,
          fxRate: leg.fxRate,
          partyId: leg.partyId,
          departmentId: leg.departmentId,
          projectId: leg.projectId,
          locationId: leg.locationId,
          classId: leg.classId,
          memo: `Reclass ${dim.field} on ${plan.source.documentNumber}: ${plan.reason}`,
          extraDims: leg.extraDims,
          isOpenItem: false,
          custom: leg.custom,
        };
        const outLeg: PostEntryLineInput = {
          ...carried, amount: neg(leg.amount), txnAmount: neg(leg.txnAmount),
        };
        outLeg[dim.field] = dim.before;
        const inLeg: PostEntryLineInput = {
          ...carried, amount: leg.amount, txnAmount: leg.txnAmount,
        };
        inLeg[dim.field] = dim.after;
        mirrors.push(outLeg, inLeg);
      }
    }
    if (mirrors.length === 0) continue;
    const posted = await postEntry(tx, {
      orgId: ctx.orgId,
      bookId,
      subsidiaryId,
      entryNumber: await nextFreeEntryNumber(tx, ctx.orgId, `RECLASS-${plan.source.documentNumber}`),
      postingDate: plan.source.documentDate,
      periodId: covering.id,
      memo: `Reclass ${plan.reclassDimensions.map((dim) => dim.field).join(", ")} on ${plan.source.documentNumber}`,
      origin: "correction",
      sourceDocumentId: plan.sourceId,
      custom: {
        correctionOf: plan.sourceId,
        correctionReason: plan.reason,
        reclassDimensions: plan.reclassDimensions,
      },
      actorId: ctx.userId,
      requestId: "posted_correction",
      currency: typeof currency === "string" ? currency : undefined,
      closeModules: [module],
      lines: mirrors,
    });
    reclassEntryIds.push(posted.entryId);
  }
  if (reclassEntryIds.length === 0) {
    throw new DocumentEditError(422, "the posted legs no longer carry the old dimension — reload and retry the correction");
  }
  return { reclassEntryIds };
}

export type CorrectPostedDocumentResult =
  | {
    kind: "void-and-reissue";
    replacement: { id: string; documentNumber: string; kind: string };
    voidResult: Awaited<ReturnType<typeof requestDocumentVoid>>;
  }
  | {
    kind: "metadata-correction" | "reclass";
    replacement: { id: string; documentNumber: string; kind: string };
    voidResult: null;
    reclassEntryIds: string[];
  };

/**
 * Correct a posted document through the authoritative field classification:
 * descriptive metadata (and header-only links no posted leg carries) corrects
 * in place with before/after audit even in a locked period; carried
 * dimensions move through a balanced reclass entry dated in the original's
 * period; anything financial voids and reissues — refused outright when the
 * original's period is closed, so a header edit can never smear revenue
 * across fiscal years. The void path passes no explicit reversal date, so
 * the reversal keeps the entry's-own-date rule.
 */
export async function correctPostedDocument(
  sourceId: string,
  input: DocumentEditInput,
  context: CorrectionContext,
  writer: CorrectionDraftWriter,
): Promise<CorrectPostedDocumentResult> {
  const expectedRevision = requireDocumentEditRevision(input.expectedUpdatedAt);
  const plan = await planPostedCorrection(sourceId, input, context.orgId);
  if (plan.outcome === "void-and-reissue") {
    await refuseClosedOriginalPeriod(db, context.orgId, plan);
    return withOrgTransaction(context.orgId, async () => {
      const replacement = await createPostedCorrection(sourceId, input, context, writer);
      const voidResult = await requestDocumentVoid({
        documentId: sourceId, orgId: context.orgId, actorId: context.userId,
        reason: plan.reason,
        source: context.source === "posted_correction" ? "ui" : context.source,
      });
      return { kind: "void-and-reissue", replacement, voidResult };
    });
  }
  return withOrgTransaction(context.orgId, async () => runDocumentVersionedTransaction<
    DocumentTransaction,
    { kind: string; status: string; subsidiaryId: string | null; documentNumber: string; custom: unknown; updatedAt: string },
    CorrectPostedDocumentResult
  >({
    expectedRevision,
    transaction: (work) => db.transaction(work),
    lock: async (tx) => {
      await acquireOrgFeatureGateLock(tx, context.orgId);
      return (await tx.execute<{
        kind: string
        status: string
        subsidiaryId: string | null
        documentNumber: string
        custom: unknown
        updatedAt: string
      }>(sql`
        select kind, status, subsidiary_id as "subsidiaryId",
               document_number as "documentNumber", custom,
               ${documentRevisionCounterSql(sql.raw('revision_seq'))} as "updatedAt"
         from documents
        where id = ${sourceId} and org_id = ${context.orgId}
        for update
      `)).rows[0] ?? null;
    },
    mutate: async (tx, locked) => {
      await authorizePostedCorrection(tx, sourceId, locked, context);
      let reclassEntryIds: string[] = [];
      if (plan.outcome === "reclass") {
        await refuseClosedOriginalPeriod(tx, context.orgId, plan);
        ({ reclassEntryIds } = await applyDimensionReclass(tx, plan, context));
      }
      const { sets, before, after } = inPlaceCorrectionWrites(plan);
      const customChanged = Object.keys(plan.customMetadata).length > 0;
      if (sets.length > 0 || customChanged) {
        const fragments = [...sets];
        if (customChanged) {
          fragments.push(sql`custom = coalesce(custom, '{}'::jsonb) || ${JSON.stringify(plan.customMetadata)}::jsonb`);
        }
        await tx.execute(sql`
          update documents
             set ${sql.join(fragments, sql`, `)},
                 updated_at = greatest(
                   clock_timestamp(),
                   updated_at + interval '1 microsecond'
                 ),
                 updated_by = ${context.userId}
           where id = ${sourceId} and org_id = ${context.orgId}
        `);
        for (const [field, value] of Object.entries(plan.customMetadata)) {
          before[`custom.${field}`] = (locked.custom as Record<string, unknown> | null)?.[field] ?? null;
          after[`custom.${field}`] = value;
        }
      }
      await writeInPlaceCorrectionAudit(tx, context.orgId, sourceId, context.userId,
        plan.outcome === "reclass" ? "posted_dimension_reclass" : "posted_metadata_correction",
        plan.reason, before, after,
        reclassEntryIds.length > 0 ? { reclassEntryIds } : {});
      return {
        kind: plan.outcome,
        replacement: { id: sourceId, documentNumber: locked.documentNumber, kind: locked.kind },
        voidResult: null,
        reclassEntryIds,
      };
    },
  }));
}
