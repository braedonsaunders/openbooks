import { sql } from "drizzle-orm";
import { canonicalDecimal } from "../money/exact-decimal.ts";
import { isUuid } from "../platform/uuid.ts";
import {
  customFieldVisible,
  hiddenCustomFieldRefusal,
  loadCustomFieldAccessDefs,
  type CustomFieldViewer,
} from "../records/custom-fields.ts";
import {
  DOCUMENT_EDIT_REVISION_CONFLICT,
  DocumentEditError,
} from "../records/document-edit-policy.ts";
import type { EntryPlan } from "../allocations/entry.ts";
import type {
  DocumentLineInput,
  DocumentEditInput,
  DocumentEditCurrent,
} from "./document-input.ts";
import type { DocumentTransaction, PreparedDocumentLine } from "./document-write-context.ts";

/**
 * Native line-provenance keys: conversion evidence (`purchaseOrderLineId`,
 * `convertedFrom`) and AP-capture evidence (`apCaptureEvidence`). Never
 * accepted from a caller (echoed or forged) and never colliding with tenant
 * definitions: stripped from input and validated output, then re-attached
 * from the locked rows onto identity-matched lines (see the mutate block).
 * Goods-receipt `receipt` evidence is never whitelisted here.
 */
export const NATIVE_LINE_CUSTOM_KEYS = [
  "purchaseOrderLineId",
  "convertedFrom",
  "apCaptureEvidence",
  // Stock-return evidence on a credit memo. The operator CHOOSES the source
  // movement, but they choose it through the typed `inventoryReturnSource`
  // line field: the server validates that choice and writes this bag itself.
  // Listing it here keeps a caller from forging it directly, and keeps a
  // description-only save from stripping a return the credit already claims.
  "inventoryReturn",
  // Explicit no-goods-returned choice on a credit line (a damage or price
  // allowance). Chosen through the typed `inventoryAllowance` line field for
  // the same reason: listed here so callers cannot forge it and
  // description-only saves cannot drop it.
  "inventoryAllowance",
] as const;

/** Drop caller-supplied native provenance keys; tenant values pass through. */
function stripNativeLineCustom(
  values: Record<string, unknown> | undefined | null,
): Record<string, unknown> {
  if (!values || typeof values !== "object") return {};
  const out = { ...values };
  for (const key of NATIVE_LINE_CUSTOM_KEYS) delete out[key];
  return out;
}

/** Reference equality for source-bound line fields: null and '' are both blank. */
function normLineRef(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const text = String(value);
  return text === "" ? null : text;
}

/** Quantity equality at the quantity column's own 8dp scale. */
function sameLineQuantity(a: unknown, b: unknown): boolean {
  const left = normLineRef(a);
  const right = normLineRef(b);
  if (left === null || right === null) return left === right;
  const exactLeft = canonicalDecimal(left, 8);
  const exactRight = canonicalDecimal(right, 8);
  return exactLeft !== null && exactLeft === exactRight;
}

/** True when a persisted custom bag carries conversion/capture evidence. */
function persistedLineProvenance(custom: unknown): Record<string, unknown> | null {
  if (!custom || typeof custom !== "object") return null;
  const bag = custom as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  let found = false;
  for (const key of NATIVE_LINE_CUSTOM_KEYS) {
    if (bag[key] !== undefined) {
      out[key] = bag[key];
      found = true;
    }
  }
  return found ? out : null;
}

/**
 * Classify persisted native evidence. 'source-bound' lines advance a
 * billed-quantity cover on a source order line and take the identity and
 * source-bound guards; 'audit-only' lines (capture evidence with no PO
 * reference — materializeCapture writes it on every line) are preserved by
 * identity but otherwise edit like ordinary lines; 'malformed' reservation
 * evidence fails closed with a reconcile remedy.
 */
function nativeReservationKind(
  custom: unknown,
): "source-bound" | "audit-only" | "malformed" | null {
  const evidence = persistedLineProvenance(custom);
  if (!evidence) return null;
  let bound = false;
  let audit = false;
  const conv = evidence.convertedFrom;
  if (conv !== undefined) {
    if (!conv || typeof conv !== "object") return "malformed";
    const parts = conv as Record<string, unknown>;
    if (
      typeof parts.lineId !== "string" ||
      !isUuid(parts.lineId) ||
      typeof parts.quantity !== "string" ||
      canonicalDecimal(parts.quantity, 8) === null
    ) {
      return "malformed";
    }
    bound = true;
  }
  const direct = evidence.purchaseOrderLineId;
  if (direct !== undefined) {
    if (typeof direct !== "string" || !isUuid(direct)) return "malformed";
    bound = true;
  }
  const capture = evidence.apCaptureEvidence;
  if (capture !== undefined) {
    if (!capture || typeof capture !== "object") return "malformed";
    const poLine = (capture as Record<string, unknown>).purchaseOrderLineId;
    if (poLine === null || poLine === undefined) {
      audit = true;
    } else if (typeof poLine === "string" && isUuid(poLine)) {
      bound = true;
    } else {
      return "malformed";
    }
  }
  // Stock-return evidence is audit-only: it binds the credit to a movement,
  // not to a source order line's billed-quantity cover, so it takes no
  // source-bound guard — but it MUST be classified, or a description-only save
  // would find no evidence on the document, skip reattachment entirely, and
  // silently drop the return the credit claims. Its shape is checked here
  // because a bag nothing can interpret must fail closed rather than reach
  // posting as an unreadable return.
  const inventoryReturn = evidence.inventoryReturn;
  if (inventoryReturn !== undefined) {
    if (!inventoryReturn || typeof inventoryReturn !== "object") return "malformed";
    const parts = inventoryReturn as Record<string, unknown>;
    const receipt = parts.sourceReceiptMovementId;
    const issue = parts.sourceIssueMovementId;
    const named = [receipt, issue].filter((value) => value !== undefined);
    // Exactly one leg: a bag naming both would let the two return engines
    // disagree about which movement this credit consumed.
    if (named.length !== 1) return "malformed";
    if (typeof named[0] !== "string" || !isUuid(named[0])) return "malformed";
    for (const optional of [parts.lotId, parts.serialId]) {
      if (optional === undefined || optional === null) continue;
      if (typeof optional !== "string" || !isUuid(optional)) return "malformed";
    }
    audit = true;
  }
  // Explicit no-goods-returned choice: a stored `true` only. Anything else
  // on the row is corrupt configuration, not an empty choice — fail closed
  // rather than letting an unreadable disposition reach posting.
  const inventoryAllowance = evidence.inventoryAllowance;
  if (inventoryAllowance !== undefined) {
    if (inventoryAllowance !== true) return "malformed";
    audit = true;
  }
  if (bound) return "source-bound";
  return audit ? "audit-only" : null;
}

/**
 * Human label for a conversion child's source order(s), for refusal messages
 * (same 'bills'/'created_from' order edges the currency guard reads).
 * Capture-only bills carry no edge and read as "its purchase order".
 */
async function conversionSourceLabel(
  tx: DocumentTransaction,
  orgId: string,
  documentId: string,
): Promise<string> {
  const sources = await tx.execute<{ kind: string; documentNumber: string }>(
    sql`
    select source.kind, source.document_number as "documentNumber"
      from document_links link
      join documents source
        on source.id = link.from_document_id
       and source.org_id = link.org_id
     where link.org_id = ${orgId}
       and link.to_document_id = ${documentId}
       and link.link_type in ('bills', 'created_from')
       and source.kind in ('quote', 'sales_order', 'purchase_order')
     order by source.document_number
  `,
    "objects",
  );
  if (sources.length === 0) return "its purchase order";
  return sources
    .map((source) => `${source.kind.replaceAll("_", " ")} ${source.documentNumber}`)
    .join(", ");
}

/** Submitted lines with caller-supplied native provenance keys removed. */
export function stripSubmittedLineProvenance(lines: DocumentLineInput[]): DocumentLineInput[] {
  return lines.map((l) => {
    const custom = l.custom;
    if (!custom || typeof custom !== "object") return l;
    if (
      !NATIVE_LINE_CUSTOM_KEYS.some((key) => (custom as Record<string, unknown>)[key] !== undefined)
    ) {
      return l;
    }
    return { ...l, custom: stripNativeLineCustom(custom as Record<string, unknown>) };
  });
}

/** Canonical stable identities of the submitted lines; malformed or duplicate identities refuse. */
export function submittedLineIdentities(lines: DocumentLineInput[]): (string | null)[] {
  const submittedLineKeys = lines.map((l) => {
    const raw = l.lineId;
    if (raw === undefined || raw === null || raw === "") return null;
    if (typeof raw !== "string" || !isUuid(raw)) {
      const at = lines.findIndex((other) => other.lineId === raw) + 1;
      throw new DocumentEditError(
        422,
        `Line ${at}: invalid line identity — reload the document and save again`,
      );
    }
    // UUIDs are case-equivalent (routes already treat them so): canonicalize
    // before duplicate detection and matching, or 'A…' and 'a…' read as two
    // lines and a valid uppercase identity misses its persisted row.
    return raw.toLowerCase();
  });
  if (submittedLineKeys.some((key) => key !== null)) {
    const seen = new Set<string>();
    for (let i = 0; i < submittedLineKeys.length; i++) {
      const key = submittedLineKeys[i]!;
      if (key === null) continue;
      if (seen.has(key)) {
        throw new DocumentEditError(
          422,
          `Line ${i + 1}: duplicate line identity — reload the document and save again; nothing was changed`,
        );
      }
      seen.add(key);
    }
  }
  return submittedLineKeys;
}

type PersistedEditLine = {
  id: string;
  itemId: string | null;
  quantity: string | null;
  unit: string | null;
  stockLocationId: string | null;
  custom: unknown;
};

/**
 * Re-attach native line provenance (conversion and capture evidence, which
 * tenant validation drops) from the locked persisted rows, matched by stable
 * line identity — never by position, never from the caller — so posting never
 * receives the same stock twice. Only this document's already-locked row and
 * its own lines are read, so no new lock order is introduced; every refusal
 * fires before any delete. Documents without persisted evidence keep the
 * identity-less path; their supplied identities are still validated.
 */
export async function reattachLineProvenance(
  tx: DocumentTransaction,
  args: {
    orgId: string;
    id: string;
    current: DocumentEditCurrent;
    body: DocumentEditInput;
    preparedLines: PreparedDocumentLine[];
    submittedLineKeys: (string | null)[];
    entryPlan: EntryPlan | null;
    lineAccessDefs: Awaited<ReturnType<typeof loadCustomFieldAccessDefs>>;
    customFieldViewer: CustomFieldViewer;
  },
): Promise<void> {
  const { persisted, byId } = await lockSubmittedLineIdentities(tx, args);
  await guardSourceBoundLines(tx, { ...args, persisted, byId });
}

/**
 * Lock the document's persisted lines and prove every submitted identity is
 * one of them; restricted custom values a viewer cannot see stay with their line.
 */
async function lockSubmittedLineIdentities(
  tx: DocumentTransaction,
  args: {
    orgId: string;
    id: string;
    body: DocumentEditInput;
    preparedLines: PreparedDocumentLine[];
    submittedLineKeys: (string | null)[];
    lineAccessDefs: Awaited<ReturnType<typeof loadCustomFieldAccessDefs>>;
    customFieldViewer: CustomFieldViewer;
  },
): Promise<{ persisted: PersistedEditLine[]; byId: Map<string, PersistedEditLine> }> {
  const { orgId, id, body, preparedLines, submittedLineKeys, lineAccessDefs, customFieldViewer } =
    args;
  const persisted = await tx.execute<{
    id: string;
    itemId: string | null;
    quantity: string | null;
    unit: string | null;
    stockLocationId: string | null;
    custom: unknown;
  }>(
    sql`
          select id, item_id as "itemId", quantity::text as "quantity", unit,
                 stock_location_id as "stockLocationId", custom
            from document_lines
           where document_id = ${id} and org_id = ${orgId}
           order by line_number
           for update
        `,
    "objects",
  );
  // Persisted ids compare in the same canonical form: the driver returns
  // uuid columns lowercase, but the match must not depend on that.
  const byId = new Map(persisted.map((row) => [row.id.toLowerCase(), row]));
  const hiddenLineDefs = lineAccessDefs.filter(
    (def) => !customFieldVisible(def, customFieldViewer),
  );
  const hasStoredHiddenLineValues = persisted.some((row) => {
    const custom =
      row.custom && typeof row.custom === "object" && !Array.isArray(row.custom)
        ? (row.custom as Record<string, unknown>)
        : {};
    return hiddenLineDefs.some((def) => Object.hasOwn(custom, def.key));
  });
  if (hasStoredHiddenLineValues && submittedLineKeys.some((key) => key === null)) {
    throw new DocumentEditError(
      422,
      "Line identities are required to preserve restricted custom fields — reload the document and save again",
    );
  }
  // Ownership under the lock, on every edit carrying identities — even
  // when no line carries provenance. A foreign or stale identity is the
  // tenant-opaque 404 the line-account and reference prechecks return,
  // never a silently ignored line. Identity-less saves keep the legacy
  // path unless provenance below requires identities.
  for (let i = 0; i < submittedLineKeys.length; i++) {
    const key = submittedLineKeys[i]!;
    if (key !== null && !byId.has(key)) {
      throw new DocumentEditError(
        404,
        `Line ${i + 1}: line not found in this document — reload the document and save again`,
      );
    }
  }
  for (let i = 0; i < submittedLineKeys.length; i++) {
    const key = submittedLineKeys[i];
    const persistedLine = key ? byId.get(key) : undefined;
    const oldCustom =
      persistedLine?.custom &&
      typeof persistedLine.custom === "object" &&
      !Array.isArray(persistedLine.custom)
        ? (persistedLine.custom as Record<string, unknown>)
        : {};
    const submittedCustom = body.lines?.[i]?.custom ?? {};
    const refusal = hiddenCustomFieldRefusal(
      lineAccessDefs.map((def) => ({ ...def, isRequired: false })),
      customFieldViewer,
      submittedCustom,
      persistedLine ? oldCustom : null,
    );
    if (refusal) {
      throw new DocumentEditError(403, `Line ${i + 1}: ${refusal.message}`, {
        [refusal.key]: refusal.message,
      });
    }
    if (persistedLine && hiddenLineDefs.length > 0) {
      const preserved = Object.fromEntries(
        hiddenLineDefs
          .filter((def) => Object.hasOwn(oldCustom, def.key))
          .map((def) => [def.key, oldCustom[def.key]]),
      );
      preparedLines[i]!.custom = { ...preparedLines[i]!.custom, ...preserved };
    }
  }
  const submittedLineIdSet = new Set(
    submittedLineKeys.filter((key): key is string => key !== null),
  );
  const removedRestrictedLine = persisted.find((row) => {
    if (submittedLineIdSet.has(row.id.toLowerCase())) return false;
    const custom =
      row.custom && typeof row.custom === "object" && !Array.isArray(row.custom)
        ? (row.custom as Record<string, unknown>)
        : {};
    return hiddenLineDefs.some((def) => Object.hasOwn(custom, def.key));
  });
  if (removedRestrictedLine) {
    throw new DocumentEditError(
      403,
      "A line with restricted custom data cannot be removed by your role",
    );
  }
  return { persisted, byId };
}

/** Source-bound lines keep what their source line provided; matched evidence is re-attached. */
async function guardSourceBoundLines(
  tx: DocumentTransaction,
  args: {
    orgId: string;
    id: string;
    current: DocumentEditCurrent;
    preparedLines: PreparedDocumentLine[];
    submittedLineKeys: (string | null)[];
    entryPlan: EntryPlan | null;
    persisted: PersistedEditLine[];
    byId: Map<string, PersistedEditLine>;
  },
): Promise<void> {
  const { orgId, id, current, preparedLines, submittedLineKeys, entryPlan, persisted, byId } = args;
  const evidenceOf = (row: (typeof persisted)[number]) => persistedLineProvenance(row.custom);
  const kindOf = (row: (typeof persisted)[number]) => nativeReservationKind(row.custom);
  // Unreadable reservation evidence fails closed before any matching:
  // neither the guards below nor the delete/void unwind can interpret
  // it, so the edit names reconciliation instead of preserving a cover
  // no read can observe.
  const malformed = persisted.find((row) => kindOf(row) === "malformed");
  if (malformed) {
    const at = persisted.findIndex((row) => row.id === malformed.id) + 1;
    throw new DocumentEditError(
      422,
      `Line ${at}: this line carries unreadable billing provenance — ` +
        `reconcile it before editing; nothing was changed`,
    );
  }
  // An allocation explosion rebuilds the line set the identities were
  // read for, so no identity can be trusted past it while any native
  // evidence exists (source-bound or audit-only): refuse explicitly
  // rather than attaching by a stale position.
  const hasEvidence = persisted.some(
    (row) => kindOf(row) === "source-bound" || kindOf(row) === "audit-only",
  );
  if (hasEvidence) {
    if (entryPlan?.exploded) {
      const at = persisted.findIndex((row) => kindOf(row) !== null) + 1;
      throw new DocumentEditError(
        422,
        `Line ${at}: an entry-allocation split cannot preserve this line's conversion provenance — ` +
          `clear the distribution key on the line to save; nothing was changed`,
      );
    }
    if (submittedLineKeys.length !== preparedLines.length) {
      throw new DocumentEditError(409, DOCUMENT_EDIT_REVISION_CONFLICT);
    }
  }
  // Only source-bound lines take the identity and source-bound guards:
  // capture evidence without a PO reference is audit metadata, kept by
  // identity in the reattachment below but otherwise editable like an
  // ordinary line.
  const provenanceRows = persisted.filter((row) => kindOf(row) === "source-bound");
  if (provenanceRows.length > 0) {
    const matched = new Set(submittedLineKeys.filter((key): key is string => key !== null));
    const removed = provenanceRows.filter((row) => !matched.has(row.id.toLowerCase()));
    // An explicitly emptied line set removes every provenance line;
    // a populated but identity-less save is a legacy client. Both
    // refuse; only the first names line removal.
    if (removed.length > 0 && (submittedLineKeys.length === 0 || matched.size > 0)) {
      // A removed provenance line keeps its billed-quantity cover on
      // the source order: the canonical release runs only on
      // whole-draft delete/void, and there is no per-line release
      // machinery — so removal is refused with that existing remedy
      // rather than silently detached.
      const sources = await conversionSourceLabel(tx, orgId, id);
      throw new DocumentEditError(
        422,
        `Line ${persisted.findIndex((row) => row.id === removed[0]!.id) + 1}: ` +
          `removing a line converted from ${sources} is not supported here — ` +
          `keep the source-backed line, or delete the entire draft to undo its source-order quantity changes; ` +
          `nothing was changed`,
      );
    }
    if (matched.size === 0) {
      // A legacy identity-less save over source-backed lines: position
      // cannot say which line is which once lines reorder, so refuse
      // with the reload remedy instead of guessing.
      const sources = await conversionSourceLabel(tx, orgId, id);
      throw new DocumentEditError(
        422,
        `This ${current.kind} carries conversion provenance on ${provenanceRows.length} ` +
          `line(s) from ${sources}: lines must be saved with their stable identities — ` +
          `reload (or reopen) the document and save again; nothing was changed`,
      );
    }
    for (let i = 0; i < preparedLines.length; i++) {
      const key = submittedLineKeys[i]!;
      if (key === null) continue;
      const stored = byId.get(key)!;
      if (kindOf(stored) !== "source-bound") continue;
      const line = preparedLines[i]!;
      // Source-bound semantics: the child must still bill what its
      // source line provided. Repricing (unit price, amount),
      // descriptions, tax, dimensions, and tenant custom stay editable;
      // item, quantity, unit, or warehouse changes would misinterpret
      // the source line, so the remedy is to keep the converted value.
      const mismatch =
        normLineRef(line.itemId) !== normLineRef(stored.itemId)
          ? "item"
          : !sameLineQuantity(line.quantity, stored.quantity)
            ? "quantity"
            : normLineRef(line.unit) !== normLineRef(stored.unit)
              ? "unit"
              : normLineRef(line.stockLocationId) !== normLineRef(stored.stockLocationId)
                ? "stock location"
                : null;
      if (mismatch === "quantity") {
        const sources = await conversionSourceLabel(tx, orgId, id);
        throw new DocumentEditError(
          422,
          `Line ${i + 1}: quantity cannot be changed on a line converted from ${sources} — ` +
            `keep the converted quantity (${stored.quantity}); nothing was changed`,
        );
      }
      if (mismatch !== null) {
        const sources = await conversionSourceLabel(tx, orgId, id);
        const keep =
          mismatch === "item"
            ? "keep the ordered item"
            : mismatch === "unit"
              ? `keep the converted unit (${stored.unit ?? ""})`
              : "keep the received warehouse";
        throw new DocumentEditError(
          422,
          `Line ${i + 1}: ${mismatch} cannot be changed on a line converted from ${sources} — ` +
            `${keep}; nothing was changed`,
        );
      }
    }
  }
  // Reattachment by identity for every matched evidence line, outside
  // the source-bound block: audit-only documents keep their metadata
  // too. Lengths already match whenever evidence exists (409 above).
  if (hasEvidence && submittedLineKeys.length === preparedLines.length) {
    for (let i = 0; i < preparedLines.length; i++) {
      const key = submittedLineKeys[i]!;
      if (key === null) continue;
      const evidence = evidenceOf(byId.get(key)!);
      if (evidence === null) continue;
      preparedLines[i]!.custom = { ...preparedLines[i]!.custom, ...evidence };
    }
  }
}
