import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { id, orgRef } from "./helpers";
import { documents } from "./documents";
import { projects } from "./core";
import { subsidiaries } from "./subsidiaries";
import { files, fileVersions } from "./file-cabinet";
import { users } from "./extension";

/**
 * A human-reviewed binding between one native Field Ticket and one exact
 * external source ticket.
 *
 * File membership alone does not prove lineage: the retained source file,
 * its pinned version and the parsed row establish which source row was
 * reviewed, while the authenticated operator's attestation and reason
 * supply the mapping authority. The certificate is append-only and
 * certifies identity metadata only — never hours, amounts, roles, rates or
 * any later source-charge admission.
 */
export const fieldTicketSourceCertifications = pgTable(
  "field_ticket_source_certifications",
  {
    id: id(),
    orgId: orgRef(),
    nativeDocumentId: uuid("native_document_id").notNull(),
    nativeDocumentNumber: text("native_document_number").notNull(),
    nativeProjectId: uuid("native_project_id").notNull(),
    nativeSubsidiaryId: uuid("native_subsidiary_id").notNull(),
    sourceSystem: text("source_system").notNull(),
    sourceExternalId: text("source_external_id").notNull(),
    sourceFileId: uuid("source_file_id").notNull(),
    sourceVersionId: uuid("source_version_id").notNull(),
    sourceFileSha256: text("source_file_sha256").notNull(),
    sourceRowSha256: text("source_row_sha256").notNull(),
    sourceRowSnapshot: jsonb("source_row_snapshot").$type<Record<string, unknown>>().notNull(),
    reviewedBasis: text("reviewed_basis").notNull(),
    attestation: text("attestation").notNull(),
    reason: text("reason").notNull(),
    referenceMap: jsonb("reference_map").$type<Record<string, unknown>>().notNull(),
    nativeRevisionAtCertification: bigint("native_revision_at_certification", {
      mode: "bigint",
    }).notNull(),
    nativePointInTime: jsonb("native_point_in_time").$type<Record<string, unknown>>().notNull(),
    nativeFingerprintSha256: text("native_fingerprint_sha256").notNull(),
    requestId: uuid("request_id").notNull(),
    requestPayloadSha256: text("request_payload_sha256").notNull(),
    certifiedBy: uuid("certified_by").notNull(),
    certifiedAt: timestamp("certified_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("field_ticket_source_certifications_org_id_unique").on(t.orgId, t.id),
    uniqueIndex("field_ticket_source_certifications_source_unique").on(
      t.orgId,
      t.sourceSystem,
      t.sourceExternalId,
    ),
    uniqueIndex("field_ticket_source_certifications_native_unique").on(t.orgId, t.nativeDocumentId),
    uniqueIndex("field_ticket_source_certifications_request_unique").on(t.orgId, t.requestId),
    index("field_ticket_source_certifications_native").on(t.orgId, t.nativeDocumentId),
    index("field_ticket_source_certifications_file").on(t.orgId, t.sourceFileId, t.sourceVersionId),
    foreignKey({
      name: "field_ticket_source_certifications_document_fk",
      columns: [t.orgId, t.nativeDocumentId],
      foreignColumns: [documents.orgId, documents.id],
    }),
    foreignKey({
      name: "field_ticket_source_certifications_project_fk",
      columns: [t.orgId, t.nativeProjectId],
      foreignColumns: [projects.orgId, projects.id],
    }),
    foreignKey({
      name: "field_ticket_source_certifications_subsidiary_fk",
      columns: [t.orgId, t.nativeSubsidiaryId],
      foreignColumns: [subsidiaries.orgId, subsidiaries.id],
    }),
    foreignKey({
      name: "field_ticket_source_certifications_file_fk",
      columns: [t.orgId, t.sourceFileId],
      foreignColumns: [files.orgId, files.id],
    }),
    foreignKey({
      name: "field_ticket_source_certifications_version_fk",
      columns: [t.sourceFileId, t.sourceVersionId],
      foreignColumns: [fileVersions.fileId, fileVersions.id],
    }),
    foreignKey({
      name: "field_ticket_source_certifications_actor_fk",
      columns: [t.certifiedBy],
      foreignColumns: [users.id],
    }),
    check(
      "field_ticket_source_certifications_identity",
      sql`${t.sourceSystem} ~* '^[a-z0-9][a-z0-9._-]{0,63}$'
        and char_length(btrim(${t.sourceExternalId})) between 1 and 200
        and ${t.sourceExternalId} = btrim(${t.sourceExternalId})
        and char_length(btrim(${t.nativeDocumentNumber})) between 1 and 200`,
    ),
    check(
      "field_ticket_source_certifications_hashes",
      sql`${t.sourceFileSha256} ~ '^[a-f0-9]{64}$'
        and ${t.sourceRowSha256} ~ '^[a-f0-9]{64}$'
        and ${t.nativeFingerprintSha256} ~ '^[a-f0-9]{64}$'
        and ${t.requestPayloadSha256} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      "field_ticket_source_certifications_review",
      sql`${t.reviewedBasis} = 'human_reviewed_crosswalk_operator_attestation'
        and char_length(btrim(${t.attestation})) between 8 and 2000
        and char_length(btrim(${t.reason})) between 8 and 2000
        and jsonb_typeof(${t.sourceRowSnapshot}) = 'object'
        and jsonb_typeof(${t.referenceMap}) = 'object'
        and jsonb_typeof(${t.nativePointInTime}) = 'object'
        and ${t.nativeRevisionAtCertification} >= 0`,
    ),
  ],
);
