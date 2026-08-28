import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { auditColumns, currencyCode, id, money, orgRef } from "./helpers";

/**
 * Payroll direct-deposit artifacts — the immutable evidence half of the
 * bank-file control.
 *
 * A payroll bank file is an INSTRUCTION TO MOVE REAL MONEY. Once the bytes
 * have been produced they are frozen, hashed, numbered, and every release of
 * them is attributable, because the failure modes are not recoverable: a file
 * released twice pays every employee twice, and a file whose trailer disagrees
 * with the ledger reconciles to nothing.
 *
 * Modelled on the AP artifact (`payment_files`, schema/src/payment-operations.ts)
 * deliberately — same lineage columns, same file-cabinet blob storage, same
 * supersede chain — so an auditor reads one pattern for both money rails
 * rather than two. The differences are payroll's:
 *
 * - `excluded_cheque` records who was deliberately LEFT OFF the file and why.
 *   The bank file is EFT-only; a cheque employee credited here as well as
 *   handed paper is paid twice, so the exclusion list is evidence, not a
 *   debugging aid — it is what the operator reconciles the payday against.
 * - `control_total` is the file's trailer total, re-read out of the stored
 *   bytes at generation and asserted against the run's EFT net pay. It is
 *   persisted so the assertion can be re-checked later without re-parsing.
 * - `file_creation_number` / `file_id_modifier` are the bank-facing sequence
 *   identifiers, allocated ONCE per artifact off `number_sequences` and stored
 *   here. They are never re-derived at download time: a file the bank has
 *   already seen must keep the number it was sent under.
 *
 * There is no `openbooks_query` view for this table on purpose. Its rows point
 * at the exact per-employee credit instructions for a payday; the governed
 * query catalogue is curated free of payroll PII.
 */
export const payRunBankFiles = pgTable(
  "pay_run_bank_files",
  {
    id: id(),
    orgId: orgRef(),
    /** The pay run (documents.id, kind = 'pay_run') this file pays. */
    payRunDocumentId: uuid("pay_run_document_id").notNull(),
    /**
     * The tenant's originator configuration this file was built from
     * (payment_bank_profiles). Institution-specific values — originator id,
     * data centre, ODFI routing, company id — are NEVER invented by the
     * engine; they come from the profile the operator selected, and the
     * selection is recorded here so the file can be traced back to it.
     */
    paymentBankProfileId: uuid("payment_bank_profile_id").notNull(),
    format: text("format", { enum: ["cpa005", "nacha"] }).notNull(),
    /** Nth artifact for this run. 2+ means a regeneration happened — see status. */
    sequenceNumber: integer("sequence_number").notNull(),
    /** Human number off `number_sequences` (kind `payroll_bank_file`). */
    fileNumber: text("file_number").notNull(),
    /** The integer allocated from the sequence, before format-specific mapping. */
    sequenceValue: integer("sequence_value").notNull(),
    /** CPA-005 file creation number (1–9999), unique per originator per file. */
    fileCreationNumber: integer("file_creation_number"),
    /** NACHA file ID modifier (A–Z, 0–9), distinguishes files created same day. */
    fileIdModifier: text("file_id_modifier"),
    filename: text("filename").notNull(),
    contentType: text("content_type").notNull(),
    /** sha256 of the exact bytes, hex. Re-verified on every download. */
    contentHash: text("content_hash").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    /** File Cabinet storage (private system folder — payroll.run only). */
    fileId: uuid("file_id").notNull(),
    fileVersionId: uuid("file_version_id").notNull(),
    /** Credits on the file. */
    entryCount: integer("entry_count").notNull(),
    /** The file's trailer total — asserted equal to the run's EFT net pay. */
    controlTotal: money("control_total").notNull(),
    currency: currencyCode("currency").notNull(),
    /** Employees settled on paper: [{ employeePartyId, employeeName, amount, reason }]. */
    excludedCheque: jsonb("excluded_cheque")
      .$type<{ employeePartyId: string; employeeName: string; amount: string; reason: string }[]>()
      .notNull()
      .default([]),
    /** Net pay of the excluded cheque population; + controlTotal = run net pay. */
    excludedTotal: money("excluded_total").notNull().default("0"),
    /**
     * `generated` → nothing has left the building yet; `released` → the bytes
     * have been downloaded at least once and must be assumed to be at the
     * bank; `superseded` → a later artifact replaced it, with a reason.
     */
    status: text("status", { enum: ["generated", "released", "superseded"] })
      .notNull()
      .default("generated"),
    generatedAt: timestamp("generated_at", { withTimezone: true }).notNull().defaultNow(),
    generatedBy: uuid("generated_by"),
    firstReleasedAt: timestamp("first_released_at", { withTimezone: true }),
    lastReleasedAt: timestamp("last_released_at", { withTimezone: true }),
    /** How many times the bytes have been handed out. Every one is in audit_log. */
    releaseCount: integer("release_count").notNull().default(0),
    /** Set on the OLD artifact when a replacement is generated. */
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    supersededBy: uuid("superseded_by"),
    supersededByFileId: uuid("superseded_by_file_id"),
    /**
     * Why a replacement was generated. Required, because the operator now
     * holds two files for one payday and has to be able to tell the bank —
     * and a later auditor — which one is live and why.
     */
    supersedeReason: text("supersede_reason"),
    ...auditColumns,
  },
  (t) => [
    uniqueIndex("pay_run_bank_files_run_sequence").on(t.payRunDocumentId, t.sequenceNumber),
    index("pay_run_bank_files_run_status").on(t.payRunDocumentId, t.status),
    index("pay_run_bank_files_hash").on(t.orgId, t.contentHash),
    // A superseded artifact must carry its reason: the whole point of the
    // status is that the replacement was a deliberate, explained act.
    check(
      "pay_run_bank_files_supersede_evidence",
      sql`status <> 'superseded' or (superseded_at is not null and superseded_by is not null
           and supersede_reason is not null and length(btrim(supersede_reason)) between 5 and 500)`,
    ),
    // Generated files have no release evidence; released files have a count
    // and both timestamps. Superseded files retain either complete state,
    // because the old artifact may have left the building before replacement.
    // "downloaded but no evidence" and "generated after download" must not be
    // representable.
    check(
      "pay_run_bank_files_release_evidence",
      sql`(status in ('generated', 'superseded')
            and release_count = 0
            and first_released_at is null
            and last_released_at is null)
          or (status in ('released', 'superseded')
            and release_count > 0
            and first_released_at is not null
            and last_released_at is not null)`,
    ),
    check("pay_run_bank_files_entry_count", sql`entry_count > 0`),
    check("pay_run_bank_files_control_total", sql`control_total > 0`),
    // Format-specific bank numbering must be present, and only for its format.
    check(
      "pay_run_bank_files_format_numbering",
      sql`(format = 'cpa005' and file_creation_number between 1 and 9999 and file_id_modifier is null)
          or (format = 'nacha' and file_id_modifier ~ '^[A-Z0-9]$' and file_creation_number is null)`,
    ),
  ],
);
