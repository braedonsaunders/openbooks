import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { activeStorageKind, getS3Blob, putS3Blob } from "./file-storage.ts";
import { add, cmp, sum } from "./money.ts";
import { assertPayRunApprovalReleased, payRunApprovalState } from "./payroll-approval.ts";
import {
  PAYROLL_BANK_FILE_FORMATS,
  payrollOriginatorConfig,
  preparePayRunBankFile,
  renderPayRunBankFile,
  type ChequeExclusion,
  type PayRunBankFileFormat,
  type PayrollOriginatorConfig,
} from "./payroll-bank-file.ts";
import { PayrollError } from "./payroll-error.ts";
import { assertNotSandbox } from "./sandbox/guard.ts";

/**
 * Payroll direct-deposit artifacts — the lifecycle.
 *
 * A payroll bank file is the only thing payroll produces that MOVES MONEY on
 * its own. Everything else — stubs, cheques, the journal — is either evidence
 * of a decision or a physical instrument somebody still has to hand over. This
 * file is an instruction the bank executes, so it gets the controls the
 * instruction deserves and does not exist without them:
 *
 * 1. IMMUTABLE. The exact characters are stored once, sha256-hashed, and the
 *    hash is re-verified every time the bytes are handed out. Regenerating
 *    never rewrites an artifact: it creates a NEW one, with its own sequence
 *    number, its own bank-facing file number and its own filename, and the
 *    previous one is marked `superseded` WITH A REASON. Two files for one
 *    payday must be visibly different, because a bank that receives both pays
 *    everybody twice.
 * 2. AUDITED. Generation, supersession and every single release of the bytes
 *    are written to the shared append-only `audit_log` (the File Cabinet
 *    pattern: the verb lives in `changes.event`), naming the actor, the
 *    instant and the artifact. The audit write is NOT best-effort — a release
 *    that cannot be recorded does not happen.
 * 3. NUMBERED. The bank-facing sequence is allocated exactly once per artifact
 *    off the org's existing `number_sequences` machinery (kind
 *    `payroll_bank_file`, configurable in Setup → Number sequences like every
 *    other document number) and stored. It is never re-derived at download
 *    time: a file the bank has already seen must keep the number it was sent
 *    under.
 * 4. ENTITLED. A run that is not committed, not approved where an approval
 *    policy exists, already paid, or in a sandbox cannot have a file, and each
 *    refusal names its own reason.
 * 5. TIED TO THE LEDGER. The file's own trailer total is parsed back out of
 *    the generated characters and asserted equal to the run's EFT net pay, and
 *    the EFT and cheque populations are asserted to add up to the run's net
 *    total. A trailer that disagrees with the ledger is the worst outcome
 *    available here, so it is a hard failure and not a warning.
 * 6. EFT ONLY. The population comes from `payRunBankFilePopulation`; the
 *    artifact stores the excluded cheque employees and why each was excluded,
 *    so the operator reconciles the file against the payday rather than
 *    trusting it.
 * 7. RESTRICTED. Bytes live in the File Cabinet's own storage (the same
 *    files/file_versions/file_blobs + S3 driver as every other blob), in a
 *    PRIVATE system folder owned by nobody, which the cabinet's read scope
 *    hides from every non-admin viewer. The only route to the bytes is this
 *    module, behind `payroll.run`.
 *
 * Modelled on the AP artifact (`generatePaymentFileArtifact`,
 * engine/src/payment-operations.ts) on purpose — one pattern for both money
 * rails.
 */

export const PAYROLL_BANK_FILE_SEQUENCE_KIND = "payroll_bank_file";
const PAYROLL_BANK_FILE_PREFIX = "PBF-";
const PAYROLL_BANK_FILE_FOLDER_KIND = "payroll_bank_files";
const PAYROLL_BANK_FILE_FOLDER_NAME = "Payroll bank files";

/** NACHA file ID modifier alphabet — distinguishes files created the same day. */
const FILE_ID_MODIFIERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

export type PayRunBankFileStatus = "generated" | "released" | "superseded";

/**
 * Anything that can run a statement — the pool or a transaction. The helpers
 * below are called from inside `db.transaction`, where a bare `db` would take
 * a SECOND connection and deadlock against the row lock the transaction holds.
 */
type Executor = Pick<typeof db, "execute">;

export type PayRunBankFileArtifact = {
  id: string;
  payRunDocumentId: string;
  paymentBankProfileId: string;
  format: PayRunBankFileFormat;
  sequenceNumber: number;
  fileNumber: string;
  fileCreationNumber: number | null;
  fileIdModifier: string | null;
  filename: string;
  contentType: string;
  contentHash: string;
  sizeBytes: number;
  entryCount: number;
  controlTotal: string;
  currency: string;
  excludedCheque: ChequeExclusion[];
  excludedTotal: string;
  status: PayRunBankFileStatus;
  generatedAt: string;
  generatedBy: string | null;
  firstReleasedAt: string | null;
  lastReleasedAt: string | null;
  releaseCount: number;
  supersededAt: string | null;
  supersedeReason: string | null;
};

// ---------------------------------------------------------------------------
// Entitlement — may this run have a file at all?
// ---------------------------------------------------------------------------

export type PayRunBankFileRefusalCode =
  | "notFound"
  | "voided"
  | "notCommitted"
  | "awaitingApproval"
  | "alreadyPaid"
  | "sandbox";

export interface PayRunBankFileRefusal {
  code: PayRunBankFileRefusalCode;
  /** Operator-facing sentence naming the reason. */
  reason: string;
}

export interface PayRunBankFileEntitlement {
  entitled: boolean;
  refusal: PayRunBankFileRefusal | null;
  runStatus: string;
  documentStatus: string;
  payDate: string;
  documentNumber: string;
  currency: string;
  subsidiaryId: string | null;
  netTotal: string;
  paidAt: string | null;
}
type RunRow = {
  run_status: string;
  pay_date: string;
  paid_at: string | null;
  net_total: string;
  doc_status: string;
  document_number: string;
  currency: string;
  subsidiary_id: string | null;
};

async function loadRun(orgId: string, documentId: string): Promise<RunRow | null> {
  const rows = (await db.execute<RunRow>(sql`
    select r.run_status, r.pay_date::text as pay_date, r.paid_at::text as paid_at,
           r.net_total::text as net_total, d.status as doc_status,
           d.document_number, d.currency, d.subsidiary_id
      from pay_runs r
      join documents d on d.id = r.document_id and d.org_id = r.org_id
     where r.org_id = ${orgId} and r.document_id = ${documentId}
  `));
  return rows.rows[0] ?? null;
}

/**
 * Whether this run is entitled to a bank file, and if not, exactly why.
 *
 * Returned rather than thrown so the run page can show the operator the one
 * reason they are blocked on before they press anything. The generate path
 * calls `assertPayRunBankFileEntitled`, which raises the same reasons.
 *
 * The order matters: it is the order the operator would fix them in, and the
 * first unmet condition is the one worth showing.
 */
export async function payRunBankFileEntitlement(
  orgId: string,
  documentId: string,
): Promise<PayRunBankFileEntitlement> {
  const run = await loadRun(orgId, documentId);
  if (!run) {
    return {
      entitled: false,
      refusal: { code: "notFound", reason: "pay run not found" },
      runStatus: "",
      documentStatus: "",
      payDate: "",
      documentNumber: "",
      currency: "",
      subsidiaryId: null,
      netTotal: "0",
      paidAt: null,
    };
  }
  const base = {
    runStatus: run.run_status,
    documentStatus: run.doc_status,
    payDate: run.pay_date,
    documentNumber: run.document_number,
    currency: run.currency,
    subsidiaryId: run.subsidiary_id,
    netTotal: run.net_total,
    paidAt: run.paid_at,
  };
  const refuse = (code: PayRunBankFileRefusalCode, reason: string) => ({
    entitled: false,
    refusal: { code, reason },
    ...base,
  });

  if (run.run_status === "voided") {
    return refuse("voided", "this pay run is voided — a voided run must never instruct a payment");
  }
  if (run.run_status !== "committed") {
    return refuse(
      "notCommitted",
      "commit the pay run before generating its bank file — money must not be instructed off figures that can still change",
    );
  }
  // Approval is the Flows engine's on_submit gate over the pay_run subject
  // (engine/src/payroll-approval.ts). "No gate yet" and "no policy" are
  // different states and that module is the only thing that tells them apart.
  const approval = await payRunApprovalState(orgId, documentId);
  if (!approval.released) {
    const reason =
      approval.outstandingGates > 0
        ? `this pay run is awaiting ${approval.outstandingGates} approval${approval.outstandingGates === 1 ? "" : "s"}`
        : approval.policyExists && !approval.submitted
          ? "this pay run has not been submitted for approval — this organization requires a pay-run approval before money moves"
          : "this pay run is awaiting approval";
    return refuse("awaitingApproval", reason);
  }
  if (run.paid_at) {
    return refuse(
      "alreadyPaid",
      "this pay run is already recorded as paid — generating a bank file now would pay everybody a second time",
    );
  }
  return { entitled: true, refusal: null, ...base };
}

/** The same conditions, as a hard failure. Each refusal names its reason. */
export async function assertPayRunBankFileEntitled(
  orgId: string,
  documentId: string,
): Promise<PayRunBankFileEntitlement> {
  // A cloned environment must never originate a real payment instruction.
  await assertNotSandbox(orgId, "generate a payroll bank file");
  const entitlement = await payRunBankFileEntitlement(orgId, documentId);
  if (!entitlement.entitled) throw new PayrollError(entitlement.refusal!.reason);
  // Belt and braces: the approval module owns the wording of its own refusals,
  // and this is the call the original control asked every caller to make.
  await assertPayRunApprovalReleased(orgId, documentId);
  return entitlement;
}

// ---------------------------------------------------------------------------
// Reading the artifact list
// ---------------------------------------------------------------------------

/**
 * The artifact projection. Qualified by an explicit prefix because the release
 * query joins `file_versions`, which also has an `id` — an unqualified list
 * there is an ambiguous-column error waiting for the first download.
 */
const artifactColumns = (prefix = "") => {
  const q = prefix ? sql.raw(`${prefix}.`) : sql.raw("");
  return sql`
    ${q}id, ${q}pay_run_document_id as "payRunDocumentId",
    ${q}payment_bank_profile_id as "paymentBankProfileId", ${q}format,
    ${q}sequence_number as "sequenceNumber", ${q}file_number as "fileNumber",
    ${q}file_creation_number as "fileCreationNumber", ${q}file_id_modifier as "fileIdModifier",
    ${q}filename, ${q}content_type as "contentType", ${q}content_hash as "contentHash",
    ${q}size_bytes as "sizeBytes", ${q}entry_count as "entryCount",
    ${q}control_total::text as "controlTotal", ${q}currency,
    ${q}excluded_cheque as "excludedCheque", ${q}excluded_total::text as "excludedTotal",
    ${q}status, ${q}generated_at as "generatedAt", ${q}generated_by as "generatedBy",
    ${q}first_released_at as "firstReleasedAt", ${q}last_released_at as "lastReleasedAt",
    ${q}release_count as "releaseCount", ${q}superseded_at as "supersededAt",
    ${q}supersede_reason as "supersedeReason"
  `;
};

/** Every artifact ever produced for a run, newest first. Nothing is hidden. */
export async function listPayRunBankFiles(
  orgId: string,
  documentId: string,
): Promise<PayRunBankFileArtifact[]> {
  const rows = (await db.execute<PayRunBankFileArtifact>(sql`
    select ${artifactColumns()} from pay_run_bank_files
     where org_id = ${orgId} and pay_run_document_id = ${documentId}
     order by sequence_number desc
  `));
  return rows.rows;
}

/** The artifacts that are still live — anything not superseded. */
export async function activePayRunBankFiles(
  orgId: string,
  documentId: string,
): Promise<PayRunBankFileArtifact[]> {
  return (await listPayRunBankFiles(orgId, documentId)).filter(
    (artifact) => artifact.status !== "superseded",
  );
}

// ---------------------------------------------------------------------------
// Storage — the File Cabinet's blob machinery, in a folder nobody can browse
// ---------------------------------------------------------------------------

/**
 * The system folder payroll bank files live in.
 *
 * PRIVATE with no owner, deliberately. The cabinet's read scope hides every
 * private folder from anyone who is not its owner (`web/lib/file-cabinet.ts`,
 * `resolveReadScope`), and an owner of `null` is nobody — so no `documents.read`
 * holder can list, preview or download these bytes through the cabinet. The
 * only route in is this module, behind `payroll.run`. That is requirement 7:
 * a payroll bank file must not be readable by someone who could not have run
 * the payroll that produced it.
 */
async function ensureBankFileFolder(
  tx: Executor,
  orgId: string,
  actorId: string,
): Promise<string> {
  const existing = (await tx.execute<{ id: string }>(sql`
    select id from folders where org_id = ${orgId} and system_kind = ${PAYROLL_BANK_FILE_FOLDER_KIND}
     limit 1
  `));
  if (existing.rows[0]) return existing.rows[0].id;
  const created = (await tx.execute<{ id: string }>(sql`
    insert into folders (org_id, name, is_system, system_kind, is_private, owner_id,
                         created_by, updated_by, created_at, updated_at)
    values (${orgId}, ${PAYROLL_BANK_FILE_FOLDER_NAME}, true, ${PAYROLL_BANK_FILE_FOLDER_KIND},
            true, null, ${actorId}, ${actorId}, now(), now())
    returning id
  `));
  if (!created.rows[0]) throw new PayrollError("could not create the payroll bank-file folder");
  return created.rows[0].id;
}

/**
 * Store the bytes exactly as the File Cabinet does — file + version + blob,
 * honouring the active storage driver (`storage_kind` per version, S3 when
 * configured, bytea otherwise). Payroll does not invent a second blob store.
 */
async function storeBankFileBytes(
  tx: Executor,
  input: {
    orgId: string;
    actorId: string;
    filename: string;
    contentType: string;
    bytes: Buffer;
    contentHash: string;
  },
): Promise<{ fileId: string; versionId: string }> {
  const folderId = await ensureBankFileFolder(tx, input.orgId, input.actorId);
  const extension = input.filename.includes(".")
    ? input.filename.split(".").pop()!.toLowerCase()
    : null;
  const kind = activeStorageKind();
  const file = (await tx.execute<{ id: string }>(sql`
    insert into files (org_id, folder_id, name, extension, file_type, content_type,
                       size_bytes, storage_kind, content_hash, created_by, updated_by,
                       created_at, updated_at)
    values (${input.orgId}, ${folderId}, ${input.filename}, ${extension}, 'text',
            ${input.contentType}, ${input.bytes.length}, ${kind}, ${input.contentHash},
            ${input.actorId}, ${input.actorId}, now(), now())
    returning id
  `));
  const fileId = file.rows[0]!.id;
  const version = (await tx.execute<{ id: string }>(sql`
    insert into file_versions (file_id, version_number, size_bytes, content_type, storage_kind,
                               content_hash, created_by, created_at)
    values (${fileId}, 1, ${input.bytes.length}, ${input.contentType}, ${kind},
            ${input.contentHash}, ${input.actorId}, now())
    returning id
  `));
  const versionId = version.rows[0]!.id;
  await tx.execute(sql`update files set current_version_id = ${versionId} where id = ${fileId} and org_id = ${input.orgId}`);
  // Same ordering as the cabinet: the object-store put happens inside the
  // transaction, so a failed upload rolls the metadata back and never leaves
  // an artifact row pointing at bytes that do not exist.
  if (kind === "s3") await putS3Blob(versionId, input.bytes, input.contentType);
  else {
    await tx.execute(sql`
      insert into file_blobs (version_id, bytes) values (${versionId}, ${input.bytes})
    `);
  }
  return { fileId, versionId };
}

// ---------------------------------------------------------------------------
// Audit — the shared append-only log
// ---------------------------------------------------------------------------

export type PayRunBankFileEvent = "generate" | "release" | "supersede";

/** audit_log.action is a fixed enum; the verb rides in `changes.event`. */
const EVENT_ACTION: Record<PayRunBankFileEvent, "insert" | "update"> = {
  generate: "insert",
  release: "update",
  supersede: "update",
};

/**
 * Write one bank-file event to the shared `audit_log`.
 *
 * Unlike the File Cabinet's activity logging this is NOT best-effort. The
 * whole justification for handing out bytes that move money is that the
 * handover is attributable; a release whose evidence could not be written must
 * fail, not proceed quietly.
 */
async function recordBankFileEvent(
  tx: Executor,
  input: {
    orgId: string;
    actorId: string | null;
    artifactId: string;
    event: PayRunBankFileEvent;
    changes: Record<string, unknown>;
  },
): Promise<void> {
  await tx.execute(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id, at)
    values (${input.orgId}, 'pay_run_bank_files', ${input.artifactId},
            ${EVENT_ACTION[input.event]},
            ${JSON.stringify({ event: input.event, ...input.changes })}::jsonb,
            ${input.actorId}, now())
  `);
}

export type PayRunBankFileAuditEntry = {
  id: string;
  event: string;
  artifactId: string;
  actorId: string | null;
  actorName: string | null;
  at: string;
  changes: Record<string, unknown>;
};

/** The run's bank-file audit trail: who generated and who released what. */
export async function payRunBankFileAudit(
  orgId: string,
  documentId: string,
  limit = 100,
): Promise<PayRunBankFileAuditEntry[]> {
  const rows = (await db.execute<PayRunBankFileAuditEntry>(sql`
    select a.id, coalesce(a.changes->>'event', a.action) as event,
           a.row_id as "artifactId", a.actor_id as "actorId",
           coalesce(u.name, u.email) as "actorName", a.at, a.changes
      from audit_log a
      join pay_run_bank_files f on f.id = a.row_id and f.org_id = a.org_id
      left join users u on u.id = a.actor_id and u.org_id = a.org_id
     where a.org_id = ${orgId} and a.table_name = 'pay_run_bank_files'
       and f.pay_run_document_id = ${documentId}
     order by a.at desc
     limit ${limit}
  `));
  return rows.rows;
}

// ---------------------------------------------------------------------------
// Generate
// ---------------------------------------------------------------------------

export interface GeneratePayRunBankFileInput {
  orgId: string;
  documentId: string;
  actorId: string;
  /** The tenant originator configuration to build from. */
  paymentBankProfileId: string;
  /**
   * Required when the run already has a live artifact. Two files for one
   * payday is the dangerous state, so replacing one is a deliberate, explained
   * act rather than a side effect of pressing the button again.
   */
  supersedeReason?: string | null;
  /** Injectable for reproducible tests. */
  now?: Date;
}

/**
 * Produce a new, immutable bank-file artifact for a committed pay run.
 *
 * Every database READ happens before the transaction; the transaction locks
 * the run, re-verifies the entitlement, allocates the bank-facing number,
 * renders the characters (pure — the number has to be inside the characters it
 * numbers), stores them, and writes the artifact and its audit record
 * together. Nothing here ever rewrites an existing artifact.
 */
export async function generatePayRunBankFile(
  input: GeneratePayRunBankFileInput,
): Promise<PayRunBankFileArtifact> {
  const { orgId, documentId, actorId } = input;
  const now = input.now ?? new Date();

  const entitlement = await assertPayRunBankFileEntitled(orgId, documentId);

  const originator = await payrollOriginatorConfig(orgId, input.paymentBankProfileId);
  if (!originator.ok) {
    throw new PayrollError(
      `EFT origination is not configured on payment bank profile "${originator.profileName}": ` +
        `${originator.missing.join(", ")}. Set these in Setup → Payment operations; ` +
        "they are assigned by your financial institution and are never defaulted.",
    );
  }
  const config: PayrollOriginatorConfig = originator.config;
  const format = config.format;
  const spec = PAYROLL_BANK_FILE_FORMATS[format];

  // A CAD run must not go out on an ACH rail, and a USD run must not go out on
  // a CPA one; the amounts would be read as the wrong currency's cents.
  if (entitlement.currency !== spec.currency) {
    throw new PayrollError(
      `this pay run is in ${entitlement.currency} but the ${format} rail settles in ${spec.currency}`,
    );
  }

  const existing = await activePayRunBankFiles(orgId, documentId);
  const supersedeReason = input.supersedeReason?.trim() ?? "";
  if (existing.length > 0 && supersedeReason.length < 5) {
    throw new PayrollError(
      `this pay run already has bank file ${existing[0]!.fileNumber} (${existing[0]!.filename}). ` +
        "Regenerating creates a SECOND file — releasing both to the bank pays every employee twice — " +
        "so a reason of at least 5 characters is required, and the existing file will be marked superseded.",
    );
  }

  // Every read the render needs, done before the lock is taken.
  const inputs = await preparePayRunBankFile(orgId, documentId, format);

  // The populations must add up to the run. This is the ledger tie-out: the
  // file's money plus the paper money is the run's net pay, to the cent.
  const populationTotal = add(inputs.population.total, inputs.population.excludedTotal);
  if (cmp(populationTotal, entitlement.netTotal) !== 0) {
    throw new PayrollError(
      `payroll bank file refuses to generate: the EFT population (${inputs.population.total}) plus the ` +
        `cheque population (${inputs.population.excludedTotal}) is ${populationTotal}, but the run's net pay ` +
        `is ${entitlement.netTotal}`,
    );
  }

  return await db.transaction(async (tx) => {
    // Serialize against a concurrent generate for the same run: without this,
    // two operators pressing the button at once each see "no live file" and
    // each produce one the other does not know about.
    const locked = (await tx.execute<{ run_status: string; paid_at: string | null }>(sql`
      select r.run_status, r.paid_at
        from pay_runs r
       where r.org_id = ${orgId} and r.document_id = ${documentId}
       for update of r
    `));
    const lockedRun = locked.rows[0];
    if (!lockedRun) throw new PayrollError("pay run not found");
    if (lockedRun.run_status !== "committed") {
      throw new PayrollError("commit the pay run before generating its bank file");
    }
    if (lockedRun.paid_at) {
      throw new PayrollError("this pay run is already recorded as paid");
    }
    const live = (await tx.execute<{ id: string; file_number: string }>(sql`
      select id, file_number, coalesce(max(sequence_number) over (), 0) as _ignored
        from pay_run_bank_files
       where org_id = ${orgId} and pay_run_document_id = ${documentId} and status <> 'superseded'
    `));
    if (live.rows.length > 0 && supersedeReason.length < 5) {
      throw new PayrollError(
        `this pay run already has bank file ${live.rows[0]!.file_number} — a reason is required to replace it`,
      );
    }

    // --- numbering ---------------------------------------------------------
    // One allocation per artifact off the org's own sequence machinery. Both
    // the artifact's sequence within the run and the bank-facing number are
    // stored; neither is ever recomputed from a count at download time.
    const seqRow = (await tx.execute<{ n: number }>(sql`
      select coalesce(max(sequence_number), 0) + 1 as n from pay_run_bank_files
       where org_id = ${orgId} and pay_run_document_id = ${documentId}
    `));
    const sequenceNumber = Number(seqRow.rows[0]?.n ?? 1);

    const scoped = entitlement.subsidiaryId
      ? ((await tx.execute(sql`
          select 1 from number_sequences
           where org_id = ${orgId} and document_kind = ${PAYROLL_BANK_FILE_SEQUENCE_KIND}
             and subsidiary_id = ${entitlement.subsidiaryId} limit 1
        `))).rows.length > 0
      : false;
    const allocated = (await tx.execute<{ prefix: string; next_number: number; padding: number }>(sql`
      insert into number_sequences (org_id, document_kind, subsidiary_id, prefix)
      values (${orgId}, ${PAYROLL_BANK_FILE_SEQUENCE_KIND},
              ${scoped ? entitlement.subsidiaryId : null}, ${PAYROLL_BANK_FILE_PREFIX})
      on conflict on constraint sequences_org_kind_sub
      do update set next_number = number_sequences.next_number + 1
      where number_sequences.org_id = ${orgId}
      returning prefix, next_number, padding
    `));
    const seq = allocated.rows[0]!;
    const sequenceValue = Number(seq.next_number);
    const fileNumber = `${seq.prefix}${String(sequenceValue).padStart(seq.padding, "0")}`;

    // CPA-005 carries a 4-digit file creation number (1–9999) unique per
    // originator; NACHA carries a single-character file ID modifier. Both are
    // derived from the SAME allocation, once, and stored — so a wrap of either
    // alphabet still produces a file the operator can trace to a sequence
    // value that never repeats.
    const fileCreationNumber =
      format === "cpa005" ? ((sequenceValue - 1) % 9999) + 1 : null;
    const fileIdModifier =
      format === "nacha"
        ? FILE_ID_MODIFIERS[(sequenceValue - 1) % FILE_ID_MODIFIERS.length]!
        : null;

    // --- render (pure) -----------------------------------------------------
    const rendered = renderPayRunBankFile(inputs, {
      orgId,
      documentId,
      format,
      originator: config,
      fileCreationNumber: fileCreationNumber ?? undefined,
      fileIdModifier: fileIdModifier ?? undefined,
      fundsDate: entitlement.payDate,
      createdAt: now,
    });

    // Second, independent tie-out against the run's own net total, using the
    // totals that were parsed back out of the characters just produced.
    const fileMoney = sum(rendered.entries.map((entry) => entry.amount));
    if (cmp(add(fileMoney, rendered.excludedTotal), entitlement.netTotal) !== 0) {
      throw new PayrollError(
        `payroll bank file control total ${fileMoney} plus cheques ${rendered.excludedTotal} ` +
          `does not reconcile to the run's net pay ${entitlement.netTotal}`,
      );
    }

    // us-ascii: the byte length must equal the character length, or a name
    // with an accent has silently shifted every field after it.
    const bytes = Buffer.from(rendered.content, "utf8");
    if (bytes.length !== rendered.content.length) {
      throw new PayrollError(
        "payroll bank file contains non-ASCII characters, which would shift every fixed-width field after them",
      );
    }
    const contentHash = createHash("sha256").update(bytes).digest("hex");
    const filename = `${fileNumber}-${format === "cpa005" ? "CPA005" : "NACHA"}-${
      entitlement.documentNumber
    }.${rendered.extension}`.replace(/[^A-Za-z0-9._-]/g, "-");

    const stored = await storeBankFileBytes(tx, {
      orgId,
      actorId,
      filename,
      contentType: rendered.contentType,
      bytes,
      contentHash,
    });

    const inserted = (await tx.execute<PayRunBankFileArtifact>(sql`
      insert into pay_run_bank_files (
        org_id, pay_run_document_id, payment_bank_profile_id, format,
        sequence_number, file_number, sequence_value, file_creation_number, file_id_modifier,
        filename, content_type, content_hash, size_bytes, file_id, file_version_id,
        entry_count, control_total, currency, excluded_cheque, excluded_total,
        status, generated_at, generated_by, created_by, updated_by)
      values (
        ${orgId}, ${documentId}, ${config.paymentBankProfileId}, ${format},
        ${sequenceNumber}, ${fileNumber}, ${sequenceValue}, ${fileCreationNumber}, ${fileIdModifier},
        ${filename}, ${rendered.contentType}, ${contentHash}, ${bytes.length},
        ${stored.fileId}, ${stored.versionId},
        ${rendered.entries.length}, ${rendered.total}, ${rendered.currency},
        ${JSON.stringify(rendered.excludedCheque)}::jsonb, ${rendered.excludedTotal},
        'generated', ${now.toISOString()}, ${actorId}, ${actorId}, ${actorId})
      returning ${artifactColumns()}
    `));
    const artifact = inserted.rows[0]!;

    for (const previous of live.rows) {
      await tx.execute(sql`
        update pay_run_bank_files
           set status = 'superseded', superseded_at = now(), superseded_by = ${actorId},
               superseded_by_file_id = ${artifact.id}, supersede_reason = ${supersedeReason},
               updated_at = now(), updated_by = ${actorId}
         where org_id = ${orgId} and id = ${previous.id}
      `);
      await recordBankFileEvent(tx, {
        orgId,
        actorId,
        artifactId: previous.id,
        event: "supersede",
        changes: {
          supersededByFileId: artifact.id,
          supersededByFileNumber: fileNumber,
          reason: supersedeReason,
        },
      });
    }

    await recordBankFileEvent(tx, {
      orgId,
      actorId,
      artifactId: artifact.id,
      event: "generate",
      changes: {
        payRunDocumentId: documentId,
        payRunNumber: entitlement.documentNumber,
        format,
        fileNumber,
        fileCreationNumber,
        fileIdModifier,
        filename,
        contentHash,
        entryCount: rendered.entries.length,
        controlTotal: rendered.total,
        excludedChequeCount: rendered.excludedCheque.length,
        excludedTotal: rendered.excludedTotal,
        paymentBankProfileId: config.paymentBankProfileId,
        supersededCount: live.rows.length,
      },
    });

    return artifact;
  });
}

// ---------------------------------------------------------------------------
// Release — hand the bytes out, and record that it happened
// ---------------------------------------------------------------------------

export interface ReleasedPayRunBankFile {
  artifact: PayRunBankFileArtifact;
  filename: string;
  contentType: string;
  bytes: Buffer;
}

/**
 * Read one artifact's bytes and record the release.
 *
 * Three things happen before a single byte is returned: the stored hash is
 * re-verified against the retrieved bytes (a mismatch means the artifact is no
 * longer the thing that was approved, and it fails rather than being handed
 * over); the release is written to `audit_log` with the actor; and the
 * artifact's release counters are advanced so the run page can show the
 * operator, loudly, that this file has already been out of the building.
 *
 * Callers MUST have `payroll.run` — the same permission as producing the
 * payroll these bytes pay.
 */
export async function releasePayRunBankFile(
  orgId: string,
  artifactId: string,
  actorId: string,
): Promise<ReleasedPayRunBankFile> {
  const rows = (await db.execute<(PayRunBankFileArtifact & {
      storageKind: string;
      dbBytes: Buffer | null;
      versionId: string;
    })>(sql`
    select ${artifactColumns("f")}, fv.storage_kind as "storageKind",
           fb.bytes as "dbBytes", f.file_version_id as "versionId"
      from pay_run_bank_files f
      join files fi on fi.id = f.file_id and fi.org_id = ${orgId}
      join file_versions fv on fv.id = f.file_version_id and fv.file_id = fi.id
      left join file_blobs fb on fb.version_id = fv.id
     where f.org_id = ${orgId} and f.id = ${artifactId}
  `));
  const row = rows.rows[0];
  if (!row) throw new PayrollError("payroll bank file not found");

  const bytes = row.storageKind === "s3" ? await getS3Blob(row.versionId) : row.dbBytes;
  if (!bytes) throw new PayrollError("payroll bank file bytes are missing from storage");
  const hash = createHash("sha256").update(bytes).digest("hex");
  if (hash !== row.contentHash) {
    throw new PayrollError(
      `payroll bank file ${row.fileNumber} no longer matches its recorded sha256 — refusing to release it`,
    );
  }

  await db.transaction(async (tx) => {
    // The audit record and the release counters move together: an artifact
    // can never show a release the log does not explain, or vice versa.
    await tx.execute(sql`
      update pay_run_bank_files
         set status = case when status = 'superseded' then status else 'released' end,
             release_count = release_count + 1,
             first_released_at = coalesce(first_released_at, now()),
             last_released_at = now(),
             updated_at = now(), updated_by = ${actorId}
       where org_id = ${orgId} and id = ${artifactId}
    `);
    await recordBankFileEvent(tx, {
      orgId,
      actorId,
      artifactId,
      event: "release",
      changes: {
        channel: "download",
        fileNumber: row.fileNumber,
        filename: row.filename,
        contentHash: row.contentHash,
        controlTotal: row.controlTotal,
        entryCount: row.entryCount,
        // A superseded file leaving the building is the dangerous release, so
        // it is called out in the evidence rather than inferred later.
        supersededAtRelease: row.status === "superseded",
        releaseNumber: row.releaseCount + 1,
      },
    });
  });

  const refreshed = (await db.execute<PayRunBankFileArtifact>(sql`
    select ${artifactColumns()} from pay_run_bank_files where org_id = ${orgId} and id = ${artifactId}
  `));

  return {
    artifact: refreshed.rows[0] ?? row,
    filename: row.filename,
    contentType: row.contentType,
    bytes,
  };
}
