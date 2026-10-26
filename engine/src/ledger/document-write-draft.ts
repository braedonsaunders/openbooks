import { sql } from "drizzle-orm";
import {
  commercialDocumentKindConfig,
  type CommercialDocumentKind,
} from "../records/commercial-document-kind.ts";
import { createPostedCorrection, correctPostedDocument } from "./document-correction.ts";
import { db, schema } from "../platform/db.ts";
import { runRecordFlows } from "../flows/index.ts";
import { resolveDraftSubsidiary } from "../organization/subsidiary-scope.ts";
import { nextDocumentNumber } from "./document-totals.ts";
import { DOC_KIND_FEATURE, docKindConfig } from "../records/document-kinds.ts";
import { featureEnabled } from "../organization/feature-registry.ts";
import { isFeatureEnabled, orgFeatureState } from "../organization/feature-state.ts";
import { businessToday } from "../platform/business-date.ts";
import type { DocumentEditInput } from "./document-input.ts";
import { orgBaseCurrency, type DocumentEditContext } from "./document-write-context.ts";
import { applyDocumentEdit } from "./document-write-edit.ts";

/** Named draft-factory refusal (unknown scope assignment), mapped to 422. */
export class DocumentDraftError extends Error {
  readonly status = 422;
  constructor(message: string) {
    super(message);
    this.name = "DocumentDraftError";
  }
}

/** False when this kind belongs to a Features switch that is off. */
export async function isDocKindEnabled(orgId: string, kind: string): Promise<boolean> {
  const feature = DOC_KIND_FEATURE[kind];
  if (!feature) return true;
  return isFeatureEnabled(orgId, feature);
}

/** Optional-module kinds whose Features switch is off. Historical rows stay. */
export async function disabledDocKinds(orgId: string): Promise<string[]> {
  const state = await orgFeatureState(orgId);
  return Object.entries(DOC_KIND_FEATURE).flatMap(([kind, feature]) =>
    feature && !featureEnabled(state, feature) ? [kind] : [],
  );
}

/**
 * Unsaved-create seed: the blank in-memory payload a list loader hands the
 * DocumentDrawer in createMode for `?doc=new&kind=`. Nothing is read or
 * written for an id — the document exists only after an explicit Save POSTs
 * /api/documents. Currency, date, and subsidiary mirror the draft factory's
 * defaults so the form opens exactly as a fresh draft would.
 */
export async function createDocumentSeed(
  orgId: string,
  kind: string,
): Promise<{ doc: Record<string, unknown>; lines: Record<string, unknown>[] }> {
  const cfg = docKindConfig(kind);
  if (!cfg) throw new Error(`unknown document kind "${kind}"`);
  const [currency, documentDate, root] = await Promise.all([
    orgBaseCurrency(orgId),
    businessToday(orgId),
    db.execute<{ id: string }>(
      sql`
      select id from subsidiaries where org_id = ${orgId} and parent_id is null`,
      "objects",
    ),
  ]);
  return {
    doc: {
      id: "",
      org_id: orgId,
      kind,
      status: "draft",
      document_number: null,
      subsidiary_id: root[0]?.id ?? null,
      party_id: null,
      document_date: documentDate,
      due_date: null,
      reference_number: null,
      memo: null,
      currency,
      subtotal: "0",
      tax_total: "0",
      total: "0",
      updated_at: "",
      party_name: null,
    },
    lines: [],
  };
}

/** Instant-into-draft: mint an empty draft document for a kind, return id + number. */
export async function createDocumentDraft(
  orgId: string,
  userId: string,
  kind: string,
  options: {
    /**
     * REQUIRED actor scope (explicit null only for system flows): a
     * restricted caller's draft lands in their single allowed subsidiary, or
     * a named refusal — the org root is never assigned on their behalf,
     * validated BEFORE numbering or insert.
     */
    allowedSubsidiaryIds: ReadonlySet<string> | null;
    /** Explicit subsidiary choice; validated in scope before numbering. */
    subsidiaryId?: string | null;
    runFlows?: boolean;
    source?: "ui" | "api" | "mcp" | "assistant" | "posted_correction";
    commercialKind?: CommercialDocumentKind;
  },
) {
  const cfg =
    options.commercialKind === kind
      ? commercialDocumentKindConfig(options.commercialKind)
      : docKindConfig(kind);
  if (!cfg) throw new Error(`unknown document kind "${kind}"`);
  const currency = await orgBaseCurrency(orgId);
  // Unrestricted callers default to the org root when they
  // name no subsidiary; restricted callers resolve to their single allowed
  // subsidiary or refuse by name — validated BEFORE numbering or insert.
  let subsidiaryId: string | null;
  if (options.allowedSubsidiaryIds === null && options.subsidiaryId === undefined) {
    const root = await db.execute<{ id: string }>(
      sql`
      select id from subsidiaries where org_id = ${orgId} and parent_id is null`,
      "objects",
    );
    subsidiaryId = root[0]?.id ?? null;
  } else {
    const resolved = resolveDraftSubsidiary(options.allowedSubsidiaryIds, options.subsidiaryId);
    if (!resolved.ok) throw new DocumentDraftError(resolved.error);
    subsidiaryId = resolved.subsidiaryId;
  }
  const documentNumber = await nextDocumentNumber(
    orgId,
    kind,
    cfg.numberPrefix,
    subsidiaryId ?? undefined,
  );
  const [doc] = await db
    .insert(schema.documents)
    .values({
      orgId,
      kind,
      subsidiaryId,
      documentNumber,
      documentDate: await businessToday(orgId),
      currency,
      subtotal: "0",
      taxTotal: "0",
      total: "0",
      createdBy: userId,
    })
    .returning({ id: schema.documents.id, documentNumber: schema.documents.documentNumber });
  // Settle on_create flows before returning. Internal create writers reload
  // the resulting row (including its exact revision) before applying caller
  // input; a flow mutation can therefore never turn initialization into a
  // tokenless update or leave the writer holding the insert-time snapshot.
  if (options.runFlows !== false) {
    await runRecordFlows({ kind: "on_create", source: options.source ?? "ui" }, kind, doc!.id, {
      orgId,
      userId,
    });
  }
  return doc!;
}

/** Create a retained correcting draft through the engine transaction contract. */
export async function createPostedCorrectionDraft(
  sourceId: string,
  body: DocumentEditInput,
  ctx: DocumentEditContext,
  options: { deferFlows?: boolean } = {},
): Promise<{ id: string; documentNumber: string }> {
  const created = await createPostedCorrection(sourceId, body, ctx, {
    createDraft: (kind, draftOptions) =>
      createDocumentDraft(ctx.orgId, ctx.userId, kind, draftOptions),
    applyEdit: applyDocumentEdit,
  });
  if (!options.deferFlows) {
    await runPostedCorrectionDraftFlows(created.id, created.kind, ctx);
  }
  return { id: created.id, documentNumber: created.documentNumber };
}

/** Financial correction and void share one engine-owned transaction. */
export async function correctPostedDocumentWithEditor(
  sourceId: string,
  input: DocumentEditInput,
  context: DocumentEditContext,
) {
  return correctPostedDocument(sourceId, input, context, {
    createDraft: (kind, options) =>
      createDocumentDraft(context.orgId, context.userId, kind, options),
    applyEdit: applyDocumentEdit,
  });
}

export async function runPostedCorrectionDraftFlows(
  correctionId: string,
  kind: string,
  ctx: DocumentEditContext,
): Promise<void> {
  await runRecordFlows({ kind: "on_create", source: ctx.source }, kind, correctionId, {
    orgId: ctx.orgId,
    userId: ctx.userId,
  });
}
