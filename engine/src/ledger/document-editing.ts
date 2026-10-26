/**
 * Document editing commands: create a document from a full edit body, edit an
 * existing document, delete one, and the interactive drawer's locked edit.
 *
 * Every command takes the organization and actor explicitly and runs in the
 * engine's tenant transaction (joining the caller's when one is open). Feature
 * switches are read from the stored organization features. Header and line
 * writes, custom-field validation, allocation lineage, the transaction audit
 * and on_create/on_update flows all belong to `applyDocumentEdit` and the
 * draft factory, so every adapter (REST, MCP, assistant, apps and the drawer)
 * reaches the same write path. Adapters authorize the actor first and map the
 * typed results and refusals below to their transport.
 */
import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "../platform/db.ts";
import { isUuid } from "../platform/uuid.ts";
import { submitAndReleaseIfUngated } from "../flows/submit.ts";
import { PostingError } from "../journal/posting-contracts.ts";
import { actorAllowedSubsidiaryIds } from "../organization/actor-subsidiaries.ts";
import { isFeatureEnabled } from "../organization/feature-state.ts";
import { ScopeNotFoundError, subsidiaryScopeAllows } from "../organization/subsidiary-scope.ts";
import { ControlAccountsIncompleteError } from "../records/control-accounts.ts";
import type { CustomFieldViewer } from "../records/custom-fields.ts";
import { DocumentEditError } from "../records/document-edit-policy.ts";
import {
  findDocumentByExternalRef,
  isExternalRefCheckViolation,
  isExternalRefConflict,
  resolveExternalRefPair,
} from "../records/external-ref.ts";
import { documentRevisionCounterSql } from "../records/revision.ts";
import { deleteDocument, DeleteError } from "./document-delete.ts";
import type {
  DocumentEditCurrent,
  DocumentEditInput,
  DocumentLineInput,
} from "./document-input.ts";
import { controlDeps, loadDocument, loadDocumentEditCurrent } from "./document-service.ts";
import {
  applyDocumentEdit,
  createDocumentDraft,
  isDocKindEnabled,
  precomputeDocumentTotalsForCreate,
  type DocumentEditContext,
} from "./document-write.ts";
import { postDocument } from "./posting-document.ts";

/** The actor an editing command runs for. Adapters check permissions before calling. */
export interface DocumentEditingContext {
  orgId: string;
  userId: string;
  /** Provenance recorded on the draft, the transaction audit and flow events. */
  source: "api" | "mcp" | "assistant";
  /** The actor's subsidiary scope (null = unrestricted); omitted, it is read from the actor's grants. */
  allowedSubsidiaryIds?: ReadonlySet<string> | null;
  /** The audience for custom-field values in the returned document. */
  customFieldViewer: CustomFieldViewer;
}

/** What happens after the write: stay a draft, submit for approval, or post. */
export type DocumentLifecycleAction = "draft" | "submit" | "post";

/** A full edit body plus the lifecycle step to take after it saves. */
export type DocumentWriteInput = DocumentEditInput & { action?: DocumentLifecycleAction };

type LoadedDocument = Awaited<ReturnType<typeof loadDocument>>;

export type DocumentEditingResult =
  /** Saved, and submitted or posted when that was requested. */
  | { outcome: "saved"; document: LoadedDocument }
  /** Saved and submitted; an approval Flow now holds the document. */
  | { outcome: "pending_approval"; requestId: string | null; document: LoadedDocument }
  /**
   * Saved, but the requested submit or post did not complete. `refused` marks
   * a request-state refusal (a posting rule, unconfigured control accounts,
   * an approval that could not be routed) rather than an unexpected failure.
   */
  | { outcome: "lifecycle_failed"; refused: boolean; message: string; document: LoadedDocument };

export type DocumentEditingRefusalCode =
  /** Missing, outside the actor's subsidiary scope, or its feature is off. */
  | "not_found"
  /** The body names a subsidiary outside the actor's scope. */
  | "forbidden_subsidiary"
  /** A voided document is immutable. */
  | "voided"
  /** The external (source, ref) pair is incomplete or blank. */
  | "external_ref_invalid"
  /** Another document already carries the external (source, ref) pair. */
  | "external_ref_conflict"
  /** The shared edit core refused the body. */
  | "edit_refused"
  /** The delete guards refused the document. */
  | "delete_refused";

/** A refusal with the status and response details the adapters return unchanged. */
export class DocumentEditingRefusal extends Error {
  readonly code: DocumentEditingRefusalCode;
  readonly status: number;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(
    code: DocumentEditingRefusalCode,
    status: number,
    message: string,
    details?: Readonly<Record<string, unknown>>,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "DocumentEditingRefusal";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

const notFound = (cause?: unknown) =>
  new DocumentEditingRefusal(
    "not_found",
    404,
    "not found",
    undefined,
    cause === undefined ? undefined : { cause },
  );

const EXTERNAL_PAIR_REQUIRED =
  "externalRef and externalSource travel together and neither may be blank — send both or omit both";

/** Approval routing refused after the submission ran; thrown so the submission rolls back. */
class ApprovalRoutingRefusal extends Error {
  constructor(readonly flowError: string) {
    super(`approval could not be routed: ${flowError}`);
    this.name = "ApprovalRoutingRefusal";
  }
}

function subsidiaryInScope(
  allowed: ReadonlySet<string> | null,
  subsidiaryId: string | null | undefined,
): boolean {
  return (
    allowed === null ||
    (subsidiaryId !== null && subsidiaryId !== undefined && allowed.has(String(subsidiaryId)))
  );
}

/** The actor's subsidiary scope, read from live grants once per command when the caller supplied none. */
function actorScope(
  ctx: Pick<DocumentEditingContext, "orgId" | "userId" | "allowedSubsidiaryIds">,
) {
  let resolved: Promise<ReadonlySet<string> | null> | undefined;
  return () => {
    if (ctx.allowedSubsidiaryIds !== undefined) return Promise.resolve(ctx.allowedSubsidiaryIds);
    resolved ??= actorAllowedSubsidiaryIds(db, ctx.orgId, ctx.userId);
    return resolved;
  };
}

/**
 * Documents speak camelCase while the record schema advertises snake_case
 * columns. The advertised spelling of the external pair is accepted rather
 * than dropped: a dropped dedupe key would mint the duplicate the external
 * index exists to refuse.
 */
export function normalizeExternalRefInput<T extends DocumentEditInput>(body: T): T {
  const snake = body as T & { external_ref?: unknown; external_source?: unknown };
  let out = body;
  if (out.externalRef === undefined && snake.external_ref !== undefined) {
    out = { ...out, externalRef: snake.external_ref as string | null };
  }
  if (out.externalSource === undefined && snake.external_source !== undefined) {
    out = { ...out, externalSource: snake.external_source as string | null };
  }
  return out;
}

/** Early duplicate check, so a replayed external identity names the winner without writing. */
async function refuseDuplicateExternalRef(
  orgId: string,
  body: DocumentEditInput,
  excludeId?: string,
): Promise<void> {
  const pair = resolveExternalRefPair({
    externalRef: body.externalRef,
    externalSource: body.externalSource,
  });
  if (pair.action === "refuse")
    throw new DocumentEditingRefusal("external_ref_invalid", 422, pair.message);
  if (pair.action !== "set") return;
  const winner = await findDocumentByExternalRef(db, orgId, pair.ref, pair.source, excludeId);
  if (!winner) return;
  throw new DocumentEditingRefusal(
    "external_ref_conflict",
    409,
    `externalRef "${pair.ref}" from "${pair.source}" already exists on document ${winner.documentNumber} — send a new reference or update the existing document`,
    { existingId: winner.id },
  );
}

/**
 * The refusal for a failed edit-core write, or the original error. Edit-core
 * refusals keep their status and field errors. A concurrent claim of the same
 * external pair loses at storage (unique 23505, pair/blank check 23514) after
 * the early check passed; it answers like the early check, naming the winner.
 */
async function editWriteFailure(
  orgId: string,
  body: DocumentEditInput,
  error: unknown,
  excludeId?: string,
): Promise<unknown> {
  if (error instanceof DocumentEditError) {
    return new DocumentEditingRefusal(
      "edit_refused",
      error.status,
      error.message,
      error.fieldErrors ? { fieldErrors: error.fieldErrors } : undefined,
      { cause: error },
    );
  }
  if (!isExternalRefConflict(error) && !isExternalRefCheckViolation(error)) return error;
  if (isExternalRefCheckViolation(error)) {
    return new DocumentEditingRefusal(
      "external_ref_invalid",
      422,
      EXTERNAL_PAIR_REQUIRED,
      undefined,
      { cause: error },
    );
  }
  const pair = resolveExternalRefPair({
    externalRef: body.externalRef,
    externalSource: body.externalSource,
  });
  if (pair.action !== "set") {
    return new DocumentEditingRefusal(
      "external_ref_invalid",
      422,
      EXTERNAL_PAIR_REQUIRED,
      undefined,
      { cause: error },
    );
  }
  const winner = await findDocumentByExternalRef(db, orgId, pair.ref, pair.source, excludeId);
  return new DocumentEditingRefusal(
    "external_ref_conflict",
    409,
    winner
      ? `externalRef "${pair.ref}" from "${pair.source}" already exists on document ${winner.documentNumber} — send a new reference or update the existing document`
      : `externalRef "${pair.ref}" from "${pair.source}" already exists — send a new reference or update the existing document`,
    winner ? { existingId: winner.id } : undefined,
    { cause: error },
  );
}

/**
 * Take the requested lifecycle step after a pre-post edit. A draft submits
 * through its Flows inside the command's transaction, so a refused routing
 * rolls the submission's own effects back; an ungated submission releases to
 * approved and `post` then writes GL. Null when the step completed.
 */
async function runRequestedLifecycle(
  ctx: DocumentEditingContext,
  documentId: string,
  kind: string,
  action: DocumentWriteInput["action"],
): Promise<Exclude<DocumentEditingResult, { outcome: "saved" }> | null> {
  if (action !== "submit" && action !== "post") return null;
  try {
    const status = await db.execute<{ status: string }>(
      sql`
      select status from documents
       where id = ${documentId} and org_id = ${ctx.orgId}
    `,
      "objects",
    );
    if (status[0]?.status === "draft") {
      const submission = await withOrgTransaction(ctx.orgId, async () => {
        const inner = await submitAndReleaseIfUngated(kind, documentId, ctx.userId);
        if (inner.flowError) {
          throw new ApprovalRoutingRefusal(inner.flowError);
        }
        return inner;
      });
      if (submission.gated) {
        return {
          outcome: "pending_approval",
          requestId: submission.runId,
          document: await loadDocument(documentId, ctx.orgId, ctx.customFieldViewer),
        };
      }
    }
    if (action === "post") {
      const deps = await controlDeps(ctx.orgId);
      await postDocument(documentId, deps, {
        audit: { actorId: ctx.userId, source: ctx.source },
      });
    }
    return null;
  } catch (error) {
    return {
      outcome: "lifecycle_failed",
      refused:
        error instanceof PostingError ||
        error instanceof ControlAccountsIncompleteError ||
        error instanceof ApprovalRoutingRefusal,
      message: (error as Error).message,
      document: await loadDocument(documentId, ctx.orgId, ctx.customFieldViewer),
    };
  }
}

/**
 * Create a document of `kind` from a full edit body: mint the draft in the
 * actor's scope (its on_create flows settle first), write the body through
 * the shared edit core against the settled revision, then take the requested
 * lifecycle step.
 */
export async function createDocumentFromInput(
  ctx: DocumentEditingContext,
  input: { kind: string; body: DocumentWriteInput },
): Promise<DocumentEditingResult> {
  return withOrgTransaction(ctx.orgId, async () => {
    const body = normalizeExternalRefInput(input.body);
    const scope = actorScope(ctx);
    if (!(await isDocKindEnabled(ctx.orgId, input.kind))) throw notFound();
    if (body.subsidiaryId !== undefined && body.subsidiaryId !== null) {
      if (!subsidiaryInScope(await scope(), body.subsidiaryId)) {
        throw new DocumentEditingRefusal("forbidden_subsidiary", 403, "forbidden subsidiary");
      }
    }
    if (body.currency !== undefined && !(await isFeatureEnabled(ctx.orgId, "multiCurrency"))) {
      throw notFound();
    }
    await refuseDuplicateExternalRef(ctx.orgId, body);
    let precomputedTotals;
    try {
      precomputedTotals = await precomputeDocumentTotalsForCreate(ctx.orgId, input.kind, body);
    } catch (error) {
      throw await editWriteFailure(ctx.orgId, body, error);
    }
    const draft = await createDocumentDraft(ctx.orgId, ctx.userId, input.kind, {
      // A restricted actor drafts in their own subsidiary (or a named
      // refusal), never the organization root; an explicit body subsidiary
      // was checked above and is passed for the factory's own check.
      allowedSubsidiaryIds: await scope(),
      subsidiaryId: body.subsidiaryId ?? undefined,
      source: ctx.source,
    });
    // on_create flows may have changed the row: edit from its settled
    // snapshot and exact revision, never as a tokenless update.
    const current = await loadDocumentEditCurrent(draft.id, ctx.orgId);
    if (!current) throw new Error(`draft document ${draft.id} disappeared during initialization`);
    try {
      await applyDocumentEdit(
        draft.id,
        current,
        { ...body, expectedUpdatedAt: current.updatedAt },
        {
          orgId: ctx.orgId,
          userId: ctx.userId,
          source: ctx.source,
          precomputedTotals,
          customFieldViewer: ctx.customFieldViewer,
        },
      );
    } catch (error) {
      throw await editWriteFailure(ctx.orgId, body, error);
    }
    return (
      (await runRequestedLifecycle(ctx, draft.id, input.kind, body.action)) ?? {
        outcome: "saved",
        document: await loadDocument(draft.id, ctx.orgId, ctx.customFieldViewer),
      }
    );
  });
}

/**
 * Edit an existing document of `kind` under its row lock. The stored and the
 * requested subsidiary are both checked against the actor's scope, a voided
 * document is refused, and a posted document takes no lifecycle step (it
 * already carries GL).
 */
export async function editDocument(
  ctx: DocumentEditingContext,
  input: { kind: string; documentId: string; body: DocumentWriteInput },
): Promise<DocumentEditingResult> {
  return withOrgTransaction(ctx.orgId, async () => {
    const body = normalizeExternalRefInput(input.body);
    const owned = await db.execute<DocumentEditCurrent>(
      sql`
      select kind, status, total, tax_total as "taxTotal", party_id as "partyId",
             document_date as "documentDate",
             custom,
             subsidiary_id as "subsidiaryId",
             ${documentRevisionCounterSql(sql.raw("revision_seq"))} as "updatedAt"
        from documents where id = ${input.documentId} and org_id = ${ctx.orgId} and kind = ${input.kind}
        for update`,
      "objects",
    );
    const row = owned[0];
    if (!row) throw notFound();
    const allowed = await actorScope(ctx)();
    if (!subsidiaryInScope(allowed, row.subsidiaryId)) throw notFound();
    if (
      body.subsidiaryId !== undefined &&
      body.subsidiaryId !== null &&
      !subsidiaryInScope(allowed, body.subsidiaryId)
    ) {
      throw new DocumentEditingRefusal("forbidden_subsidiary", 403, "forbidden subsidiary");
    }
    if (!(await isDocKindEnabled(ctx.orgId, input.kind))) throw notFound();
    if (body.currency !== undefined && !(await isFeatureEnabled(ctx.orgId, "multiCurrency"))) {
      throw notFound();
    }
    if (row.status === "voided") {
      throw new DocumentEditingRefusal("voided", 422, "a voided document cannot be edited");
    }
    await refuseDuplicateExternalRef(ctx.orgId, body, input.documentId);
    try {
      await applyDocumentEdit(input.documentId, row, body, {
        orgId: ctx.orgId,
        userId: ctx.userId,
        source: ctx.source,
        customFieldViewer: ctx.customFieldViewer,
      });
    } catch (error) {
      throw await editWriteFailure(ctx.orgId, body, error, input.documentId);
    }
    const lifecycle =
      row.status === "posted"
        ? null
        : await runRequestedLifecycle(ctx, input.documentId, input.kind, body.action);
    return (
      lifecycle ?? {
        outcome: "saved",
        document: await loadDocument(input.documentId, ctx.orgId, ctx.customFieldViewer),
      }
    );
  });
}

/**
 * Delete a document of `kind` through the guarded delete (open period, no
 * applied payments, no downstream conversion). The actor's scope is checked
 * on the locked row and rechecked inside the delete's own lock, so a
 * concurrent rehome cannot authorize the delete of another entity's document.
 */
export async function deleteDocumentInScope(
  ctx: Pick<DocumentEditingContext, "orgId" | "userId" | "allowedSubsidiaryIds">,
  input: { kind: string; documentId: string },
): Promise<void> {
  await withOrgTransaction(ctx.orgId, async () => {
    const owned = await db.execute<{ subsidiaryId: string | null }>(
      sql`
      select subsidiary_id as "subsidiaryId"
        from documents where id = ${input.documentId} and org_id = ${ctx.orgId} and kind = ${input.kind}
        for update`,
      "objects",
    );
    if (!owned[0]) throw notFound();
    const allowed = await actorScope(ctx)();
    if (!subsidiaryInScope(allowed, owned[0].subsidiaryId)) throw notFound();
    if (!(await isDocKindEnabled(ctx.orgId, input.kind))) throw notFound();
    try {
      await deleteDocument(input.documentId, ctx.userId, ctx.orgId, {
        allowedSubsidiaryIds: allowed,
      });
    } catch (error) {
      if (error instanceof ScopeNotFoundError) throw notFound(error);
      if (error instanceof DeleteError) {
        throw new DocumentEditingRefusal("delete_refused", 422, error.message, undefined, {
          cause: error,
        });
      }
      throw error;
    }
  });
}

/**
 * Lock a document row and recheck the actor's subsidiary scope against it.
 * Commands that act after an unlocked read call this first in their
 * transaction, so a rehome committed in between meets the uniform not-found
 * refusal instead of acting on another entity's document.
 */
export async function lockDocumentInScope(
  orgId: string,
  documentId: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
): Promise<void> {
  const locked = await db.execute<{ subsidiaryId: string | null }>(
    sql`
    select subsidiary_id as "subsidiaryId" from documents
     where id = ${documentId} and org_id = ${orgId} for update
  `,
    "objects",
  );
  const row = locked[0];
  if (!row || !subsidiaryScopeAllows(allowedSubsidiaryIds, row.subsidiaryId)) {
    throw new DocumentEditError(404, "not found");
  }
}

/**
 * Apply an interactive edit under the document row lock: the actor's scope
 * is rechecked on the locked row and the shared edit core writes in the same
 * transaction, so the recheck and the edit commit as one unit.
 */
export async function editDocumentInLockedScope(
  ctx: DocumentEditContext & { allowedSubsidiaryIds: ReadonlySet<string> | null },
  input: { documentId: string; current: DocumentEditCurrent; body: DocumentEditInput },
): Promise<void> {
  await withOrgTransaction(ctx.orgId, async () => {
    await lockDocumentInScope(ctx.orgId, input.documentId, ctx.allowedSubsidiaryIds);
    await applyDocumentEdit(input.documentId, input.current, input.body, ctx);
  });
}

const DISABLED_ITEM_KIND_GATES: readonly { feature: string; kinds: ReadonlySet<string> }[] = [
  { feature: "inventory", kinds: new Set(["inventory", "assembly", "kit"]) },
  { feature: "equipment", kinds: new Set(["equipment_charge"]) },
];

/**
 * True when a supplied line names an item whose kind belongs to a Features
 * switch that is off: inventory, assembly and kit items need Inventory, and
 * equipment charges need Equipment. Items already on the stored document
 * (`documentId`) stay editable, so turning a feature off never strands a draft.
 */
export async function linesUseDisabledItemKinds(
  orgId: string,
  lines: readonly Pick<DocumentLineInput, "itemId">[],
  documentId?: string,
): Promise<boolean> {
  for (const gate of DISABLED_ITEM_KIND_GATES) {
    if (await isFeatureEnabled(orgId, gate.feature)) continue;
    const stored = new Set<string>();
    if (documentId !== undefined) {
      const rows = await db.execute<{ item_id: string }>(
        sql`
        select item_id from document_lines
         where org_id = ${orgId} and document_id = ${documentId} and item_id is not null`,
        "objects",
      );
      for (const row of rows) stored.add(row.item_id);
    }
    for (const line of lines) {
      if (!line.itemId || !isUuid(line.itemId) || stored.has(line.itemId)) continue;
      const item = await db.execute<{ kind: string }>(
        sql`
        select kind from items where id = ${line.itemId} and org_id = ${orgId}`,
        "objects",
      );
      if (item[0] && gate.kinds.has(item[0].kind)) return true;
    }
  }
  return false;
}
