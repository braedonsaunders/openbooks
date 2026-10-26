import { sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { db, withOrgTransaction } from "../platform/db.ts";
import { isUuid } from "../platform/uuid.ts";
import { canonicalJson } from "../platform/canonical-json.ts";
import { documentRevisionCounterSql } from "../records/revision.ts";
import {
  assertDocumentEditRevision,
  requireDocumentEditRevision,
  DocumentEditError,
} from "../records/document-edit-policy.ts";
import {
  fieldTicketSourceHeaderRowSha256,
  findFieldTicketSourceHeaderRow,
  parseFieldTicketSourceHeaders,
  FieldTicketSourceHeaderError,
  type FieldTicketSourceHeaderRow,
} from "./field-ticket-source-headers.ts";
import { getS3Blob, refuseMaskedStorageKind } from "../platform/file-storage.ts";
import { lockActorCommandAuthority } from "../organization/actor-command-authority.ts";
import {
  acquireOrgFeatureGateLock,
  lockAndCheckOrgFeature,
} from "../organization/org-feature-lock.ts";
import { lockScopeRows, subsidiaryScopeAllows } from "../organization/subsidiary-scope.ts";
import { requireNativeFileReadAuthority } from "../records/file-read-authority.ts";

/**
 * Governed native Field Ticket source-identity certification.
 *
 * A certificate binds one exact native ticket to one exact external source
 * ticket. The retained source file, its pinned version and hash, and the
 * parsed row establish which source row was reviewed; they do not by
 * themselves prove lineage. The authenticated operator's explicit
 * attestation and reason supply the mapping authority, and the stored
 * reviewed basis says so.
 *
 * Certification writes metadata only: the certificate row and the exact
 * `custom.source` projection (plus the existing importer metadata facts)
 * on the native document. It never writes status, totals, time, labor
 * snapshots, rates, amounts or billing facts, and its point-in-time native
 * fingerprint is audit evidence — not a freeze on later ordinary approval,
 * billing, or admission of missing source charges through the governed
 * importer. Source or native header reference divergence refuses here and
 * belongs to a separate supported correction lifecycle.
 */

export class FieldTicketSourceCertificationError extends Error {
  readonly status = 422;
  constructor(message: string) {
    super(message);
    this.name = "FieldTicketSourceCertificationError";
  }
}

const SHA256 = /^[a-f0-9]{64}$/;
const SOURCE_SYSTEM = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export type SourceMarkerClassification = "absent" | "exact" | "partial" | "conflict";

/** Classify the source marker already stored on a native ticket. Anything
 * other than an exact pair or a clean absence refuses certification. */
export function classifyExistingSourceMarker(
  custom: unknown,
  sourceSystem: string,
  sourceExternalId: string,
): SourceMarkerClassification {
  if (!custom || typeof custom !== "object" || Array.isArray(custom)) return "absent";
  const source = (custom as Record<string, unknown>).source;
  if (source === undefined || source === null) return "absent";
  if (typeof source !== "object" || Array.isArray(source)) return "partial";
  const system = (source as Record<string, unknown>).system;
  const externalId = (source as Record<string, unknown>).externalId;
  if (typeof system !== "string" || !system || typeof externalId !== "string" || !externalId)
    return "partial";
  return system === sourceSystem && externalId === sourceExternalId ? "exact" : "conflict";
}

/** SHA-256 over the canonical point-in-time native evidence. */
export function nativePointInTimeFingerprint(pointInTime: Record<string, unknown>): string {
  return sha256(canonicalJson(pointInTime));
}

/**
 * True when two point-in-time reads differ only by the certification's own
 * metadata projection: the stored source marker, the document revision
 * counter, and its update stamps. Every financial, time, status, snapshot,
 * rate and amount fact must be identical.
 */
export function certificationProjectionChangesOnlyMetadata(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): boolean {
  const normalize = (value: Record<string, unknown>): Record<string, unknown> => {
    const copy = JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
    const document = copy.document;
    if (document && typeof document === "object" && !Array.isArray(document)) {
      const doc = document as Record<string, unknown>;
      const custom = doc.custom;
      if (custom && typeof custom === "object" && !Array.isArray(custom)) {
        delete (custom as Record<string, unknown>).source;
      }
      delete doc.revision_seq;
      delete doc.updated_at;
      delete doc.updated_by;
    }
    return copy;
  };
  return canonicalJson(normalize(before)) === canonicalJson(normalize(after));
}

export interface FieldTicketSourceReferenceMapInput {
  jobRef: string;
  customerRef: string | null;
  foremanRef: string | null;
  superintendentRef?: string | null;
  projectId: string;
  customerPartyId: string | null;
  foremanPartyId: string | null;
  superintendentPartyId: string | null;
}

export interface CertifyFieldTicketSourceIdentityInput {
  orgId: string;
  actorId: string;
  requestId: string;
  nativeDocumentId: string;
  /** The exact counter token from `documentRevisionCounterSql`, as a string. */
  expectedNativeRevision: string;
  sourceSystem: string;
  sourceTicketId: string;
  sourceFileId: string;
  sourceVersionId: string;
  sourceFileSha256: string;
  attestation: string;
  reason: string;
  explicitReferenceMap: FieldTicketSourceReferenceMapInput;
}

export interface FieldTicketSourceCertificationResult {
  id: string;
  nativeDocumentId: string;
  sourceSystem: string;
  sourceExternalId: string;
  replayed: boolean;
}

/** Canonical request payload hash: the actor is part of the payload, so an
 * exact replay is only ever the same actor resubmitting the same request. */
export function fieldTicketSourceCertificationRequestSha256(
  actorId: string,
  input: Omit<CertifyFieldTicketSourceIdentityInput, "orgId" | "actorId">,
): string {
  return sha256(
    canonicalJson({
      actorId,
      requestId: input.requestId,
      nativeDocumentId: input.nativeDocumentId,
      expectedNativeRevision: input.expectedNativeRevision,
      sourceSystem: input.sourceSystem,
      sourceTicketId: input.sourceTicketId,
      sourceFileId: input.sourceFileId,
      sourceVersionId: input.sourceVersionId,
      sourceFileSha256: input.sourceFileSha256,
      attestation: input.attestation.trim(),
      reason: input.reason.trim(),
      explicitReferenceMap: input.explicitReferenceMap,
    }),
  );
}

function validateInput(input: CertifyFieldTicketSourceIdentityInput): void {
  if (
    ![
      input.orgId,
      input.actorId,
      input.requestId,
      input.nativeDocumentId,
      input.sourceFileId,
      input.sourceVersionId,
    ].every(isUuid)
  ) {
    throw new FieldTicketSourceCertificationError(
      "choose the exact native ticket, retained source file and version, and a request identity",
    );
  }
  // The native opaque revision token: a timestamp-shaped token is
  // well-formed here and loses later against the live counter text.
  requireDocumentEditRevision(input.expectedNativeRevision);
  if (typeof input.sourceSystem !== "string" || !SOURCE_SYSTEM.test(input.sourceSystem)) {
    throw new FieldTicketSourceCertificationError("sourceSystem must be a stable connector id");
  }
  if (
    typeof input.sourceTicketId !== "string" ||
    !input.sourceTicketId.trim() ||
    input.sourceTicketId.trim() !== input.sourceTicketId ||
    input.sourceTicketId.length > 200
  ) {
    throw new FieldTicketSourceCertificationError(
      "choose the exact source ticket id from the retained source file",
    );
  }
  if (!SHA256.test(input.sourceFileSha256)) {
    throw new FieldTicketSourceCertificationError(
      "pin the retained source file version by its SHA-256 hash",
    );
  }
  if (
    typeof input.attestation !== "string" ||
    input.attestation.trim().length < 8 ||
    input.attestation.trim().length > 2000
  ) {
    throw new FieldTicketSourceCertificationError(
      "record the operator attestation that supplies this crosswalk's mapping authority (8–2000 characters)",
    );
  }
  if (
    typeof input.reason !== "string" ||
    input.reason.trim().length < 8 ||
    input.reason.trim().length > 2000
  ) {
    throw new FieldTicketSourceCertificationError(
      "record why this native ticket is certified to this source ticket (8–2000 characters)",
    );
  }
  const map = input.explicitReferenceMap;
  if (
    !map ||
    typeof map !== "object" ||
    typeof map.jobRef !== "string" ||
    !map.jobRef.trim() ||
    !isUuid(map.projectId)
  ) {
    throw new FieldTicketSourceCertificationError(
      "record the explicit reference map: the source job reference and its reviewed native project",
    );
  }
  for (const [label, value] of [
    ["customer", map.customerPartyId],
    ["foreman", map.foremanPartyId],
    ["superintendent", map.superintendentPartyId],
  ] as const) {
    if (value !== null && !isUuid(value)) {
      throw new FieldTicketSourceCertificationError(
        `the explicit reference map's native ${label} must be a native record id or explicitly none`,
      );
    }
  }
}

/** Resolve one source namespace through the existing explicit native maps.
 * Source references resolve through the native `nsId` namespace only; that
 * namespace is never conflated with the certification's source system. */
async function resolveNativeReferenceMap(
  orgId: string,
  table: "projects" | "parties",
): Promise<Map<string, string>> {
  const rows = await db.execute<{ k: string; id: string }>(
    sql`
    select custom->>'nsId' as k, id::text as id from ${sql.raw(`"${table}"`)}
     where org_id = ${orgId} and custom->>'nsId' is not null order by id for share
  `,
    "objects",
  );
  const mapped = new Map<string, string>();
  for (const row of rows) {
    const ref = String(row.k);
    if (mapped.has(ref)) {
      throw new FieldTicketSourceCertificationError(
        `source reference ${ref} maps to multiple native ${table} records; resolve the duplicate native mapping before certifying`,
      );
    }
    mapped.set(ref, String(row.id));
  }
  return mapped;
}

async function lockNativeEvidence(
  orgId: string,
  nativeDocumentId: string,
  chargeDocumentId: string | null,
): Promise<void> {
  await db.execute(
    sql`select id from document_lines where org_id = ${orgId} and document_id = ${nativeDocumentId} order by id for update`,
  );
  await db.execute(
    sql`select id from time_entries where org_id = ${orgId} and field_ticket_id = ${nativeDocumentId} order by id for update`,
  );
  await db.execute(
    sql`select id from field_ticket_labor_snapshots where org_id = ${orgId} and field_ticket_id = ${nativeDocumentId} order by id for update`,
  );
  await db.execute(
    sql`select id from field_ticket_labor_lines where org_id = ${orgId} and field_ticket_id = ${nativeDocumentId} order by id for update`,
  );
  await db.execute(
    sql`select id from field_ticket_signatures where org_id = ${orgId} and field_ticket_id = ${nativeDocumentId} order by id for update`,
  );
  await db.execute(
    sql`select id from billing_request_field_tickets where org_id = ${orgId} and field_ticket_id = ${nativeDocumentId} order by id for update`,
  );
  if (chargeDocumentId) {
    await db.execute(
      sql`select id from documents where org_id = ${orgId} and id = ${chargeDocumentId} for share`,
    );
    await db.execute(
      sql`select id from document_lines where org_id = ${orgId} and document_id = ${chargeDocumentId} order by id for update`,
    );
  }
  await db.execute(
    sql`select id from document_lines where org_id = ${orgId} and field_ticket_id = ${nativeDocumentId} order by id for update`,
  );
  await db.execute(sql`
    select id from hrm_benefit_awards where org_id = ${orgId}
     and (jsonb_path_exists(source_snapshot, '$.measurement.settlement.transaction.source.lines[*] ? (@.documentId == $documentId)', jsonb_build_object('documentId', ${nativeDocumentId}::text))
       or jsonb_path_exists(source_snapshot, '$.measurement.settlement.transaction.recipientContexts[*] ? (@.ticket_reference == $documentId)', jsonb_build_object('documentId', ${nativeDocumentId}::text)))
     order by id for share`);
}

async function readNativePointInTime(
  orgId: string,
  nativeDocumentId: string,
): Promise<Record<string, unknown>> {
  const rows = await db.execute<{
    document: Record<string, unknown>;
    fieldTicket: Record<string, unknown> | null;
    documentLines: unknown[];
    timeEntries: unknown[];
    laborSnapshots: unknown[];
    laborLines: unknown[];
    signatures: unknown[];
    billingLinks: unknown[];
    chargeDocument: Record<string, unknown> | null;
    chargeDocumentLines: unknown[];
    pointingDocumentLines: unknown[];
    awardUseIds: string[];
  }>(
    sql`
    select
      (select to_jsonb(d) || jsonb_build_object('revision_seq', d.revision_seq::text) from documents d where d.org_id = ${orgId} and d.id = ${nativeDocumentId}) as "document",
      (select to_jsonb(ft) from field_tickets ft where ft.org_id = ${orgId} and ft.document_id = ${nativeDocumentId}) as "fieldTicket",
      (select coalesce(jsonb_agg(to_jsonb(l) order by l.id), '[]'::jsonb) from document_lines l
        where l.org_id = ${orgId} and l.document_id = ${nativeDocumentId}) as "documentLines",
      (select coalesce(jsonb_agg(to_jsonb(te) order by te.id), '[]'::jsonb) from time_entries te
        where te.org_id = ${orgId} and te.field_ticket_id = ${nativeDocumentId}) as "timeEntries",
      (select coalesce(jsonb_agg(to_jsonb(s) order by s.id), '[]'::jsonb) from field_ticket_labor_snapshots s
        where s.org_id = ${orgId} and s.field_ticket_id = ${nativeDocumentId}) as "laborSnapshots",
      (select coalesce(jsonb_agg(to_jsonb(line) order by line.id), '[]'::jsonb) from field_ticket_labor_lines line
        where line.org_id = ${orgId} and line.field_ticket_id = ${nativeDocumentId}) as "laborLines",
      (select coalesce(jsonb_agg(to_jsonb(sig) order by sig.id), '[]'::jsonb) from field_ticket_signatures sig
        where sig.org_id = ${orgId} and sig.field_ticket_id = ${nativeDocumentId}) as "signatures",
      (select coalesce(jsonb_agg(to_jsonb(b) order by b.id), '[]'::jsonb) from billing_request_field_tickets b
        where b.org_id = ${orgId} and b.field_ticket_id = ${nativeDocumentId}) as "billingLinks",
      (select to_jsonb(cd) from documents cd
        where cd.org_id = ${orgId}
          and cd.id = (select ft.charge_document_id from field_tickets ft
                        where ft.org_id = ${orgId} and ft.document_id = ${nativeDocumentId})) as "chargeDocument",
      (select coalesce(jsonb_agg(to_jsonb(cl) order by cl.id), '[]'::jsonb) from document_lines cl
        where cl.org_id = ${orgId}
          and cl.document_id = (select ft.charge_document_id from field_tickets ft
                                  where ft.org_id = ${orgId} and ft.document_id = ${nativeDocumentId})) as "chargeDocumentLines",
      (select coalesce(jsonb_agg(to_jsonb(pl) order by pl.id), '[]'::jsonb) from document_lines pl
        where pl.org_id = ${orgId} and pl.field_ticket_id = ${nativeDocumentId}) as "pointingDocumentLines",
      (select coalesce(jsonb_agg(a.id order by a.id), '[]'::jsonb) from hrm_benefit_awards a
        where a.org_id = ${orgId}
          and (jsonb_path_exists(a.source_snapshot, '$.measurement.settlement.transaction.source.lines[*] ? (@.documentId == $documentId)', jsonb_build_object('documentId', ${nativeDocumentId}::text))
            or jsonb_path_exists(a.source_snapshot, '$.measurement.settlement.transaction.recipientContexts[*] ? (@.ticket_reference == $documentId)', jsonb_build_object('documentId', ${nativeDocumentId}::text))
            or exists (select 1 from document_lines l where l.org_id = ${orgId} and l.field_ticket_id = ${nativeDocumentId}
                         and jsonb_path_exists(a.source_snapshot, '$.measurement.settlement.transaction.source.lines[*] ? (@.sourceId == $lineId)', jsonb_build_object('lineId', l.id::text))))) as "awardUseIds"
  `,
    "objects",
  );
  const row = rows[0];
  if (!row?.document) {
    throw new FieldTicketSourceCertificationError(
      "the native Field Ticket is unavailable; choose an existing native ticket in this organization",
    );
  }
  return {
    document: row.document,
    fieldTicket: row.fieldTicket,
    documentLines: row.documentLines,
    timeEntries: row.timeEntries,
    laborSnapshots: row.laborSnapshots,
    laborLines: row.laborLines,
    signatures: row.signatures,
    billingLinks: row.billingLinks,
    chargeDocument: row.chargeDocument,
    chargeDocumentLines: row.chargeDocumentLines,
    pointingDocumentLines: row.pointingDocumentLines,
    awardUseIds: row.awardUseIds,
  };
}

function canonicalizeInput(
  input: CertifyFieldTicketSourceIdentityInput,
): CertifyFieldTicketSourceIdentityInput {
  const uuid = (value: string) => value.toLowerCase();
  const nullableUuid = (value: string | null) => (value === null ? null : value.toLowerCase());
  return {
    ...input,
    orgId: uuid(input.orgId),
    actorId: uuid(input.actorId),
    requestId: uuid(input.requestId),
    nativeDocumentId: uuid(input.nativeDocumentId),
    sourceFileId: uuid(input.sourceFileId),
    sourceVersionId: uuid(input.sourceVersionId),
    explicitReferenceMap: {
      ...input.explicitReferenceMap,
      projectId: uuid(input.explicitReferenceMap.projectId),
      customerPartyId: nullableUuid(input.explicitReferenceMap.customerPartyId),
      foremanPartyId: nullableUuid(input.explicitReferenceMap.foremanPartyId),
      superintendentPartyId: nullableUuid(input.explicitReferenceMap.superintendentPartyId),
    },
  };
}

export async function certifyFieldTicketSourceIdentity(
  rawInput: CertifyFieldTicketSourceIdentityInput,
): Promise<FieldTicketSourceCertificationResult> {
  validateInput(rawInput);
  const input = canonicalizeInput(rawInput);
  const { orgId, actorId } = input;
  const attestation = input.attestation.trim();
  const reason = input.reason.trim();
  const payloadSha256 = fieldTicketSourceCertificationRequestSha256(actorId, input);
  return withOrgTransaction(orgId, async () => {
    const allowed = await lockActorCommandAuthority(db, orgId, actorId, null, "time.manage");
    await acquireOrgFeatureGateLock(db, orgId);
    if (!(await lockAndCheckOrgFeature(db, orgId, "fieldTickets"))) {
      throw new FieldTicketSourceCertificationError(
        "enable Projects and Field Tickets in Company Settings → Features before certifying Field Ticket source identity",
      );
    }

    // One canonical request fence first, so a single request identity
    // raced across different source or native pairs serializes before
    // either side can miss the retained certificate; then the importer's
    // fences in its order: source identity, then the native ticket number.
    await db.execute(sql`
      select pg_advisory_xact_lock(hashtextextended(${`field-ticket-source-certification-request:${orgId}:${input.requestId}`}, 0))
    `);
    await db.execute(sql`
      select pg_advisory_xact_lock(hashtextextended(${`field-ticket-source:${orgId}:${input.sourceSystem}:${input.sourceTicketId}`}, 0))
    `);
    const preliminary = (
      await db.execute<{
        document_number: string;
        project_id: string | null;
        subsidiary_id: string | null;
      }>(
        sql`
      select document_number, project_id::text, subsidiary_id::text from documents
       where org_id = ${orgId} and id = ${input.nativeDocumentId} and kind = 'field_ticket'
    `,
        "objects",
      )
    )[0];
    if (!preliminary) {
      throw new FieldTicketSourceCertificationError(
        "the native Field Ticket is unavailable; choose an existing native ticket in this organization",
      );
    }
    await db.execute(sql`
      select pg_advisory_xact_lock(hashtextextended(${`field-ticket-import:${orgId}:${preliminary.document_number}`}, 0))
    `);

    // The selected ticket and its project are locked and scope-checked
    // before any evidence is read, so admission and the facts it judges
    // cannot be separated by a concurrent rehome.
    await lockScopeRows(
      db,
      orgId,
      [{ kind: "document", id: input.nativeDocumentId }],
      allowed,
      "update",
    );
    if (!preliminary.project_id) {
      throw new FieldTicketSourceCertificationError(
        "the native Field Ticket has no project; assign its project before certifying its source identity",
      );
    }
    if (!preliminary.subsidiary_id || !subsidiaryScopeAllows(allowed, preliminary.subsidiary_id)) {
      throw new FieldTicketSourceCertificationError(
        "the native Field Ticket is outside your legal-entity scope",
      );
    }
    const projectScope = await lockScopeRows(
      db,
      orgId,
      [{ kind: "project", id: preliminary.project_id }],
      allowed,
      "share",
    );
    if (projectScope[0]?.subsidiaryId !== preliminary.subsidiary_id) {
      throw new FieldTicketSourceCertificationError(
        "the native Field Ticket's project and legal entity do not agree; correct the native ticket through its supported lifecycle before certifying",
      );
    }

    await requireNativeFileReadAuthority({ orgId, actorId, fileId: input.sourceFileId }, db);

    const headerRow = (
      await db.execute<{
        period_start: string;
        period_end: string;
        foreman_party_id: string | null;
        superintendent_party_id: string | null;
        charge_document_id: string | null;
      }>(
        sql`
      select period_start::text, period_end::text, foreman_party_id::text,
             superintendent_party_id::text, charge_document_id::text
        from field_tickets where org_id = ${orgId} and document_id = ${input.nativeDocumentId} for update
    `,
        "objects",
      )
    )[0];
    if (!headerRow) {
      throw new FieldTicketSourceCertificationError(
        "the native Field Ticket header is unavailable; choose a complete native ticket in this organization",
      );
    }
    await lockNativeEvidence(orgId, input.nativeDocumentId, headerRow.charge_document_id);

    const before = await readNativePointInTime(orgId, input.nativeDocumentId);
    const document = before.document as Record<string, unknown>;
    const revisionToken = String(document.revision_seq);
    const documentNumber = String(document.document_number);
    const projectId = document.project_id ? String(document.project_id) : null;
    const subsidiaryId = document.subsidiary_id ? String(document.subsidiary_id) : null;
    if (document.kind !== "field_ticket" || !projectId || !subsidiaryId) {
      throw new FieldTicketSourceCertificationError(
        "the native Field Ticket is unavailable; choose an existing native ticket in this organization",
      );
    }

    // Replay and conflict admission reads the retained certificates under
    // lock: one source pair and one native ticket may be certified once.
    const existingCertifications = await db.execute<{
      id: string;
      request_id: string;
      request_payload_sha256: string;
      certified_by: string;
      native_document_id: string;
      source_system: string;
      source_external_id: string;
    }>(
      sql`
      select id::text, request_id::text, request_payload_sha256, certified_by::text,
             native_document_id::text, source_system, source_external_id
        from field_ticket_source_certifications
       where org_id = ${orgId}
         and (request_id = ${input.requestId}
           or native_document_id = ${input.nativeDocumentId}
           or (source_system = ${input.sourceSystem} and source_external_id = ${input.sourceTicketId}))
       order by id for share
    `,
      "objects",
    );
    const replay = existingCertifications.find((row) => row.request_id === input.requestId);
    if (replay) {
      if (
        replay.certified_by === actorId &&
        replay.request_payload_sha256 === payloadSha256 &&
        replay.native_document_id === input.nativeDocumentId &&
        replay.source_system === input.sourceSystem &&
        replay.source_external_id === input.sourceTicketId
      ) {
        return {
          id: replay.id,
          nativeDocumentId: input.nativeDocumentId,
          sourceSystem: input.sourceSystem,
          sourceExternalId: input.sourceTicketId,
          replayed: true,
        };
      }
      throw new FieldTicketSourceCertificationError(
        "this certification request already preserves different evidence; reload and review its retained result",
      );
    }
    if (existingCertifications.length > 0) {
      throw new FieldTicketSourceCertificationError(
        "this source ticket or native ticket already carries a governed source-identity certification; a conflicting identity cannot be certified",
      );
    }

    // Source ownership lives on native documents as well as in the
    // certificate table: a source-born ticket imported before this
    // certificate existed already represents this source pair, and no
    // second native representation may be certified for it. The held
    // source fence serializes this read against the importer. The
    // refusal names no other record: a foreign owner is not disclosed.
    const otherOwners = await db.execute<{ id: string }>(
      sql`
      select id from documents
       where org_id = ${orgId} and kind = 'field_ticket' and id <> ${input.nativeDocumentId}
         and custom->'source'->>'system' = ${input.sourceSystem}
         and custom->'source'->>'externalId' = ${input.sourceTicketId}
       order by id for share
    `,
      "objects",
    );
    if (otherOwners.length > 0) {
      throw new FieldTicketSourceCertificationError(
        "this source ticket is already represented by another native Field Ticket; reconcile the duplicate source representation before certifying",
      );
    }

    const marker = classifyExistingSourceMarker(
      document.custom,
      input.sourceSystem,
      input.sourceTicketId,
    );
    if (marker === "partial") {
      throw new FieldTicketSourceCertificationError(
        "the native ticket carries a partial source marker; reconcile its stored source identity through the supported correction lifecycle before certifying",
      );
    }
    if (marker === "conflict") {
      throw new FieldTicketSourceCertificationError(
        "the native ticket already carries a different source identity; a conflicting identity cannot be certified",
      );
    }
    if (marker === "exact") {
      throw new FieldTicketSourceCertificationError(
        "the native ticket already carries this exact source identity; certification cannot adopt a stored marker without its governed certificate",
      );
    }
    try {
      assertDocumentEditRevision(input.expectedNativeRevision, revisionToken);
    } catch (error) {
      if (error instanceof DocumentEditError) {
        throw new FieldTicketSourceCertificationError(
          "the native ticket changed after it was reviewed; reload its current revision and review the certification again",
        );
      }
      throw error;
    }

    // Actual retained bytes — never a client-asserted row or hash — prove
    // the reviewed source row is a member of the pinned file version.
    const retained = await db.execute<{
      is_inactive: boolean;
      content_hash: string | null;
      storage_kind: string;
      bytes: Buffer | null;
    }>(
      sql`
      select file.is_inactive, version.content_hash, version.storage_kind, blob.bytes
        from files file
        join file_versions version on version.file_id = file.id
        left join file_blobs blob on blob.version_id = version.id
       where file.org_id = ${orgId} and file.id = ${input.sourceFileId}
         and version.id = ${input.sourceVersionId}
       for share of file, version
    `,
      "objects",
    );
    if (retained.length !== 1 || retained[0]!.is_inactive) {
      throw new FieldTicketSourceCertificationError(
        "the pinned source file version is unavailable; retain the exact source export in the File Cabinet and certify against its active version",
      );
    }
    refuseMaskedStorageKind(retained[0]!.storage_kind);
    const bytes =
      retained[0]!.storage_kind === "s3"
        ? await getS3Blob(input.sourceVersionId)
        : retained[0]!.bytes;
    if (!bytes) {
      throw new FieldTicketSourceCertificationError(
        "the pinned source file's bytes are unavailable; retain the exact source export in the File Cabinet and certify against its readable version",
      );
    }
    const fileSha256 = createHash("sha256").update(bytes).digest("hex");
    if (
      fileSha256 !== input.sourceFileSha256 ||
      retained[0]!.content_hash !== input.sourceFileSha256
    ) {
      throw new FieldTicketSourceCertificationError(
        "the pinned source file version no longer matches its reviewed hash; review the exact retained version before certifying",
      );
    }
    let sourceRow: FieldTicketSourceHeaderRow;
    try {
      sourceRow = findFieldTicketSourceHeaderRow(
        parseFieldTicketSourceHeaders(bytes),
        input.sourceTicketId,
      );
    } catch (error) {
      if (error instanceof FieldTicketSourceHeaderError)
        throw new FieldTicketSourceCertificationError(error.message);
      throw error;
    }
    const sourceRowSha256 = fieldTicketSourceHeaderRowSha256(sourceRow);

    // Explicit reference map: source references resolve through the native
    // nsId maps, the reviewer-supplied native ids must agree with that
    // resolution, and the resolved facts must agree with the native ticket.
    const projectsByRef = await resolveNativeReferenceMap(orgId, "projects");
    const partiesByRef = await resolveNativeReferenceMap(orgId, "parties");
    const map = input.explicitReferenceMap;
    const resolvedProjectId = projectsByRef.get(sourceRow.jobRef);
    if (
      map.jobRef !== sourceRow.jobRef ||
      !resolvedProjectId ||
      map.projectId !== resolvedProjectId
    ) {
      throw new FieldTicketSourceCertificationError(
        `source job ${sourceRow.jobRef} does not resolve through the native project map to the reviewed project; map the source job before certifying`,
      );
    }
    const resolvedCustomerId = sourceRow.customerRef
      ? (partiesByRef.get(sourceRow.customerRef) ?? null)
      : null;
    if (sourceRow.customerRef && !resolvedCustomerId) {
      throw new FieldTicketSourceCertificationError(
        `source customer ${sourceRow.customerRef} is not mapped to a native party; map the source customer before certifying`,
      );
    }
    if (
      (map.customerRef ?? null) !== (sourceRow.customerRef || null) ||
      map.customerPartyId !== resolvedCustomerId
    ) {
      throw new FieldTicketSourceCertificationError(
        "the explicit reference map's customer does not match the source row's mapped native customer",
      );
    }
    if (resolvedCustomerId) {
      const customerRole = await db.execute(
        sql`
        select party_id from customer_roles where org_id = ${orgId} and party_id = ${resolvedCustomerId} for share
      `,
        "objects",
      );
      if (customerRole.length !== 1) {
        throw new FieldTicketSourceCertificationError(
          `source customer ${sourceRow.customerRef} does not resolve to a native customer; map the source customer before certifying`,
        );
      }
    }
    const resolvedForemanId = sourceRow.foremanRef
      ? (partiesByRef.get(sourceRow.foremanRef) ?? null)
      : null;
    if (sourceRow.foremanRef && !resolvedForemanId) {
      throw new FieldTicketSourceCertificationError(
        `source foreman ${sourceRow.foremanRef} is not mapped to a native party; map the source foreman before certifying`,
      );
    }
    if (
      (map.foremanRef ?? null) !== sourceRow.foremanRef ||
      map.foremanPartyId !== resolvedForemanId
    ) {
      throw new FieldTicketSourceCertificationError(
        "the explicit reference map's foreman does not match the source row's mapped native foreman",
      );
    }
    const sourceSuperintendentRef =
      sourceRow.superintendentRef === undefined ? undefined : sourceRow.superintendentRef;
    const resolvedSuperintendentId = sourceSuperintendentRef
      ? (partiesByRef.get(sourceSuperintendentRef) ?? null)
      : null;
    if (sourceSuperintendentRef && !resolvedSuperintendentId) {
      throw new FieldTicketSourceCertificationError(
        `source superintendent ${sourceSuperintendentRef} is not mapped to a native party; map the source superintendent before certifying`,
      );
    }
    if (
      sourceSuperintendentRef !== undefined &&
      ((map.superintendentRef ?? null) !== sourceSuperintendentRef ||
        map.superintendentPartyId !== resolvedSuperintendentId)
    ) {
      throw new FieldTicketSourceCertificationError(
        "the explicit reference map's superintendent does not match the source row's mapped native superintendent",
      );
    }
    await lockScopeRows(
      db,
      orgId,
      [resolvedCustomerId, resolvedForemanId, resolvedSuperintendentId].flatMap((partyId) =>
        partyId ? [{ kind: "party" as const, id: partyId }] : [],
      ),
      allowed,
      "share",
      { orgWideNull: true },
    );

    // Source/native header divergence belongs to a separate supported
    // correction lifecycle; certification never rewrites it to agree.
    if (documentNumber !== sourceRow.number) {
      throw new FieldTicketSourceCertificationError(
        `the native ticket number ${documentNumber} does not match source ticket ${sourceRow.sourceId} number ${sourceRow.number}; reconcile the identity through the supported correction lifecycle before certifying`,
      );
    }
    if (projectId !== resolvedProjectId || subsidiaryId !== projectScope[0]?.subsidiaryId) {
      throw new FieldTicketSourceCertificationError(
        "the native ticket's project or legal entity does not match the reviewed source job; correct the native ticket through its supported lifecycle before certifying",
      );
    }
    if ((document.party_id ? String(document.party_id) : null) !== resolvedCustomerId) {
      throw new FieldTicketSourceCertificationError(
        "the native ticket's customer does not match the reviewed source customer; correct the native ticket through its supported lifecycle before certifying",
      );
    }
    if (headerRow.foreman_party_id !== resolvedForemanId) {
      throw new FieldTicketSourceCertificationError(
        "the native ticket's foreman does not match the reviewed source foreman; correct the native ticket through its supported lifecycle before certifying",
      );
    }
    if (
      sourceSuperintendentRef !== undefined &&
      headerRow.superintendent_party_id !== resolvedSuperintendentId
    ) {
      throw new FieldTicketSourceCertificationError(
        "the native ticket's superintendent does not match the reviewed source superintendent; correct the native ticket through its supported lifecycle before certifying",
      );
    }
    if (headerRow.period_start !== sourceRow.begin || headerRow.period_end !== sourceRow.end) {
      throw new FieldTicketSourceCertificationError(
        "the native ticket's work period does not match the reviewed source row; correct the native ticket through its supported lifecycle before certifying",
      );
    }

    const referenceMap = {
      job: { sourceRef: sourceRow.jobRef, nativeId: resolvedProjectId },
      customer: { sourceRef: sourceRow.customerRef || null, nativeId: resolvedCustomerId },
      foreman: { sourceRef: sourceRow.foremanRef, nativeId: resolvedForemanId },
      superintendent: {
        sourceRef: sourceSuperintendentRef ?? null,
        nativeId: resolvedSuperintendentId,
      },
      employee: { sourceRef: sourceRow.empRef, nativeId: null },
    };
    const nativeFingerprintSha256 = nativePointInTimeFingerprint(before);

    const inserted = await db.execute<{ id: string }>(
      sql`
      insert into field_ticket_source_certifications
        (org_id, native_document_id, native_document_number, native_project_id, native_subsidiary_id,
         source_system, source_external_id, source_file_id, source_version_id, source_file_sha256,
         source_row_sha256, source_row_snapshot, reviewed_basis, attestation, reason, reference_map,
         native_revision_at_certification, native_point_in_time, native_fingerprint_sha256,
         request_id, request_payload_sha256, certified_by)
      values (${orgId}, ${input.nativeDocumentId}, ${documentNumber}, ${projectId}, ${subsidiaryId},
        ${input.sourceSystem}, ${input.sourceTicketId}, ${input.sourceFileId}, ${input.sourceVersionId}, ${input.sourceFileSha256},
        ${sourceRowSha256}, ${JSON.stringify(sourceRow)}::jsonb, 'human_reviewed_crosswalk_operator_attestation',
        ${attestation}, ${reason}, ${JSON.stringify(referenceMap)}::jsonb,
        ${revisionToken}::bigint, ${JSON.stringify(before)}::jsonb, ${nativeFingerprintSha256},
        ${input.requestId}, ${payloadSha256}, ${actorId})
      returning id::text
    `,
      "objects",
    );
    if (inserted.length !== 1 || !inserted[0]?.id) {
      throw new FieldTicketSourceCertificationError(
        "the source-identity certification was not retained",
      );
    }
    const certificationId = inserted[0].id;

    // Metadata-only projection: the exact source pair plus the existing
    // importer metadata facts, preserving every other custom key. The
    // storage projection guard admits this write from the certificate
    // inserted above.
    const sourceMetadata = {
      system: input.sourceSystem,
      externalId: input.sourceTicketId,
      number: sourceRow.number,
      jobRef: sourceRow.jobRef,
      empRef: sourceRow.empRef,
      foremanRef: sourceRow.foremanRef,
      superintendentRef: sourceRow.superintendentRef ?? null,
      periodBegin: sourceRow.begin,
      periodEnd: sourceRow.end,
      billed: sourceRow.billed,
      finalTicket: sourceRow.final,
      approval: sourceRow.approval,
    };
    const updated = await db.execute<{ id: string }>(
      sql`
      update documents
         set custom = custom || ${JSON.stringify({ source: sourceMetadata })}::jsonb,
             updated_by = ${actorId}, updated_at = now()
       where org_id = ${orgId} and id = ${input.nativeDocumentId} and revision_seq = ${revisionToken}::bigint
      returning id::text
    `,
      "objects",
    );
    if (updated.length !== 1) {
      throw new FieldTicketSourceCertificationError(
        "the native ticket changed while its source identity was certified; the certification was not projected",
      );
    }

    const after = await readNativePointInTime(orgId, input.nativeDocumentId);
    if (!certificationProjectionChangesOnlyMetadata(before, after)) {
      throw new FieldTicketSourceCertificationError(
        "certification would change native financial, time or work facts; it is metadata-only and was refused",
      );
    }
    const afterDocument = after.document as Record<string, unknown>;
    if (
      classifyExistingSourceMarker(
        afterDocument.custom,
        input.sourceSystem,
        input.sourceTicketId,
      ) !== "exact"
    ) {
      throw new FieldTicketSourceCertificationError(
        "the certified source identity is not observable on the native ticket; the certification was not projected",
      );
    }

    const audit = await db.execute(
      sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id, request_id)
      values (${orgId}, 'documents', ${input.nativeDocumentId}, 'update',
        ${JSON.stringify({
          reason: "field_ticket_source_identity_certification",
          certificationId,
          sourceSystem: input.sourceSystem,
          sourceExternalId: input.sourceTicketId,
          reviewedBasis: "human_reviewed_crosswalk_operator_attestation",
          attestation,
          certificationReason: reason,
          before: { document: before.document },
          after: { document: after.document },
        })}::jsonb,
        ${actorId}, ${input.requestId})
      returning id
    `,
      "objects",
    );
    if (audit.length !== 1) {
      throw new FieldTicketSourceCertificationError(
        "the source-identity certification was not audited",
      );
    }

    return {
      id: certificationId,
      nativeDocumentId: input.nativeDocumentId,
      sourceSystem: input.sourceSystem,
      sourceExternalId: input.sourceTicketId,
      replayed: false,
    };
  });
}

export interface FieldTicketSourceCertificationCandidate {
  nativeDocumentId: string;
  documentNumber: string;
  /** The exact counter token from `documentRevisionCounterSql`, as a string. */
  revision: string;
  projectId: string | null;
  subsidiaryId: string | null;
  status: string;
  sourceSystem: string | null;
  sourceExternalId: string | null;
  certificationId: string | null;
}

/**
 * Discovery for the certification review: actor-scoped native ticket ids,
 * numbers and current revisions, with any identity already certified. It
 * never guesses a source identity from a number or work facts.
 */
export async function listFieldTicketSourceCertificationCandidates(input: {
  orgId: string;
  actorId: string;
}): Promise<{ tickets: FieldTicketSourceCertificationCandidate[] }> {
  if (!isUuid(input.orgId) || !isUuid(input.actorId)) {
    throw new FieldTicketSourceCertificationError(
      "choose an authorized operator of the target organization",
    );
  }
  const orgId = input.orgId.toLowerCase();
  const actorId = input.actorId.toLowerCase();
  return withOrgTransaction(orgId, async () => {
    const allowed = await lockActorCommandAuthority(db, orgId, actorId, null, "time.read");
    if (!(await lockAndCheckOrgFeature(db, orgId, "fieldTickets"))) {
      throw new FieldTicketSourceCertificationError(
        "enable Projects and Field Tickets in Company Settings → Features before reviewing Field Ticket source identity",
      );
    }
    const scopeFilter =
      allowed === null
        ? sql``
        : allowed.size
          ? sql` and d.subsidiary_id = any(${sql.param([...allowed])}::uuid[])`
          : sql` and false`;
    const rows = await db.execute<{
      nativeDocumentId: string;
      documentNumber: string;
      revision: string;
      projectId: string | null;
      subsidiaryId: string | null;
      status: string;
      sourceSystem: string | null;
      sourceExternalId: string | null;
      certificationId: string | null;
    }>(
      sql`
      select d.id::text as "nativeDocumentId", d.document_number as "documentNumber",
             ${documentRevisionCounterSql(sql.raw("d.revision_seq"))} as "revision", d.project_id::text as "projectId",
             d.subsidiary_id::text as "subsidiaryId", d.status,
             cert.source_system as "sourceSystem", cert.source_external_id as "sourceExternalId",
             cert.id::text as "certificationId"
        from documents d
        join field_tickets ft on ft.org_id = d.org_id and ft.document_id = d.id
        left join field_ticket_source_certifications cert
          on cert.org_id = d.org_id and cert.native_document_id = d.id
       where d.org_id = ${orgId} and d.kind = 'field_ticket'${scopeFilter}
       order by d.document_number, d.id
       limit 500
    `,
      "objects",
    );
    return {
      tickets: rows.map((row) => ({
        nativeDocumentId: row.nativeDocumentId,
        documentNumber: row.documentNumber,
        revision: row.revision,
        projectId: row.projectId,
        subsidiaryId: row.subsidiaryId,
        status: row.status,
        sourceSystem: row.sourceSystem,
        sourceExternalId: row.sourceExternalId,
        certificationId: row.certificationId,
      })),
    };
  });
}
