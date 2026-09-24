import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { PgTableExtraConfigValue } from "drizzle-orm/pg-core";
import { auditColumns, currencyCode, id, money, orgRef } from "./helpers";
import { accounts } from "./coa";
import { paymentSchedules } from "./payment-operations";

/**
 * Banking: statement import → matching → reconciliation sign-off, and
 * outbound payment runs (EFT/ACH/cheque batches). Statement lines are the
 * immutable imported truth; matches connect them to journal lines.
 */

export const bankStatements = pgTable(
  "bank_statements",
  {
    id: id(),
    orgId: orgRef(),
    accountId: uuid("account_id").notNull(), // → accounts (reconcilable)
    source: text("source", { enum: ["ofx", "csv", "camt053", "bai2", "mt940", "feed_api", "manual"] }).notNull(),
    statementDate: date("statement_date").notNull(),
    openingBalance: money("opening_balance"),
    closingBalance: money("closing_balance"),
    importedAt: timestamp("imported_at", { withTimezone: true }).notNull().defaultNow(),
    /**
     * Stable pointer to append-only source evidence. Current imports use an
     * `audit-log:<id>#sha256=<hash>` exact-byte reference. Statements imported
     * before source retention use an explicit
     * `audit-log:<id>#evidence=legacy-source-unavailable` attestation instead.
     */
    rawFileRef: text("raw_file_ref").notNull(),
    /** Exact-byte identity used to make retries idempotent per bank account. */
    sourceFileSha256: text("source_file_sha256"),
    ...auditColumns,
  },
  (t) => [
    index("statements_account_date").on(t.accountId, t.statementDate),
    uniqueIndex("bank_statements_org_account_source_sha256")
      .on(t.orgId, t.accountId, t.sourceFileSha256)
      .where(sql`${t.sourceFileSha256} is not null`),
    check(
      "bank_statements_source_file_sha256",
      sql`${t.sourceFileSha256} is null or ${t.sourceFileSha256} ~ '^[0-9a-f]{64}$'`,
    ),
  ],
);

export const bankStatementLines = pgTable(
  "bank_statement_lines",
  {
    id: id(),
    orgId: orgRef(),
    statementId: uuid("statement_id").notNull(),
    /** Denormalized from the statement and DB-constrained for per-account source-id uniqueness. */
    accountId: uuid("account_id").notNull(),
    lineNumber: integer("line_number").notNull(),
    postedOn: date("posted_on").notNull(),
    amount: money("amount").notNull(), // signed from the bank's perspective
    currency: currencyCode("currency").notNull(),
    description: text("description"),
    counterpartyRef: text("counterparty_ref"),
    /** Source-provided dedupe key; null when the source supplies no sound transaction identity. */
    bankTransactionId: text("bank_transaction_id"),
    /**
     * Possible-duplicate flag for ID-less lines whose content collides with
     * an earlier line without proven replay evidence (0335). Null means
     * unflagged; otherwise the earlier line it may duplicate. Flagged lines
     * keep match_status 'unmatched' and are refused by auto/manual matching
     * until the reviewer clears the flag or excludes the line.
     */
    possibleDuplicateOf: uuid("possible_duplicate_of"),
    matchStatus: text("match_status", { enum: ["unmatched", "matched", "excluded"] })
      .notNull()
      .default("unmatched"),
    exclusionReason: text("exclusion_reason"),
    excludedAt: timestamp("excluded_at", { withTimezone: true }),
    excludedBy: uuid("excluded_by"),
    ...auditColumns,
  },
  (t) => [
    index("stmt_lines_statement").on(t.statementId),
    index("stmt_lines_match_status").on(t.orgId, t.matchStatus),
    uniqueIndex("stmt_lines_account_bank_transaction")
      .on(t.orgId, t.accountId, t.bankTransactionId)
      .where(sql`${t.bankTransactionId} is not null`),
    // Exact organization and id key backing the tenant-coherent
    // possible-duplicate self-reference (0335).
    uniqueIndex("bank_statement_lines_org_id_id_unique").on(t.orgId, t.id),
    // Sparse pointer: NULL-heavy tenants skip indexing their NULLs entirely.
    index("bsl_org_possible_duplicate")
      .on(t.orgId, t.possibleDuplicateOf)
      .where(sql`${t.possibleDuplicateOf} is not null`),
    foreignKey({
      name: "bank_statement_lines_possible_duplicate_of_fkey",
      columns: [t.orgId, t.possibleDuplicateOf],
      foreignColumns: [t.orgId, t.id],
    }),
    check(
      "bank_statement_lines_exclusion_evidence",
      sql`(
        ${t.matchStatus} = 'excluded'
        and ${t.exclusionReason} is not null
        and length(btrim(${t.exclusionReason})) between 5 and 500
        and ${t.excludedAt} is not null
        and ${t.excludedBy} is not null
      ) or (
        ${t.matchStatus} <> 'excluded'
        and ${t.exclusionReason} is null
        and ${t.excludedAt} is null
        and ${t.excludedBy} is null
      )`,
    ),
  ],
);

/** A reconciliation session for one account up to a cutoff. */
export const reconciliations = pgTable(
  "reconciliations",
  {
    id: id(),
    orgId: orgRef(),
    accountId: uuid("account_id").notNull(),
    throughDate: date("through_date").notNull(),
    /** Currency of the bank statement and journal-line transaction amounts. */
    currency: currencyCode("currency").notNull(),
    statementBalance: money("statement_balance").notNull(),
    status: text("status", { enum: ["in_progress", "balanced", "signed_off"] })
      .notNull()
      .default("in_progress"),
    signedOffBy: uuid("signed_off_by"),
    signedOffAt: timestamp("signed_off_at", { withTimezone: true }),
    /**
     * What the sign-off stands on (0158): `statement` = matched imported
     * statement lines; `source` = connector-mirrored cleared evidence, with
     * no statement lines invented. Statement rows carry no connector.
     */
    evidenceKind: text("evidence_kind", { enum: ["statement", "source"] })
      .notNull()
      .default("statement"),
    evidenceConnector: text("evidence_connector"),
    ...auditColumns,
  },
  (t) => [
    index("recons_account").on(t.accountId),
    uniqueIndex("reconciliations_one_open_account")
      .on(t.orgId, t.accountId)
      .where(sql`${t.status} <> 'signed_off'`),
    check(
      "reconciliations_signoff_evidence",
      sql`(
        ${t.status} = 'signed_off'
        and ${t.signedOffBy} is not null
        and ${t.signedOffAt} is not null
      ) or (
        ${t.status} <> 'signed_off'
        and ${t.signedOffBy} is null
        and ${t.signedOffAt} is null
      )`,
    ),
  ],
);

/**
 * Source-system reconciliation state mirrored as evidence (0158): per
 * reconcilable account, the connector key, the last reconciled-through date
 * the mirror derived from cleared markers, and the source statement balance
 * where the source states one. The mirror upserts it; sign-off reads it.
 */
export const sourceReconciliationState = pgTable(
  "source_reconciliation_state",
  {
    orgId: orgRef(),
    accountId: uuid("account_id").notNull(),
    /** Stable connector key (the connection source key). */
    connector: text("connector").notNull(),
    reconciledThrough: date("reconciled_through").notNull(),
    sourceBalance: money("source_balance"),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.orgId, t.accountId] }),
    check(
      "source_reconciliation_state_connector_chk",
      sql`length(btrim(${t.connector})) > 0`,
    ),
  ],
);

/**
 * Match units: one statement line ↔ N journal lines (or vice versa via
 * grouping id). Auto-matcher writes `matchedBy = 'auto'` with a confidence;
 * humans confirm or override.
 */
export const reconciliationMatches = pgTable(
  "reconciliation_matches",
  {
    id: id(),
    orgId: orgRef(),
    reconciliationId: uuid("reconciliation_id").notNull(),
    statementLineId: uuid("statement_line_id").notNull(),
    journalLineId: uuid("journal_line_id").notNull(),
    matchedBy: text("matched_by", { enum: ["auto", "manual", "rule"] }).notNull(),
    confidence: money("confidence"), // 0..1 for auto matches
    ...auditColumns,
  },
  (t) => [
    index("recon_matches_stmt_line").on(t.statementLineId),
    index("recon_matches_journal_line").on(t.journalLineId),
    uniqueIndex("recon_matches_one_journal_claim").on(t.journalLineId),
  ],
);

/** Rules that auto-categorize unmatched bank lines (create + match a doc). */
export const bankMatchRules = pgTable(
  "bank_match_rules",
  {
    id: id(),
    orgId: orgRef(),
    name: text("name").notNull(),
    /** Versioned nested condition tree plus optional account scope. */
    criteria: jsonb("criteria").notNull(),
    /** Exclude, or categorized split lines with an explicit execution mode. */
    outcome: jsonb("outcome").notNull(),
    priority: integer("priority").notNull().default(100),
    isActive: boolean("is_active").notNull().default(true),
    ...auditColumns,
  },
  (t) => [
    check(
      "bank_match_rules_criteria_shape",
      sql`openbooks_bank_rule_criteria_is_valid(${t.criteria})`,
    ),
    check(
      "bank_match_rules_outcome_shape",
      sql`openbooks_bank_rule_outcome_is_valid(${t.outcome})`,
    ),
  ],
);

/**
 * Payment runs: select approved payables → generate instructions → export
 * EFT/ACH file (or print cheques) → post payments on confirmation.
 */
export const paymentRuns = pgTable(
  "payment_runs",
  {
    id: id(),
    orgId: orgRef(),
    runNumber: text("run_number").notNull(),
    bankAccountId: uuid("bank_account_id").notNull(),
    paymentBankProfileId: uuid("payment_bank_profile_id"),
    subsidiaryId: uuid("subsidiary_id"),
    sourceScheduleId: uuid("source_schedule_id"),
    parentPaymentRunId: uuid("parent_payment_run_id"),
    method: text("method", { enum: ["eft", "ach", "sepa", "wire", "cheque", "direct_debit", "positive_pay", "custom"] }).notNull(),
    direction: text("direction", { enum: ["outbound", "inbound"] }).notNull().default("outbound"),
    purpose: text("purpose", { enum: ["vendor_payments", "customer_collections", "refunds", "positive_pay"] })
      .notNull()
      .default("vendor_payments"),
    currency: currencyCode("currency"),
    status: text("status", { enum: ["draft", "pending_approval", "approved", "processing", "generated", "delivered", "partially_failed", "confirmed", "settled", "returned", "rejected", "rolled_back", "cancelled"] })
      .notNull()
      .default("draft"),
    selectionCriteria: jsonb("selection_criteria").notNull().default({}),
    paymentCount: integer("payment_count").notNull().default(0),
    totalAmount: money("total_amount").notNull().default("0"),
    scheduledFor: date("scheduled_for"),
    exportedFileRef: text("exported_file_ref"),
    exportedAt: timestamp("exported_at", { withTimezone: true }),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    submittedBy: uuid("submitted_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    approvedBy: uuid("approved_by"),
    rejectedAt: timestamp("rejected_at", { withTimezone: true }),
    rejectedBy: uuid("rejected_by"),
    rejectionReason: text("rejection_reason"),
    settledAt: timestamp("settled_at", { withTimezone: true }),
    /** Random per-claim posting lease; instruction and completion writes must match the token currently stored on the run. */
    postingClaimToken: uuid("posting_claim_token"),
    /** When the current posting claim was taken or last made progress; a claim older than the staleness window may be recovered by a new poster. */
    postingClaimedAt: timestamp("posting_claimed_at", { withTimezone: true }),
    /** User that took the current posting claim. */
    postingClaimedBy: uuid("posting_claimed_by"),
    ...auditColumns,
  },
  (t): PgTableExtraConfigValue[] => [
    // Exact organization and id key required by tenant-coherent references (0212).
    uniqueIndex("payment_runs_org_id_id_unique").on(t.orgId, t.id),
    // Tenant pair required by 0210: a run may only name a schedule of its own org.
    foreignKey({
      name: "payment_runs_source_schedule_id_fkey",
      columns: [t.orgId, t.sourceScheduleId],
      foreignColumns: [paymentSchedules.orgId, paymentSchedules.id],
    }),
    // Recovery sweeps and operational dashboards look for exactly these rows.
    index("payment_runs_posting_claims")
      .on(t.orgId, t.postingClaimedAt)
      .where(sql`${t.status} = 'processing'`),
  ],
);

/**
 * SFTP daemon runtime config — a single global row (the deployment hosts one
 * ssh2 listener that all tenants share, routed by username). Everything the
 * daemon needs lives here in the DB, never in env: the auto-generated host key,
 * the listen port, and the hostname advertised to users in the UI. A platform
 * admin edits it in the UI; there are no SFTP_* environment variables.
 */
export const sftpDaemon = pgTable("sftp_daemon", {
  id: text("id").primaryKey().default("default"),
  enabled: boolean("enabled").notNull().default(false),
  port: integer("port").notNull().default(2222),
  /** Auto-generated ed25519 host key PEM (stable fingerprint across restarts). */
  hostKey: text("host_key").notNull(),
  /** Hostname shown in the UI's connection details (defaults to the app host). */
  advertisedHost: text("advertised_host"),
  ...auditColumns,
});

/**
 * Virtual SFTP servers: each is a login (username + password / authorized keys)
 * whose filesystem is a MinIO bucket/prefix (or a local folder in dev). One
 * ssh2 daemon hosts them all; banks and partners drop statement files or fetch
 * payment files, and the same objects drive the import/export pipeline.
 */
export const sftpServers = pgTable(
  "sftp_servers",
  {
    id: id(),
    orgId: orgRef(),
    name: text("name").notNull(),
    username: text("username").notNull(),
    /** AES-256-GCM (enc:v1) password; null when key-only. */
    passwordEncrypted: text("password_encrypted"),
    /** Authorized OpenSSH public keys (one per line) for key auth. */
    authorizedKeys: text("authorized_keys"),
    backend: text("backend", { enum: ["s3", "local"] }).notNull().default("s3"),
    bucket: text("bucket"),
    /**
     * Tenant-scoped root inside the app's own storage — derived at creation as
     * `sftp/<orgId>/<server>` and never a tenant-selected physical location.
     * Storage refuses escape shapes (absolute, backslash, percent-encoding,
     * dot/empty segments); the engine resolver additionally binds every root to
     * the owning tenant and fails closed for direct/stale rows. Legacy rows
     * outside their org namespace are quarantined (deactivated, with audit
     * evidence) by migration 0030 until an operator recreates them.
     */
    rootPrefix: text("root_prefix").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    lastConnectedAt: timestamp("last_connected_at", { withTimezone: true }),
    ...auditColumns,
  },
  (t) => [
    // Exact organization and id key required by tenant-coherent references
    // (0242): a schedule names its server as an (org_id, id) pair, so the
    // pair must be provably unique on the server side.
    uniqueIndex("sftp_servers_org_id_id_unique").on(t.orgId, t.id),
    // The daemon routes a login to a tenant by username alone, across every
    // organization — the global unique index (0029) is what makes that
    // routing deterministic; per-org uniqueness is sftp_servers_org_username.
    uniqueIndex("sftp_servers_username_global").on(t.username),
    // Escape-shape guard mirrored by migration 0030: a root prefix is a
    // relative folder path — no backslashes, no percent-encoding, no dot or
    // empty segments. Cross-tenant binding (sftp/<orgId>/) is enforced by the
    // creation route and the engine resolver, which see the owning org.
    check(
      "sftp_servers_root_prefix_safe",
      sql`${t.rootPrefix} ~ '^[^/%]+(/[^/%]+)*$' and ${t.rootPrefix} !~ '\\\\' and ${t.rootPrefix} !~ '(^|/)\\.\\.?(/|$)'`,
    ),
  ],
);

/**
 * Scheduled SFTP import: watch a folder on an SFTP server, and on each tick
 * parse + import any new statement files into a bank account, then move them to
 * a `processed/` subfolder. The inbound half of the bank-feed loop.
 */
export const sftpImportSchedules = pgTable(
  "sftp_import_schedules",
  {
    id: id(),
    orgId: orgRef(),
    sftpServerId: uuid("sftp_server_id").notNull(),
    accountId: uuid("account_id").notNull(), // reconcilable bank/card account
    format: text("format", { enum: ["auto", "ofx", "csv", "camt053", "bai2", "mt940"] }).notNull().default("auto"),
    folder: text("folder").notNull().default("inbound"),
    /** CSV column mapping when format='csv' (date/amount/description column indexes). */
    csvMapping: jsonb("csv_mapping"),
    isActive: boolean("is_active").notNull().default(true),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    lastResult: jsonb("last_result"),
    /** Durable visibility/recovery marker for the session-locked active scan. */
    runClaimToken: uuid("run_claim_token"),
    runClaimedAt: timestamp("run_claimed_at", { withTimezone: true }),
    ...auditColumns,
  },
  (t): PgTableExtraConfigValue[] => [
    index("sftp_import_schedules_active").on(t.orgId, t.isActive),
    // Tenant-coherent parents (0242): the schedule list and the import scan
    // join both parents by (org_id, id), so a plain REFERENCES (id) would
    // let one organization cite another's server or account — saved with
    // 200, invisible in GET, unrunnable. The composite pair makes that
    // unrepresentable. DEFERRABLE matches the 0195/0241 party edges; NO
    // ACTION keeps a server that still feeds schedules refusing deletion.
    foreignKey({
      name: "sftp_import_schedules_sftp_server_id_tenant_fkey",
      columns: [t.orgId, t.sftpServerId],
      foreignColumns: [sftpServers.orgId, sftpServers.id],
    }),
    foreignKey({
      name: "sftp_import_schedules_account_id_tenant_fkey",
      columns: [t.orgId, t.accountId],
      foreignColumns: [accounts.orgId, accounts.id],
    }),
  ],
);

export const paymentInstructions = pgTable(
  "payment_instructions",
  {
    id: id(),
    orgId: orgRef(),
    paymentRunId: uuid("payment_run_id").notNull(),
    payeePartyId: uuid("payee_party_id").notNull(),
    payeeBankAccountId: uuid("payee_bank_account_id"), // must be approved
    amount: money("amount").notNull(),
    currency: currencyCode("currency").notNull(),
    /** The payment document created/posted for this instruction. */
    paymentDocumentId: uuid("payment_document_id"),
    endToEndId: text("end_to_end_id"),
    paymentReference: text("payment_reference"),
    mandateId: uuid("mandate_id"),
    status: text("status", { enum: ["pending", "approved", "generated", "sent", "settled", "returned", "rejected", "failed", "reversed", "cancelled"] })
      .notNull()
      .default("pending"),
    remittanceEmailSentAt: timestamp("remittance_email_sent_at", { withTimezone: true }),
    ...auditColumns,
  },
  (t) => [index("pay_instructions_run").on(t.paymentRunId)],
);
