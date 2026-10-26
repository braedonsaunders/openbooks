import { sql } from "drizzle-orm";
import { documentRevisionCounterSql } from "../records/revision.ts";
import { canonicalJson } from "../platform/canonical-json.ts";
import { allocateDocumentNumber } from "../records/numbering.ts";
import { DocumentDefaultsError, resolveTermsDueDate } from "./document-defaults.ts";
import { db } from "../platform/db.ts";
import type { CustomFieldViewer } from "../records/custom-fields.ts";
import {
  docKindConfig,
  documentCreateContentRefusal,
  isDocumentCreateKind,
  type DocKindConfig,
} from "../records/document-kinds.ts";
import { businessToday, isIsoCalendarDate } from "../platform/business-date.ts";
import { isUuid } from "../platform/uuid.ts";
import { DocumentEditError } from "../records/document-edit-policy.ts";
import type { DocumentEditInput, DocumentEditCurrent } from "./document-input.ts";
import type { DocumentTransaction, DocumentUpdateFlowEvent } from "./document-write-context.ts";
import {
  precomputeDocumentTotalsForCreate,
  stampSingleWarehouseDefault,
} from "./document-write-lines.ts";
import { applyDocumentEdit } from "./document-write-edit.ts";

/**
 * A reused idempotency key with a changed payload, or a key colliding with
 * another org's row. Fail closed: never return the older row as though it
 * matched. The route maps this to 409 invalid_idempotency_key.
 */
export class DocumentCreateConflict extends Error {
  constructor(message = "invalid_idempotency_key") {
    super(message);
    this.name = "DocumentCreateConflict";
  }
}

export interface DocumentCreateInput {
  orgId: string;
  userId: string;
  /** Role-derived audience for custom-field values. Missing viewers fail closed. */
  customFieldViewer?: CustomFieldViewer;
  kind: string;
  /** Caller UUID idempotency key; becomes the document id. */
  key: string;
  /**
   * Customer scope asserted by the caller (a portal session, a signed link).
   * Carried into the edit context so the new party binding checks against
   * the proven customer instead of the actor's subsidiary roles.
   */
  onBehalfOfPartyId?: string | null;
  /** The drawer's save payload (without expectedUpdatedAt — no revision exists yet). */
  body: DocumentEditInput;
  /** Resolved subsidiary (root default or caller choice, scope-checked by the route). */
  subsidiaryId: string | null;
  /** Full parsed request body for the idempotency image. */
  requestBody: unknown;
  /** Server-owned return request metadata that is not an editable custom field. */
  nativeCustom?: {
    portalRequest?: {
      partyId?: string;
      linkId?: string;
      resolution: "refund" | "exchange" | "store_credit";
      storeCreditBonusPercent: string;
    };
    storeCreditProgramId?: string;
    portalReturnResolution?: "refund" | "exchange" | "store_credit";
    rmaVendorReturnDraft?: { rmaId: string };
  };
}

export interface DocumentCreateResult {
  status: "created" | "replayed";
  id: string;
  documentNumber: string;
  /**
   * The on_update flow event the edit prepared. The caller fires it AFTER
   * this transaction commits, after the on_create flows — firing inside
   * would run flows against an uncommitted row over a separate connection.
   * Null on replay (nothing was written).
   */
  deferredUpdate: DocumentUpdateFlowEvent | null;
}

/**
 * Create one draft document with its full validated header/lines write in a
 * SINGLE transaction: the replay check, the number allocation, the claim,
 * the insert audit event, and the shared writer's validation + writes all
 * commit or roll back together. An invalid Save leaves zero document, zero
 * audit insert, zero flow side effects (flows fire only after this commits),
 * and no idempotency claim — a retry with the same key proceeds as a fresh
 * create. Validation is the shared applyDocumentEdit core, never a copy.
 *
 * Provider-dependent totals precompute before the transaction (see above),
 * so no external resolution ever runs under the advisory/row locks. Audit
 * for a first create is exactly two events: the insert (request image) plus
 * the writer's update (initialization → final snapshots); a replay writes
 * nothing further.
 *
 * Same-key concurrency serializes on a key-scoped advisory lock, so a
 * retried request observes the winner's commit and replays instead of
 * racing it to a false conflict. `on conflict (id) do nothing` is the claim
 * itself: a colliding insert with no same-org row is another org's key and
 * 409s fail-closed.
 */
export async function createDocument(input: DocumentCreateInput): Promise<DocumentCreateResult> {
  const { orgId, userId, kind, key, body, subsidiaryId, requestBody } = input;
  if (input.nativeCustom) assertNativeCreateMetadata(kind, input.nativeCustom);
  if (
    body.custom &&
    ["withholdingDeposit", "withholdingRemittance"].some((key) => Object.hasOwn(body.custom!, key))
  )
    throw new DocumentEditError(
      422,
      "Authority remittance source evidence is created only through the native withholding workflow.",
    );
  const cfg = docKindConfig(kind);
  if (!cfg) throw new DocumentEditError(422, `kind "${kind}" is not editable`);
  if (!isDocumentCreateKind(kind))
    throw new DocumentEditError(422, `kind "${kind}" is not creatable here`);
  // A Save of an untouched form must not persist a blank numbered draft.
  const contentRefusal = documentCreateContentRefusal(kind, body.lines);
  if (contentRefusal) throw new DocumentEditError(422, contentRefusal);
  // Request-controlled idempotency image: kind + full body as parsed.
  // Derived values (number, currency default, totals) and lifecycle state
  // are EXCLUDED — they depend on allocator state or legitimately advance
  // after creation, so comparing them would turn a genuine retry into a
  // conflict.
  const match = {
    kind,
    body: requestBody,
    ...(input.nativeCustom ? { nativeCustom: input.nativeCustom } : {}),
  };

  // Provider-dependent totals resolve BEFORE any lock or write: external tax
  // resolution must never run while the create holds advisory/row locks, and
  // a provider refusal must land with zero writes. Effective header inputs
  // are fixed once here so the precompute and the atomic write below observe
  // identical values (midnight-safe documentDate, resolved currency) — the
  // precomputed image exactly corresponds to this request. Applied line
  // transforms before totals are non-financial (provenance strip,
  // single-warehouse default); an allocation explosion recomputes instead of
  // reusing this image (see the `!entryPlan?.exploded` guard in the writer).
  //
  // The resolved currency seeds the row and the precompute ONLY. It is never
  // written back into the edit body: the writer treats any defined currency
  // as a user currency change and refuses it when multi-currency is off, so
  // an omitted currency must stay omitted (the row default it keeps is this
  // same resolved value).
  const today = await businessToday(orgId);
  const seedCurrency = await resolveCreateCurrency(orgId, subsidiaryId, body.currency);
  const effectiveBody: DocumentEditInput = {
    ...body,
    documentDate: body.documentDate ?? today,
  };
  await applyCreateDefaults(orgId, kind, cfg, effectiveBody);
  const precomputedTotals = effectiveBody.lines
    ? await precomputeDocumentTotalsForCreate(orgId, kind, {
        lines: effectiveBody.lines,
        currency: seedCurrency,
        documentDate: effectiveBody.documentDate,
        partyId: effectiveBody.partyId,
        subsidiaryId: effectiveBody.subsidiaryId,
        custom: effectiveBody.custom,
      })
    : null;

  return db.transaction(async (tx) => {
    // Same-key creates serialize here: the loser waits for the winner's
    // commit, then observes the row and replays (or 409s on a genuinely
    // changed payload) instead of racing to a false conflict. Distinct keys
    // never block each other.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
    // Replay BEFORE allocation: an exact retry must resolve without burning
    // a sequence number, and a changed payload must 409 before any write.
    // Only a key with no same-org row — and no insert image — proceeds.
    const existing = await tx.execute<{ id: string; documentNumber: string }>(
      sql`
      select id, document_number as "documentNumber" from documents where id = ${key} and org_id = ${orgId}`,
      "objects",
    );
    if (existing[0]) return resolveCreateReplay(tx, orgId, key, existing[0], match);
    const documentNumber = await allocateDocumentNumber(tx, orgId, kind, cfg.numberPrefix);
    const inserted = await tx.execute<{ id: string }>(
      sql`
      insert into documents
        (id, org_id, kind, subsidiary_id, document_number, document_date,
         currency, subtotal, tax_total, total, custom, created_by)
      values (${key}, ${orgId}, ${kind}, ${subsidiaryId}, ${documentNumber},
              ${effectiveBody.documentDate}, ${seedCurrency}, '0', '0', '0',
              ${JSON.stringify(input.nativeCustom ?? {})}::jsonb, ${userId})
      -- A conflicting document identity returns no row and raises the scoped creation refusal below.
      on conflict (id) do nothing
      returning id`,
      "objects",
    );
    // A same-key same-org row would have been found above under our advisory
    // lock, so a conflict here is another org's key: fail closed without
    // disclosing it.
    if (!inserted[0]) throw new DocumentCreateConflict();
    // Audit contract for a first create is TWO events, stated exactly: this
    // insert carries the request image (what was asked), and the writer's
    // update below carries before/after snapshots (initialization → final
    // saved state). A replay writes nothing further.
    await tx.execute(sql`
      insert into audit_log
        (org_id, table_name, row_id, action, changes, actor_id, request_id)
      values (
        ${orgId}, 'documents', ${key}, 'insert',
        ${JSON.stringify({ before: null, after: { ...match, id: key, org_id: orgId, document_number: documentNumber, status: "draft" } })}::jsonb,
        ${userId}, ${key}
      )
    `);
    // The claim row is uncommitted, so its edit snapshot must ride this tx —
    // the shared loader would not see it. Mirrors loadDocumentEditCurrent.
    const current =
      (
        await tx.execute<DocumentEditCurrent>(
          sql`
      select kind, status, total, tax_total as "taxTotal", party_id as "partyId",
             document_date as "documentDate",
             custom, subsidiary_id as "subsidiaryId",
             ${documentRevisionCounterSql(sql.raw("revision_seq"))} as "updatedAt"
        from documents
       where id = ${key} and org_id = ${orgId}
    `,
          "objects",
        )
      )[0] ?? null;
    if (!current) throw new Error(`document ${key} disappeared during initialization`);
    const deferredUpdate = await applyDocumentEdit(
      key,
      current,
      { ...effectiveBody, expectedUpdatedAt: current.updatedAt },
      {
        orgId,
        userId,
        source: "ui",
        deferFlows: true,
        precomputedTotals,
        customerPartyId: input.onBehalfOfPartyId ?? undefined,
        customFieldViewer: input.customFieldViewer,
        deferVendorReturnDisposition: Boolean(input.nativeCustom?.rmaVendorReturnDraft),
      },
      { tx },
    );
    return {
      status: "created",
      id: key,
      documentNumber,
      deferredUpdate: deferredUpdate ?? null,
    } as DocumentCreateResult;
  });
}

/** Server-owned return metadata is admitted only on the kinds that carry it. */
function assertNativeCreateMetadata(
  kind: string,
  nativeCustom: NonNullable<DocumentCreateInput["nativeCustom"]>,
): void {
  const keys = Object.keys(nativeCustom);
  const allowed =
    kind === "rma"
      ? ["portalRequest"]
      : kind === "customer_credit"
        ? ["storeCreditProgramId", "portalReturnResolution"]
        : kind === "vendor_credit"
          ? ["rmaVendorReturnDraft"]
          : [];
  if (keys.length === 0 || keys.some((key) => !allowed.includes(key))) {
    throw new DocumentEditError(422, "Native return metadata is not valid for this document.");
  }
  if (
    nativeCustom.rmaVendorReturnDraft &&
    (!isUuid(nativeCustom.rmaVendorReturnDraft.rmaId) || kind !== "vendor_credit")
  ) {
    throw new DocumentEditError(422, "Native return metadata is not valid for this document.");
  }
}

/** Create-time header and line defaults: the terms-implied due date and the single-warehouse default. */
async function applyCreateDefaults(
  orgId: string,
  kind: string,
  cfg: DocKindConfig,
  effectiveBody: DocumentEditInput,
): Promise<void> {
  // A create that names no due date takes the one the party's payment terms
  // imply — the same resolver the drawer previews before save. An explicit
  // null still means "no due date"; malformed dates and parties are left for
  // the writer to refuse by name.
  if (
    effectiveBody.dueDate === undefined &&
    cfg.dueDateFromTerms &&
    isIsoCalendarDate(effectiveBody.documentDate)
  ) {
    try {
      const terms = await resolveTermsDueDate(db, orgId, {
        kind,
        partyId: effectiveBody.partyId,
        documentDate: effectiveBody.documentDate,
      });
      if (terms) effectiveBody.dueDate = terms.dueDate;
    } catch (error) {
      if (error instanceof DocumentDefaultsError) throw new DocumentEditError(422, error.message);
      throw error;
    }
  }
  // The writer reuses these precomputed lines verbatim, so the
  // single-warehouse default must land before the preflight — a stocked
  // line saved without a warehouse would otherwise keep no location all
  // the way to posting. The edit path stamps again; filling blanks twice
  // is idempotent.
  if (effectiveBody.lines) {
    effectiveBody.lines = await stampSingleWarehouseDefault(orgId, effectiveBody.lines);
  }
}

/**
 * The same-org row already exists under this key: an exact retry replays it,
 * anything else 409s. Runs before any allocation, so a replay burns no
 * sequence number and writes nothing.
 */
async function resolveCreateReplay(
  tx: DocumentTransaction,
  orgId: string,
  key: string,
  prior: { id: string; documentNumber: string },
  match: { kind: string; body: unknown },
): Promise<DocumentCreateResult> {
  const original = (
    await tx.execute<{ after: unknown }>(
      sql`
      select changes->'after' as after
        from audit_log
       where org_id = ${orgId}
         and table_name = 'documents'
         and row_id = ${key}
         and action = 'insert'
         and request_id = ${key}
       order by at asc
       limit 1
    `,
      "objects",
    )
  )[0]?.after;
  // No insert image (a legacy draft row that happens to carry this id, or a
  // rolled-back attempt's ghost): the key is consumed by something this
  // request did not create — fail closed rather than adopt it.
  if (!original || typeof original !== "object" || original === null)
    throw new DocumentCreateConflict();
  const keys = Object.keys(match);
  const projected: Record<string, unknown> = {};
  for (const k of keys) projected[k] = (original as Record<string, unknown>)[k];
  if (canonicalJson(projected) !== canonicalJson(match)) throw new DocumentCreateConflict();
  return {
    status: "replayed",
    id: key,
    documentNumber: prior.documentNumber,
    deferredUpdate: null,
  };
}

/**
 * Pre-transaction currency resolution for the create row and the totals
 * precompute. Shape-invalid and unknown codes refuse here with zero writes;
 * the multi-currency feature gate stays in the shared writer.
 */
async function resolveCreateCurrency(
  orgId: string,
  subsidiaryId: string | null,
  currency: unknown,
): Promise<string> {
  if (currency !== undefined) {
    const code = String(currency).trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(code)) throw new DocumentEditError(422, "invalid currency");
    const found = await db.execute(sql`select 1 from currencies where code = ${code}`, "objects");
    if (!found[0]) throw new DocumentEditError(422, "invalid currency");
    return code;
  }
  if (!subsidiaryId)
    throw new DocumentEditError(422, "select a legal entity or enter a document currency");
  const entity = (
    await db.execute<{ base_currency: string | null }>(
      sql`
    select base_currency from subsidiaries
     where org_id = ${orgId} and id = ${subsidiaryId} and is_active and not is_elimination`,
      "objects",
    )
  )[0];
  if (!entity)
    throw new DocumentEditError(422, "select an active legal entity before creating the document");
  if (!entity.base_currency)
    throw new DocumentEditError(
      422,
      "set the functional currency for this legal entity before creating the document",
    );
  return entity.base_currency;
}
