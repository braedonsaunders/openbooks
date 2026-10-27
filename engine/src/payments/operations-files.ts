import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { sum } from "../money/money.ts";
import { lockActorCommandAuthority } from "../organization/actor-command-authority.ts";
import { lockAndCheckOrgFeature } from "../organization/org-feature-lock.ts";
import { assertNotSandbox } from "../organization/sandbox-guard.ts";
import { ScopeNotFoundError, lockScopeRows } from "../organization/subsidiary-scope.ts";
import { PaymentError } from "../payments-core/payment-errors.ts";
import { assertSafePaymentFilename } from "../payments-core/payment-filenames.ts";
import { paymentRunVisibleSql } from "../payments-core/payment-run-scope.ts";
import {
  lowestFreeNachaModifier,
  nachaFileIdModifierForRunNumber,
  nachaModifierExhaustionRefusal,
} from "../payments-core/rail-nacha.ts";
import {
  allocateRbcStd152Number,
  rbcStd152SettingsDigest,
} from "../payments-core/rail-rbc-identity.ts";
import {
  validateRbcStd152Settings,
  type RbcStd152Settings,
} from "../payments-core/rail-rbc-std152.ts";
import { assertDeclaredAsciiCharset } from "../payments-core/rail-text.ts";
import { businessTimeZone, formatInZone } from "../platform/business-date.ts";
import { db, schema, withOrgTransaction, type SqlExecutor } from "../platform/db.ts";
import { refuseMaskedStorageKind } from "../platform/file-storage.ts";
import { unsealJson } from "../platform/secrets.ts";
import { loadFormatContext, renderPaymentFile } from "./operations-files-format.ts";
import { event, lockPendingPaymentInstructions } from "./operations-shared.ts";
import { assertRunPayeesInScope } from "./run-readiness.ts";
import { storeArtifactFile } from "./payment-file-cabinet.ts";

const GENERATABLE_RUN_STATUSES = ["approved", "generated", "delivered", "partially_failed"];

async function findLiveRunArtifact(
  runId: string,
  orgId: string,
): Promise<{ id: string; filename: string; contentType: string; content: Buffer } | null> {
  const existing = await db.execute<{
    id: string;
    filename: string;
    content_type: string;
    storage_kind: string;
    bytes: Buffer | null;
  }>(
    sql`
    select pf.id, pf.filename, pf.content_type, fv.storage_kind, fb.bytes
      from payment_files pf
      join files fi on fi.id = pf.file_id and fi.org_id = ${orgId}
      join file_versions fv on fv.id = pf.file_version_id and fv.file_id = fi.id
      left join file_blobs fb on fb.version_id = fv.id
     where pf.payment_run_id = ${runId} and pf.org_id = ${orgId} and pf.status not in ('superseded', 'voided', 'rejected')
     order by pf.sequence_number desc limit 1
  `,
    "objects",
  );
  const row = existing[0];
  // Masked-clone tombstone: refuse by name. The left join keeps the row
  // visible so the tombstone (not a missing blob) decides the outcome.
  if (row) refuseMaskedStorageKind(row.storage_kind);
  // A row without blob bytes (e.g. an S3-backed version has no file_blobs
  // row) is "no live artifact", exactly as the old inner join reported it.
  if (!row || !row.bytes) return null;
  return { id: row.id, filename: row.filename, contentType: row.content_type, content: row.bytes };
}

/**
 * NACHA File ID Modifier allocation for one AP run.
 *
 * The bank keys same-day duplicate-file detection on (origin, creation
 * date, modifier): every NACHA file a bank profile generates on one civil
 * day needs its own letter. Run numbers cannot supply that — they advance
 * across every payment method and wrap mod 36, so two same-day runs can
 * share a letter and past 36 files the alphabet wraps silently. The lowest
 * free letter for the profile's creation day pins onto the run, so renders
 * reuse it and downloads stay byte-identical from the stored artifact. A
 * run that already pinned one keeps it: reprocessing reuses the run's
 * identity exactly like an accidental re-upload, which is what the bank
 * must deduplicate.
 *
 * Serialization is the bank-profile row: concurrent first generations for
 * one profile queue on its lock, so two runs never read the same free set.
 * Lock order is profile-then-run everywhere (payroll allocates the same
 * way), so allocation cannot deadlock with generation. Every stamped
 * same-day run occupies its letter — cancelled and rolled-back runs
 * included (their files may already be at the bank), legacy rows
 * recomputed from the run number. Over-occupying fails safe toward the
 * exhaustion refusal, never toward a shared bank identity.
 */
export async function allocateNachaRunModifier(input: {
  runId: string;
  orgId: string;
  bankProfileId: string;
  creationDay: string;
  timeZone: string;
}): Promise<string> {
  return withOrgTransaction(input.orgId, async () => {
    const pinned = (
      await db.execute<{ modifier: string | null }>(
        sql`
      select file_id_modifier as "modifier" from payment_runs
       where id = ${input.runId} and org_id = ${input.orgId}
    `,
        "objects",
      )
    )[0];
    if (!pinned) throw new PaymentError("payment run not found");
    if (pinned.modifier) {
      if (!/^[A-Z0-9]$/.test(pinned.modifier)) {
        throw new PaymentError(
          `payment run carries an invalid NACHA file ID modifier — clear it before generating`,
        );
      }
      return pinned.modifier;
    }
    const profile = (
      await db.execute<{ id: string }>(
        sql`
      select id from payment_bank_profiles
       where id = ${input.bankProfileId} and org_id = ${input.orgId}
       for update
    `,
        "objects",
      )
    )[0];
    if (!profile) {
      throw new PaymentError(
        "the run's bank profile is gone — reassign a bank profile before generating its file",
      );
    }
    const siblings = await db.execute<{ runNumber: string; modifier: string | null }>(
      sql`
      select run_number as "runNumber", file_id_modifier as "modifier"
        from payment_runs
       where org_id = ${input.orgId} and payment_bank_profile_id = ${input.bankProfileId}
         and method in ('ach', 'direct_debit')
         and file_created_at is not null
         and (file_created_at at time zone ${input.timeZone})::date = ${input.creationDay}::date
         and id <> ${input.runId}
    `,
      "objects",
    );
    const letter = lowestFreeNachaModifier(
      siblings.map(
        (sibling) => sibling.modifier ?? nachaFileIdModifierForRunNumber(sibling.runNumber),
      ),
    );
    if (!letter) throw new PaymentError(nachaModifierExhaustionRefusal(input.creationDay));
    const stamped =
      (
        await db.execute<never>(sql`
      update payment_runs set file_id_modifier = ${letter}
       where id = ${input.runId} and org_id = ${input.orgId} and file_id_modifier is null
    `)
      ).rowCount ?? 0;
    if (stamped === 1) return letter;
    // A concurrent allocation for this same run won the pin: reread it.
    const reread = (
      await db.execute<{ modifier: string | null }>(
        sql`
      select file_id_modifier as "modifier" from payment_runs
       where id = ${input.runId} and org_id = ${input.orgId}
    `,
        "objects",
      )
    )[0]?.modifier;
    if (!reread) throw new PaymentError("payment run not found");
    return reread;
  });
}

/** Resolve the actual run direction and current role boundary before a file
 * identity or artifact changes. A supplied scope is only a narrower ceiling. */
async function paymentFileCommandScope(
  tx: SqlExecutor,
  orgId: string,
  runId: string,
  userId: string,
  requested: ReadonlySet<string> | null | undefined,
) {
  const run = (
    await tx.execute<{ direction: string }>(
      sql`select direction from payment_runs
    where org_id = ${orgId} and id = ${runId}`,
      "objects",
    )
  )[0];
  if (!run || !["outbound", "inbound"].includes(run.direction)) throw new ScopeNotFoundError();
  const live = await lockActorCommandAuthority(
    tx,
    orgId,
    userId,
    null,
    run.direction === "inbound" ? "ar.pay" : "ap.pay",
  );
  if (!(await lockAndCheckOrgFeature(tx, orgId, "banking")))
    throw new PaymentError(
      "Enable Banking in Company Settings → Features before generating or downloading a payment bank file.",
    );
  await assertNotSandbox(orgId, "generate or download a payment bank file");
  const scope =
    requested == null
      ? live
      : live === null
        ? requested
        : new Set([...requested].filter((id) => live.has(id)));
  const visible = (
    await tx.execute(
      sql`select id from payment_runs r where id = ${runId}
    and ${paymentRunVisibleSql(orgId, scope)}`,
      "objects",
    )
  )[0];
  if (!visible) throw new ScopeNotFoundError();
  return scope;
}

/** The caller holds the run and payee locks. Pin retained document ownership
 * after any profile lock, matching native run creation's ownership order. */
async function lockPaymentFileSources(
  tx: SqlExecutor,
  orgId: string,
  runId: string,
  scope: ReadonlySet<string> | null,
) {
  if (scope !== null) {
    const sources = await tx.execute<{ id: string }>(
      sql`select distinct source_document_id as id
      from payment_run_items where org_id = ${orgId} and payment_run_id = ${runId}`,
      "objects",
    );
    await lockScopeRows(
      tx,
      orgId,
      sources.map((row) => ({ kind: "document" as const, id: row.id })),
      scope,
      "share",
    );
  }
}

export async function generatePaymentFileArtifact(
  runId: string,
  orgId: string,
  userId: string,
  opts?: {
    reprocessFileId?: string | null;
    now?: Date;
    allowedSubsidiaryIds?: ReadonlySet<string> | null;
  },
): Promise<{ id: string; filename: string; contentType: string; content: Buffer }> {
  await withOrgTransaction(orgId, () =>
    paymentFileCommandScope(db, orgId, runId, userId, opts?.allowedSubsidiaryIds),
  );
  const ctx = await loadFormatContext(runId, orgId);
  const status = String(ctx.run.status);
  // Fast-path refusal only — the authoritative lifecycle gate is re-judged
  // inside the tenant transaction below against committed state.
  if (!GENERATABLE_RUN_STATUSES.includes(status)) {
    throw new PaymentError("approve the payment run before generating its file");
  }
  const now = opts?.now ?? new Date();
  // Stamp the run's first-file instant ONCE (coalesce) before rendering: the
  // UPDATE's row lock serializes concurrent first generations onto one
  // instant, and every later render of this run — re-downloads, reprocesses —
  // reuses it, so identical evidence always renders byte-identical files and
  // the bank's duplicate-file detection recognizes an accidental re-upload
  // of the same run. A failed render may leave a stamp with no artifact; the
  // next attempt reuses it, which keeps the identity stable either way.
  const fileCreatedAtRaw = await withOrgTransaction(orgId, async () => {
    await paymentFileCommandScope(db, orgId, runId, userId, opts?.allowedSubsidiaryIds);
    return (
      await db.execute<{ file_created_at: Date | string }>(
        sql`
      update payment_runs set file_created_at = coalesce(file_created_at, ${now})
       where id = ${runId} and org_id = ${orgId}
      returning file_created_at
    `,
        "objects",
      )
    )[0]?.file_created_at;
  });
  if (fileCreatedAtRaw == null) throw new PaymentError("payment run not found");
  // node-postgres returns timestamptz as a string; the renderers need a real
  // Date (their formatters read getHours(), not string indexes).
  const fileCreatedAt =
    fileCreatedAtRaw instanceof Date ? fileCreatedAtRaw : new Date(fileCreatedAtRaw);
  if (Number.isNaN(fileCreatedAt.getTime())) {
    throw new PaymentError("payment run file creation stamp is not a valid timestamp");
  }
  // NACHA rails allocate the run's File ID Modifier before rendering (the
  // letter is baked into the bytes): lowest free per profile per creation
  // day, pinned on the run. Every other rail renders unmodified.
  const timeZone = ["nacha_credit", "nacha_debit"].includes(ctx.format.rail)
    ? await businessTimeZone(orgId)
    : null;
  const nachaModifier = timeZone
    ? await withOrgTransaction(orgId, async () => {
        await paymentFileCommandScope(db, orgId, runId, userId, opts?.allowedSubsidiaryIds);
        return allocateNachaRunModifier({
          runId,
          orgId,
          bankProfileId: ctx.profile.id,
          creationDay: formatInZone(fileCreatedAt, timeZone),
          timeZone,
        });
      })
    : null;
  const rbcIdentity =
    ctx.format.rail === "rbc_std152_credit"
      ? await withOrgTransaction(orgId, async () => {
          await paymentFileCommandScope(db, orgId, runId, userId, opts?.allowedSubsidiaryIds);
          const locked = (
            await db.execute<{ id: string }>(
              sql`select id from payment_runs where org_id=${orgId} and id=${runId} and status in ('approved','generated','delivered','partially_failed') and payment_bank_profile_id=${ctx.profile.id} for update`,
              "objects",
            )
          )[0];
          if (!locked) throw new PaymentError("payment run not found");
          const prior = (
            await db.execute<{
              details: {
                fileCreationNumber?: number;
                clientDigest?: string;
                settingsDigest?: string;
              };
            }>(
              sql`select details from payment_events where org_id=${orgId} and payment_run_id=${runId} and event_type='rbc_file_number_allocated' and (details->>'parentFileId') is not distinct from ${opts?.reprocessFileId ?? null}::text order by created_at limit 1`,
              "objects",
            )
          )[0];
          const checked = validateRbcStd152Settings(
            ctx.profile.secrets as Partial<RbcStd152Settings>,
          );
          if (!checked.ok)
            throw new PaymentError(
              `RBC STD152 profile is incomplete: ${checked.missing.join(", ")}`,
            );
          const settingsDigest = rbcStd152SettingsDigest(checked.settings);
          const profile = (
            await db.execute<{ sealed: string | null; currency: string }>(
              sql`select originator_secrets_encrypted as sealed,currency from payment_bank_profiles where org_id=${orgId} and id=${ctx.profile.id} and is_active for share`,
              "objects",
            )
          )[0];
          const live = validateRbcStd152Settings(
            profile?.sealed
              ? unsealJson<Partial<RbcStd152Settings>>(profile.sealed, {
                  orgId,
                  purpose: "payment.originator.secrets",
                })
              : {},
          );
          if (
            !live.ok ||
            profile?.currency !== "CAD" ||
            live.settings.serviceCurrency !== "CAD" ||
            rbcStd152SettingsDigest(live.settings) !== settingsDigest
          )
            throw new PaymentError(
              "RBC profile changed while generating the file — reload the run and try again",
            );
          const clientDigest = createHash("sha256")
            .update(checked.settings.clientNumber)
            .digest("hex");
          if (prior) {
            const n = prior.details.fileCreationNumber;
            if (
              prior.details.clientDigest !== clientDigest ||
              prior.details.settingsDigest !== settingsDigest ||
              !Number.isInteger(n) ||
              n! < 1 ||
              n! > 9999
            )
              throw new PaymentError(
                "RBC file identity no longer matches the run profile — retain the original profile or create a new governed payment run",
              );
            return { number: n!, settingsDigest };
          }
          const n = await allocateRbcStd152Number(db, orgId, checked.settings.clientNumber);
          const event = await db
            .insert(schema.paymentEvents)
            .values({
              orgId,
              paymentRunId: runId,
              eventType: "rbc_file_number_allocated",
              details: {
                fileCreationNumber: n,
                clientDigest,
                settingsDigest,
                parentFileId: opts?.reprocessFileId ?? null,
              },
              actorId: userId,
            })
            .returning({ id: schema.paymentEvents.id });
          if (event.length !== 1)
            throw new PaymentError("RBC file number allocation was not recorded");
          return { number: n, settingsDigest };
        })
      : undefined;
  const rendered = await withOrgTransaction(orgId, async () => {
    const scope = await paymentFileCommandScope(
      db,
      orgId,
      runId,
      userId,
      opts?.allowedSubsidiaryIds,
    );
    return renderPaymentFile(
      ctx,
      orgId,
      now,
      {
        fileCreatedAt,
        ...(nachaModifier ? { fileIdModifier: nachaModifier } : {}),
        ...(rbcIdentity
          ? {
              fileCreationNumber: rbcIdentity.number,
              rbcSettingsDigest: rbcIdentity.settingsDigest,
            }
          : {}),
      },
      scope,
    );
  });
  // File names are attacker-influenced (a custom formatter returns an
  // arbitrary string) and later concatenated onto the SFTP outbound folder,
  // so the merged name of EVERY rail is validated here — before anything is
  // stored — not only the custom branch that produces it.
  const safeFilename = assertSafePaymentFilename(rendered.filename);
  // A file declared us-ascii must be ASCII byte for byte: its UTF-8 encoding
  // below is then identical, and no fixed-width field has shifted.
  assertDeclaredAsciiCharset(rendered.contentType, rendered.content);
  const content = Buffer.from(rendered.content, "utf8");
  const hash = createHash("sha256").update(content).digest("hex");
  return withOrgTransaction(orgId, async () => {
    const scope = await paymentFileCommandScope(
      db,
      orgId,
      runId,
      userId,
      opts?.allowedSubsidiaryIds,
    );
    // Preparation used earlier transactions: a rollback can commit while
    // the bank file renders, and two
    // generators can pass the same empty dedupe probe. Locking the run row
    // here (1) fails closed when the committed status has left the generable
    // set — a rolled-back run can never gain an artifact — and (2) serializes
    // concurrent generations of one run, so only the first sees no live
    // artifact and the rest idempotently return it.
    const gate = await db.execute<{ status: string; payment_bank_profile_id: string | null }>(
      sql`
      select status, payment_bank_profile_id from payment_runs
       where id = ${runId} and org_id = ${orgId}
         and status in ('approved', 'generated', 'delivered', 'partially_failed')
       for update
    `,
      "objects",
    );
    const liveStatus = gate[0]?.status;
    if (!liveStatus) throw new PaymentError("approve the payment run before generating its file");
    await paymentFileCommandScope(db, orgId, runId, userId, scope);
    await assertRunPayeesInScope(orgId, runId, scope);
    if (rbcIdentity) {
      if (gate[0]?.payment_bank_profile_id !== ctx.profile.id)
        throw new PaymentError(
          "RBC run profile changed after rendering — reload the run before generating its file",
        );
      const profile = (
        await db.execute<{ sealed: string | null; currency: string; format_id: string }>(
          sql`select originator_secrets_encrypted as sealed,currency,payment_format_id as format_id from payment_bank_profiles where org_id=${orgId} and id=${ctx.profile.id} and is_active for share`,
          "objects",
        )
      )[0];
      const live = validateRbcStd152Settings(
        profile?.sealed
          ? unsealJson<Partial<RbcStd152Settings>>(profile.sealed, {
              orgId,
              purpose: "payment.originator.secrets",
            })
          : {},
      );
      if (
        !live.ok ||
        profile?.currency !== "CAD" ||
        profile.format_id !== ctx.format.id ||
        rbcStd152SettingsDigest(live.settings) !== rbcIdentity.settingsDigest
      )
        throw new PaymentError(
          "RBC profile changed after rendering — preserve the allocated file identity and restore the original profile or create a new governed run",
        );
    }
    await lockPaymentFileSources(db, orgId, runId, scope);
    // Rendering happened before the run lock. Bind those bytes to the exact
    // pending instruction set under the lock: a partially failed run may
    // already have sent siblings, and re-exporting them would pay twice.
    const pendingIds = await lockPendingPaymentInstructions(runId, orgId);
    const renderedIds = ctx.payments.map((payment) => payment.id).sort();
    if (
      renderedIds.length !== pendingIds.length ||
      renderedIds.some((id, index) => id !== pendingIds[index])
    ) {
      throw new PaymentError(
        "payment instructions changed or already left pending while the file was rendered; do not regenerate a file containing instructions already sent",
      );
    }
    if (!opts?.reprocessFileId) {
      const live = await findLiveRunArtifact(runId, orgId);
      if (live) return live;
    } else {
      // The route authorizes this run, not an arbitrary parent artifact. Keep
      // lineage inside that same boundary and judge retries under the run lock
      // so two callers cannot create independently deliverable successors.
      const parent = (
        await db.execute<{ id: string; status: string }>(
          sql`
        select id, status from payment_files
         where id = ${opts.reprocessFileId} and payment_run_id = ${runId} and org_id = ${orgId}
         for update
      `,
          "objects",
        )
      )[0];
      if (!parent) throw new PaymentError("payment file not found in this run");
      const latest = (
        await db.execute<{ id: string; parent_id: string | null; status: string }>(
          sql`
        select id, parent_payment_file_id as parent_id, status from payment_files
         where payment_run_id = ${runId} and org_id = ${orgId}
         order by sequence_number desc limit 1
      `,
          "objects",
        )
      )[0]!;
      if (
        latest.parent_id === parent.id &&
        !["superseded", "voided", "rejected"].includes(latest.status)
      ) {
        const live = await findLiveRunArtifact(runId, orgId);
        if (live?.id === latest.id) return live;
        throw new PaymentError("the replacement payment file is unavailable");
      }
      if (latest.id !== parent.id || ["superseded", "voided"].includes(parent.status)) {
        throw new PaymentError("only the latest non-voided payment file can be reprocessed");
      }
      // The parent row is locked FOR UPDATE above: superseding it while an
      // SFTP delivery holds (or parks) a claim would strand published bytes
      // behind a superseded record — refuse with the delivery remedy.
      if (parent.status === "delivering" || parent.status === "delivery_uncertain") {
        throw new PaymentError(
          `cannot reprocess the file while its SFTP delivery is ${parent.status}; wait for the delivery to complete or expire, or resolve the uncertain delivery first`,
        );
      }
    }
    const stored = await storeArtifactFile(
      orgId,
      userId,
      safeFilename,
      rendered.contentType,
      content,
      hash,
    );
    const seq = await db.execute<{ n: number }>(
      sql`select coalesce(max(sequence_number), 0) + 1 as n from payment_files where payment_run_id = ${runId} and org_id = ${orgId}`,
      "objects",
    );
    const parentId = opts?.reprocessFileId ?? null;
    // The file renders a run its approval flow already released, so it is
    // deliverable as generated; there is no second, file-level approval.
    const total = sum(ctx.payments.map((p) => p.amount));
    const artifact = (
      await db
        .insert(schema.paymentFiles)
        .values({
          orgId,
          paymentRunId: runId,
          paymentBankProfileId: ctx.profile.id,
          paymentFormatId: ctx.format.id,
          parentPaymentFileId: parentId,
          sequenceNumber: Number(seq[0]?.n ?? 1),
          filename: safeFilename,
          contentType: rendered.contentType,
          contentHash: hash,
          fileId: stored.fileId,
          fileVersionId: stored.versionId,
          paymentCount: ctx.payments.length,
          totalAmount: total,
          currency: String(ctx.run.currency),
          status: "approved",
          generatedBy: userId,
          approvedAt: now,
          approvedBy: null,
          createdBy: userId,
          updatedBy: userId,
        })
        .returning({ id: schema.paymentFiles.id })
    )[0]!;
    // Predicated against a delivery claimed after the parent check above
    // (belt and braces — the parent row is locked): the returning row proves
    // the supersede did not strand an in-flight publish.
    if (parentId) {
      const superseded = await db.execute<{ id: string }>(
        sql`
        update payment_files set status = 'superseded', updated_at = now(), updated_by = ${userId}
         where id = ${parentId} and payment_run_id = ${runId} and org_id = ${orgId}
           and status not in ('superseded', 'voided', 'delivering', 'delivery_uncertain')
        returning id
      `,
        "objects",
      );
      if (!superseded[0])
        throw new PaymentError("only the latest non-voided payment file can be reprocessed");
    }
    // Predicated on the same generable statuses judged under the lock above
    // (belt and braces — the row is already locked): a run rolled back before
    // this write lands cannot be flipped back to 'generated', and the
    // returning row proves the predicate held at write time.
    const transitioned = await db.execute<{ status: string }>(
      sql`
      update payment_runs set status = 'generated', exported_at = coalesce(exported_at, now()),
        exported_file_ref = ${safeFilename}, updated_at = now(), updated_by = ${userId}
      where id = ${runId} and org_id = ${orgId}
        and status in ('approved', 'generated', 'delivered', 'partially_failed')
      returning status
    `,
      "objects",
    );
    if (!transitioned[0])
      throw new PaymentError("approve the payment run before generating its file");
    await event({
      orgId,
      runId,
      fileId: artifact.id,
      actorId: userId,
      eventType: parentId ? "file_reprocessed" : "file_generated",
      fromStatus: liveStatus,
      toStatus: "generated",
      details: { hash, filename: safeFilename },
    });
    return { id: artifact.id, filename: safeFilename, contentType: rendered.contentType, content };
  });
}

export async function recordPaymentFileDownload(
  fileId: string,
  orgId: string,
  userId: string,
): Promise<void> {
  await withOrgTransaction(orgId, async () => {
    const file = await db.execute<{ payment_run_id: string }>(
      sql`
      select payment_run_id from payment_files where id = ${fileId} and org_id = ${orgId} and status in ('approved', 'delivered')
    `,
      "objects",
    );
    if (!file[0]) throw new PaymentError("payment file is not approved for delivery");
    const runId = file[0].payment_run_id;
    const scope = await paymentFileCommandScope(db, orgId, runId, userId, null);
    const lockedRun = (
      await db.execute(
        sql`select id from payment_runs where org_id = ${orgId} and id = ${runId} for update`,
        "objects",
      )
    )[0];
    if (!lockedRun) throw new ScopeNotFoundError();
    await paymentFileCommandScope(db, orgId, runId, userId, scope);
    await assertRunPayeesInScope(orgId, runId, scope);
    await lockPaymentFileSources(db, orgId, runId, scope);
    await db.insert(schema.paymentFileDeliveries).values({
      orgId,
      paymentFileId: fileId,
      channel: "download",
      targetRef: userId,
      status: "delivered",
      attemptCount: 1,
      lastAttemptAt: new Date(),
      deliveredAt: new Date(),
      createdBy: userId,
      updatedBy: userId,
    });
    // The approving select above is a snapshot: a rollback can commit before
    // this write does, so the predicate keeps a voided file from becoming
    // 'delivered' and the missing returning row fails the whole transaction.
    const delivered = await db.execute<{ id: string }>(
      sql`
      update payment_files set status = 'delivered', updated_at = now(), updated_by = ${userId}
       where id = ${fileId} and org_id = ${orgId} and status in ('approved', 'delivered')
       returning id
    `,
      "objects",
    );
    if (!delivered[0]) throw new PaymentError("payment file is not approved for delivery");
    // Re-downloading an already-delivered run is idempotent (the file update
    // above accepts 'delivered'), but any OTHER zero-row outcome means the
    // run moved on while its file was marked delivered — that divergence
    // must not record silently behind an unobserved update.
    const runDelivered = await db.execute<{ id: string }>(
      sql`
      update payment_runs set status = 'delivered', updated_at = now(), updated_by = ${userId}
       where id = ${file[0].payment_run_id} and org_id = ${orgId} and status = 'generated'
       returning id
    `,
      "objects",
    );
    if (!runDelivered[0]) {
      const runState = (
        await db.execute<{ status: string }>(
          sql`
        select status from payment_runs
         where id = ${file[0].payment_run_id} and org_id = ${orgId}
      `,
          "objects",
        )
      )[0];
      if (runState?.status !== "delivered") {
        throw new PaymentError(
          `payment run is ${runState?.status ?? "no longer present"} and cannot be marked delivered; reload the run before recording the delivery`,
        );
      }
    }
    await event({
      orgId,
      runId: file[0].payment_run_id,
      fileId,
      actorId: userId,
      eventType: "file_downloaded",
      fromStatus: "approved",
      toStatus: "delivered",
    });
  });
}
