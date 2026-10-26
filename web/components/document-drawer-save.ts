import { isDocumentRevisionToken } from "@/lib/api/registry-data";
import { refusalMessageFromBody } from "../lib/api-error";
import type { DocPayload } from "./document-drawer-types";

/** Any request that carries one exact revision token as fence evidence.
 *  Documents name it expectedUpdatedAt; field tickets expectedRevision. */
export type RevisionFencedRequest = {
  path: string;
  method: "PATCH" | "POST";
  body: Record<string, unknown>;
};

export type DocumentSaveRequest<Method extends "PATCH" | "POST" = "PATCH" | "POST"> = {
  path: string;
  method: Method;
  body: Record<string, unknown> & { expectedUpdatedAt: string };
};

/** Client-side echo of the API's stale-write 409 contract (lib/documents). */
export const DOCUMENT_CHANGED_AFTER_OPEN =
  "this document changed after you opened it; reload and review the latest revision";

/** The revision is an opaque value loaded from persisted document state. */
export function persistedDocumentRevision(value: unknown): string {
  if (!isDocumentRevisionToken(value)) {
    throw new Error("DOCUMENT_REVISION_REQUIRED");
  }
  return value;
}

/**
 * The single write an unsaved create makes: first Save POSTs the collection
 * once with a caller UUID idempotency key (stable per drawer session, so a
 * retried Save replays instead of duplicating). The body is the drawer's own
 * save payload plus the kind — the exact shape PATCH would receive — so the
 * server validates a create with the same rules and messages as an edit.
 * Pure, unit-tested alongside the kind hrefs.
 */
export function buildDocumentCreateRequest(
  kind: string,
  payload: Record<string, unknown>,
  key: string,
): {
  path: string;
  method: "POST";
  headers: Record<string, string>;
  body: Record<string, unknown>;
} {
  return {
    path: "/api/documents",
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": key },
    body: { kind, ...payload },
  };
}

/** Create an RMA with the same transaction form while keeping its source
 * shipment selections out of the ordinary document line writer. */
export function buildReturnCreateRequest(
  payload: Record<string, unknown>,
  key: string,
): {
  path: string;
  method: "POST";
  headers: Record<string, string>;
  body: Record<string, unknown>;
} {
  const lines = Array.isArray(payload.lines) ? (payload.lines as Record<string, unknown>[]) : [];
  const sourceSelections = lines.map((line, index) => {
    const selection = line.inventoryReturnSource as
      { movementId?: unknown; lotId?: unknown; serialId?: unknown } | null | undefined;
    return {
      lineNumber: index + 1,
      sourceIssueMovementId: typeof selection?.movementId === "string" ? selection.movementId : "",
      lotId: typeof selection?.lotId === "string" ? selection.lotId : null,
      serialId: typeof selection?.serialId === "string" ? selection.serialId : null,
    };
  });
  const documentLines = lines.map((line) =>
    Object.fromEntries(Object.entries(line).filter(([key]) => key !== "inventoryReturnSource")),
  );
  return {
    path: "/api/returns",
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": key },
    body: {
      document: { ...payload, lines: documentLines },
      sourceSelections,
    },
  };
}

export function buildDocumentSaveRequest(
  documentId: string,
  persistedRevision: string,
  payload: Record<string, unknown>,
  isPosted: boolean,
  amendmentReason?: string,
  /** Draft families whose PATCH lives on their own equally fenced route
   *  (e.g. /api/expenses, /api/journals) instead of /api/documents. */
  route: { basePath?: string } = {},
): DocumentSaveRequest {
  const basePath = route.basePath ?? "/api/documents";
  const body = {
    ...payload,
    expectedUpdatedAt: persistedDocumentRevision(persistedRevision),
  };
  if (!isPosted) {
    return {
      path: `${basePath}/${documentId}`,
      method: "PATCH",
      body,
    } satisfies DocumentSaveRequest<"PATCH">;
  }
  return {
    path: `${basePath}/${documentId}/correct`,
    method: "POST",
    body: { ...body, amendmentReason },
  } satisfies DocumentSaveRequest<"POST">;
}

/**
 * The exact token a successful fenced save hands back to its caller, across
 * both wire shapes this app returns: `{ doc: { updated_at } }` document
 * payloads and the field-ticket payload whose revision rides at the top level.
 */
export function revisionFromSuccessfulDocumentSave(data: unknown): string {
  const saved = data as { doc?: { updated_at?: unknown }; revision?: unknown };
  return persistedDocumentRevision(saved?.doc?.updated_at ?? saved?.revision);
}

/** The record id a successful create names, or null. The drawer navigates
 *  only to an id it was given: an unnamed success must never be presented
 *  as a saved document. */
export function createdDocumentId(payload: unknown): string | null {
  const id = (payload as { doc?: { id?: unknown } } | null)?.doc?.id;
  return typeof id === "string" && id !== "" ? id : null;
}

/** Whether a successful edit acknowledges what it changed: a posted
 *  correction names its replacement, every other edit names its record
 *  with the exact revision the drawer pins next. */
export function editedDocumentAcknowledged(payload: unknown): boolean {
  const data = payload as {
    doc?: { id?: unknown; updated_at?: unknown };
    correctionId?: unknown;
  } | null;
  if (typeof data?.correctionId === "string" && data.correctionId !== "") return true;
  const doc = data?.doc;
  return typeof doc?.id === "string" && doc.id !== "" && isDocumentRevisionToken(doc.updated_at);
}

/** Identity + exact revision of a `{ doc }` draft payload (expenses,
 *  journals). RSC props carry a lossy Date `updated_at`, so only a canonical
 *  API read can mint a usable snapshot. */
export function draftDocumentIdentity(payload: unknown): { documentId: string; revision: string } {
  const doc = (payload as { doc?: Record<string, unknown> } | null)?.doc;
  if (!doc || doc.id == null || doc.id === "") throw new Error("DOCUMENT_ID_REQUIRED");
  return { documentId: String(doc.id), revision: persistedDocumentRevision(doc.updated_at) };
}

/** Load a canonical draft payload and pin its exact persisted revision —
 *  fail closed when the read fails or returns a lossy token (never guess). */
export async function loadDraftDocumentSnapshot(
  path: string,
  fallbackMessage: string,
  transport: typeof fetch = fetch,
): Promise<PersistedDocumentSnapshot<DocPayload>> {
  let res: Response;
  try {
    res = await transport(path);
  } catch {
    throw new Error(fallbackMessage);
  }
  if (!res.ok) throw new Error(fallbackMessage);
  const data = (await res.json()) as DocPayload;
  const identity = draftDocumentIdentity(data);
  return { documentId: identity.documentId, revision: identity.revision, payload: data };
}

export type DocumentSaveOutcome<Data> =
  { ok: true; data: Data; revision: string } | { ok: false; message: string; isConflict: boolean };

/** Uniform result of one interactive editor's fenced mutation: a success
 *  carries the refreshed exact token, conflicts carry the server's 409
 *  message so the caller can run its reload flow. */
export type FencedSaveResult<Saved> =
  | { status: "saved"; saved: Saved; revision: string }
  | { status: "conflict"; message: string }
  | { status: "error"; message: string };

/** Execute one revision-fenced save request and classify its outcome: a
 *  success carries the refreshed exact token, a failure keeps the server's
 *  message and flags conflicts so callers can run their reload flow. */
export async function executeDocumentSave<Data extends object = DocPayload>(
  request: RevisionFencedRequest,
  fallbackMessage: string,
  transport: typeof fetch = fetch,
): Promise<DocumentSaveOutcome<Data>> {
  let res: Response;
  try {
    res = await transport(request.path, {
      method: request.method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request.body),
    });
  } catch {
    return { ok: false, message: fallbackMessage, isConflict: false };
  }
  if (!res.ok) {
    return { ok: false, ...(await readDocumentSaveFailure(res, fallbackMessage)) };
  }
  const data = (await res.json()) as Data;
  return { ok: true, data, revision: revisionFromSuccessfulDocumentSave(data) };
}

/**
 * What a canonical read means for an already-open editor. A clean editor
 * adopts the fresh snapshot wholesale. A dirty editor may keep its edits only
 * while nothing actually moved server-side — it then pins the newer exact
 * token under unchanged content. Content that drifted under active edits is a
 * conflict: blessing stale edits with the newer token would recreate the
 * silent last-write-wins this fence exists to prevent.
 *
 * Content comparison strips the revision itself (a Date in props can never
 * equal its exact wire token) and compares everything else byte-stably.
 */
export type CanonicalDraftAdoption =
  | { action: "adopt"; snapshot: PersistedDocumentSnapshot<DocPayload> }
  | { action: "pin"; revision: string }
  | { action: "conflict"; snapshot: PersistedDocumentSnapshot<DocPayload> };

function draftContentFingerprint(snapshot: PersistedDocumentSnapshot<DocPayload>): string {
  const { updated_at: _revision, ...doc } = snapshot.payload.doc ?? {};
  void _revision;
  return JSON.stringify({ doc, lines: snapshot.payload.lines });
}

export function reconcileCanonicalDraftRead(args: {
  current: PersistedDocumentSnapshot<DocPayload>;
  incoming: PersistedDocumentSnapshot<DocPayload>;
  isDirty: boolean;
}): CanonicalDraftAdoption {
  if (args.current.documentId !== args.incoming.documentId) {
    return { action: "conflict", snapshot: args.incoming };
  }
  // Clean but already current: pin the newer token WITHOUT resetting the
  // form. Adopting (resetForm) rebuilds row/object state with fresh
  // identities, which the dirty tracker reads as user edits — an untouched
  // editor would then prompt on close with nothing to discard.
  if (!args.isDirty) {
    if (
      args.current.revision === args.incoming.revision ||
      draftContentFingerprint(args.current) === draftContentFingerprint(args.incoming)
    ) {
      return { action: "pin", revision: args.incoming.revision };
    }
    return { action: "adopt", snapshot: args.incoming };
  }
  if (
    args.current.revision === args.incoming.revision ||
    draftContentFingerprint(args.current) === draftContentFingerprint(args.incoming)
  ) {
    return { action: "pin", revision: args.incoming.revision };
  }
  return { action: "conflict", snapshot: args.incoming };
}

export type PersistedDocumentSnapshot<Payload> = {
  documentId: string;
  revision: string;
  payload: Payload;
};

/**
 * Byte-stable fingerprint of the drawer's save payload. The payload is built
 * by one code path from the same state, so equal content always serializes
 * identically and no key sorting is needed.
 */
export function savePayloadFingerprint(payload: unknown): string {
  return JSON.stringify(payload);
}

export function reconcilePersistedDocumentSnapshot<Payload>(
  current: PersistedDocumentSnapshot<Payload>,
  incoming: PersistedDocumentSnapshot<Payload>,
  isDirty: boolean,
  seenPersistedRevisions: ReadonlySet<string>,
): { snapshot: PersistedDocumentSnapshot<Payload>; rehydrate: boolean } {
  const exactIncoming = {
    ...incoming,
    revision: persistedDocumentRevision(incoming.revision),
  };
  persistedDocumentRevision(current.revision);
  if (current.documentId !== exactIncoming.documentId) {
    return { snapshot: exactIncoming, rehydrate: true };
  }
  if (isDirty || seenPersistedRevisions.has(exactIncoming.revision)) {
    return { snapshot: current, rehydrate: false };
  }
  return { snapshot: exactIncoming, rehydrate: true };
}

export async function readDocumentSaveFailure(
  response: Pick<Response, "status" | "json">,
  fallbackMessage: string,
): Promise<{ message: string; isConflict: boolean }> {
  const data = await response.json().catch(() => ({}));
  // The refusal reads through the shared helper so message, remedy and code
  // render instead of the bare `error` field.
  return {
    message: refusalMessageFromBody(data, { fallback: fallbackMessage }) ?? fallbackMessage,
    isConflict: response.status === 409,
  };
}

/**
 * Read a submit/post action response without ever throwing. Error bodies
 * may be proxy HTML pages rather than JSON — letting res.json() throw
 * turns the failure silent (unhandled rejection, zero toast) and wedges
 * the action button busy. A null message tells the caller to use the
 * localized fallback.
 */
export async function readDocumentActionResult(
  response: Pick<Response, "ok" | "json">,
): Promise<{ ok: boolean; message: string | null; pendingApproval: boolean }> {
  const data = (await response.json().catch(() => ({}))) as { pendingApproval?: unknown };
  // The refusal reads through the shared helper so message, remedy and code
  // render instead of the bare `error` field.
  return {
    ok: response.ok,
    message: refusalMessageFromBody(data, { fallback: "" }) ?? null,
    pendingApproval: data.pendingApproval === true,
  };
}

export interface CurrencyMismatchedAccount {
  accountId: string;
  label: string;
  allowed: string;
}

/**
 * Form-level currency proof: every referenced account carrying
 * a settlement-currency restriction must name the document's own currency —
 * the storage trigger would refuse anything else at post, so saving or
 * posting a mismatched form only buys a round trip to a certain refusal.
 * Returns the first offender in form order, or null when nothing provably
 * mismatches (unknown accounts stay the server's call — fail open).
 */
export function findCurrencyMismatchedAccount(
  docCurrency: unknown,
  refs: { accountId: unknown; label: string }[],
  restrictionById: Map<string, string | null | undefined>,
): CurrencyMismatchedAccount | null {
  if (typeof docCurrency !== "string" || !docCurrency) return null;
  for (const ref of refs) {
    if (typeof ref.accountId !== "string" || !ref.accountId) continue;
    const allowed = restrictionById.get(ref.accountId);
    if (allowed && allowed !== docCurrency) {
      return { accountId: ref.accountId, label: ref.label, allowed };
    }
  }
  return null;
}
