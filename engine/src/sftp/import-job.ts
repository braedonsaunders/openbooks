import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, pool, withBypassContext, withOrgContext } from "../platform/db.ts";
import {
  BANK_STATEMENT_PARSER_VERSION,
  SYSTEM_ACTOR_ID,
  importStatement,
  normalizeExternalAccountId,
  parseOfx,
  parseCsv,
  parseCamt053,
  parseBai2,
  parseMt940,
  type BankingContext,
  type CsvMapping,
  type ParsedStatement,
  type ParsedStatementLine,
  type SkippedStatementRow,
  type StatementSourceContent,
} from "../banking/banking.ts";
import { claimPaymentFileDelivery, generatePaymentFileArtifact, markDeliveryUncertain, reclaimExpiredDeliveryClaims, recordPaymentFileDeliveryFailure, recordPaymentFileSftpDelivery, releaseDeliveryClaim } from "../payments/operations.ts";
import { backendFor, type SftpBackend } from "./backend.ts";
import { resolveOutboundPath } from "./delivery-path.ts";
import { SFTP_UNBOUND_SCHEDULE_NOTICE_KIND, sftpUnboundScheduleNoticeHref } from "./schedule-notice.ts";

/**
 * Archive destination for one consumed watch-folder file: a unique generation
 * under `<folder>/processed/<UTC-date>/` carrying a short content hash
 * (`<stem>.<12-hex><ext>`), so a bank sending the same routine filename daily
 * archives every generation instead of overwriting yesterday's. `attempt`
 * numbers a re-import of identical bytes (or a hash collision) that must not
 * replace the archived generation. Pure: takes the day and attempt
 * explicitly so tests pin them; the scan passes the current UTC day.
 */
export function archiveDestination(folder: string, name: string, content: Buffer, utcDay: string, attempt = 1): string {
  const hash = createHash("sha256").update(content).digest("hex").slice(0, 12);
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  const file = attempt <= 1 ? `${stem}.${hash}${ext}` : `${stem}.${hash}.${attempt}${ext}`;
  return `${folder}/processed/${utcDay}/${file}`;
}

/**
 * First free archive generation for a consumed file. Existence is checked
 * through the backend, so the no-overwrite guarantee holds for local disk
 * and S3 alike: if the destination somehow exists, the next numbered
 * generation is taken — an archived file is never replaced silently.
 */
export async function archiveConsumedFile(backend: SftpBackend, folder: string, name: string, content: Buffer): Promise<string> {
  const utcDay = new Date().toISOString().slice(0, 10);
  for (let attempt = 1; attempt <= 1000; attempt++) {
    const candidate = archiveDestination(folder, name, content, utcDay, attempt);
    if ((await backend.stat(candidate)) === null) return candidate;
  }
  throw new Error(`could not archive ${name}: no free generation under ${folder}/processed/${utcDay}`);
}

/**
 * Inbound bank-feed loop: on each scheduler tick, walk every active SFTP import
 * schedule's watch folder, parse + import any new statement files into its bank
 * account, then archive each file to a unique `<folder>/processed/`
 * generation (see {@link archiveConsumedFile}). Outbound delivery
 * writes a payment run's file into a server's `outbound/` folder for the bank
 * to fetch. Both reuse the SFTP backend (MinIO/local) and the format parsers.
 *
 * Import provenance: scans are engine-initiated, so every statement they write
 * carries {@link SYSTEM_ACTOR_ID} as the actor (never the schedule author or an
 * org id standing in for one) plus a durable `sftp-import:<scheduleId>` marker
 * in `audit_log.request_id`. Interactive statement imports keep their real
 * operator attribution; only this machine path is system-owned.
 */

type Fmt = "auto" | "ofx" | "csv" | "camt053" | "bai2" | "mt940";

function detectFormat(name: string, text: string): Exclude<Fmt, "auto" | "csv"> | "csv" | null {
  const n = name.toLowerCase();
  if (n.endsWith(".ofx") || n.endsWith(".qfx")) return "ofx";
  if (n.endsWith(".xml")) return "camt053";
  if (n.endsWith(".bai") || n.endsWith(".bai2")) return "bai2";
  if (n.endsWith(".sta") || n.endsWith(".mt940")) return "mt940";
  if (n.endsWith(".csv")) return "csv";
  const head = text.slice(0, 200).trim();
  if (head.startsWith("<")) return head.includes("OFX") ? "ofx" : "camt053";
  if (/^OFXHEADER|<OFX>/i.test(head)) return "ofx";
  if (/^:\d{2}[A-Z]?:/m.test(head) || head.includes(":61:")) return "mt940";
  if (/^01,/.test(head)) return "bai2";
  return null;
}

function parse(format: Exclude<Fmt, "auto">, content: StatementSourceContent, mapping: CsvMapping | null): { lines: ParsedStatementLine[]; skipped: SkippedStatementRow[]; meta: Omit<ParsedStatement, "lines"> } {
  // The file's account identifier rides through meta on every format that
  // carries one; CSV has none (its meta stays empty) and relies on
  // watch-folder isolation instead.
  if (format === "ofx") { const p = parseOfx(content); return { lines: p.lines, skipped: [], meta: { currency: p.currency, statementDate: p.statementDate, closingBalance: p.closingBalance, externalAccountId: p.externalAccountId } }; }
  if (format === "camt053") { const p = parseCamt053(content); return { lines: p.lines, skipped: [], meta: { currency: p.currency, statementDate: p.statementDate, closingBalance: p.closingBalance, externalAccountId: p.externalAccountId } }; }
  if (format === "bai2") { const p = parseBai2(content); return { lines: p.lines, skipped: [], meta: { currency: p.currency, statementDate: p.statementDate, closingBalance: p.closingBalance, externalAccountId: p.externalAccountId } }; }
  if (format === "mt940") { const p = parseMt940(content); return { lines: p.lines, skipped: [], meta: { currency: p.currency, statementDate: p.statementDate, closingBalance: p.closingBalance, externalAccountId: p.externalAccountId } }; }
  if (!mapping) throw new Error("CSV import needs a column mapping on the schedule");
  const csvParsed = parseCsv(content, mapping);
  return { lines: csvParsed.lines, skipped: csvParsed.skipped, meta: {} };
}

/**
 * Account-identity gate for one watch-folder file. A same-currency
 * statement for account B dropped in account A's folder used to become
 * A's lines and balance evidence silently. Both directions fail closed:
 * a mismatch against the schedule's binding refuses, and an identified
 * file with no binding refuses too — the schedule must name its account
 * once (Company Settings → Bank Feeds → schedule) instead of importing
 * strangers. Files with no identifier (CSV, identifier-less exports)
 * bypass: they rely on watch-folder isolation. Comparison is canonical
 * (whitespace-blind, case-blind) but messages show the raw values the
 * operator recognizes.
 */
export function assertScheduleAccountBinding(opts: {
  scheduleId: string;
  filename: string;
  expectedExternalAccountId: string | null;
  foundExternalAccountId?: string | null;
}): void {
  const found = normalizeExternalAccountId(opts.foundExternalAccountId);
  if (!found) return;
  const expected = normalizeExternalAccountId(opts.expectedExternalAccountId);
  if (!expected) {
    throw new Error(
      `statement file ${opts.filename} identifies bank account ${opts.foundExternalAccountId} but its import schedule has no expected account configured — set the expected external account on the schedule (Company Settings → Bank Feeds) before importing identified statements`,
    );
  }
  if (found !== expected) {
    throw new Error(
      `statement file ${opts.filename} identifies bank account ${opts.foundExternalAccountId} but its import schedule expects ${opts.expectedExternalAccountId} — move the file to the matching account's folder`,
    );
  }
}

/**
 * Durable provenance marker stamped into `audit_log.request_id` for every
 * statement the scheduled SFTP pull imports: readers can always tell which
 * schedule brought a statement in, independent of who (if anyone) is in the
 * org, and the marker never references a human actor.
 */
export function sftpImportAuditSource(scheduleId: string): string {
  return `sftp-import:${scheduleId}`;
}

/** Outcome of one watch-folder file within a scan. */
export interface ScheduleFileOutcome {
  file: string;
  imported: number;
  duplicates: number;
  /** Source rows the parser set aside (see SkippedStatementRow). */
  skipped: SkippedStatementRow[];
  /** Statement ids created for this file (empty when deduped or failed). */
  statementIds: string[];
  error?: string;
}

export interface ScheduleRun {
  scheduleId: string;
  filesSeen: number;
  imported: number;
  duplicates: number;
  errors: string[];
  files: ScheduleFileOutcome[];
  /** Another live scan owns the schedule's shared advisory lock. */
  alreadyRunning?: true;
}
type ScheduleRow = {
  id: string; org_id: string; account_id: string; format: Fmt; folder: string; csv_mapping: CsvMapping | null;
  expected_external_account_id: string | null;
  created_by: string | null; account_number: string | null; account_name: string | null; server_name: string;
  backend: string; bucket: string | null; root_prefix: string;
};

/**
 * Upgrade-operability surfacing for the 0291 identity binding. That
 * migration added `expected_external_account_id` nullable with no backfill,
 * so every schedule predating it refuses each identified statement until an
 * operator binds the account — with only a per-file error left in the watch
 * folder to show for it. The first scheduler pass after the upgrade (and
 * every pass until bound) therefore raises one VISIBLE named notice per
 * schedule through the house notifications channel (surfaced in
 * /notifications and the inbox with zero extra plumbing), naming the
 * schedule and the remedy and linking the exact setting. Deliberately NOT a
 * silent auto-bind: nothing imports unverified, and the fail-closed gate in
 * {@link assertScheduleAccountBinding} stays the enforcement point.
 *
 * CSV schedules are excluded: CSV carries no account identifier and imports
 * on watch-folder isolation, so an unbound CSV route is healthy, not
 * paused — notifying (or badging) it would be a false claim.
 *
 * Idempotent: a second pass finds the unread notice and writes nothing, so
 * the tick never spams. The notice resolves when the binding lands (the
 * Bank Feeds API marks it read on bind/delete) and re-fires if the binding
 * is cleared again.
 */
export async function ensureUnboundScheduleNotice(s: ScheduleRow): Promise<number> {
  const href = sftpUnboundScheduleNoticeHref(s.id);
  // The account owner first: the schedule's author while they are still an
  // active user of the org, plus whoever can reach the setting — active
  // super-admins (every permission) and active holders of a role directly
  // granting admin.setup.manage. A notification target is not an authz
  // decision, so wildcard/override grants are out of scope here; the author
  // plus setup managers cover every operable org, and the per-file refusal
  // plus the schedule badge keep naming the remedy regardless.
  const recipients = (await db.execute<{ id: string }>(sql`
    select distinct u.id::text as id
      from users u
      left join role_assignments a on a.user_id = u.id and a.org_id = u.org_id
      left join app_roles r on r.id = a.role_id and r.org_id = a.org_id
     where u.org_id = ${s.org_id} and u.is_active
       and (u.id = ${s.created_by} or u.is_super_admin or (r.permissions ? 'admin.setup.manage'))
  `)).rows;
  const accountLabel = [s.account_number, s.account_name].filter(Boolean).join(" · ") || s.account_id;
  const title = `SFTP schedule /${s.folder} has no expected bank account — identified statements refuse`;
  const body =
    `Route /${s.folder} on server ${s.server_name} feeds ${accountLabel} but no expected external account is bound, ` +
    `so every identified OFX, BAI2, MT940 or CAMT.053 statement refuses and nothing imports. ` +
    `Bind the expected bank account in the schedule settings (Company Settings → Bank Feeds); ` +
    `identified statements import on the next run after binding.`;
  let written = 0;
  for (const recipient of recipients) {
    const existing = (await db.execute<{ one: number }>(sql`
      select 1 as one from notifications
       where org_id = ${s.org_id} and user_id = ${recipient.id}::uuid
         and kind = ${SFTP_UNBOUND_SCHEDULE_NOTICE_KIND} and href = ${href} and read_at is null
       limit 1
    `)).rows[0];
    if (existing) continue;
    // Same columns as the shared writeNotification path (kind, title, body,
    // href, org + user scope) — see engine/src/inbox/adapters/notification.ts:
    // the row surfaces in /notifications and as an inbox item with zero
    // extra plumbing. Inlined (not imported) so the sftp module gains no
    // inbox edge; the hrm qualification alerts use the same convention.
    const inserted = (await db.execute<{ id: string }>(sql`
      insert into notifications (org_id, user_id, kind, title, body, href)
      values (${s.org_id}, ${recipient.id}::uuid, ${SFTP_UNBOUND_SCHEDULE_NOTICE_KIND}, ${title}, ${body}, ${href})
      returning id
    `)).rows[0]?.id;
    if (!inserted) throw new Error("the unbound-schedule notice was not stored — no row was written; retry the action");
    written += 1;
  }
  return written;
}

async function runSchedule(s: ScheduleRow): Promise<ScheduleRun> {
  const backend = backendFor({ backend: s.backend, bucket: s.bucket, rootPrefix: s.root_prefix, orgId: s.org_id });
  // Engine-initiated write provenance: a schedule scan is performed by the
  // system itself — the bank machine file has no human importer and neither
  // the schedule's author nor any org-scoped id may stand in as one
  // ({@link SYSTEM_ACTOR_ID} is the documented non-user engine actor). The
  // schedule identity travels on ctx.requestId so each audit row stays
  // traceable back to the exact run/schedule that imported it.
  // System-initiated: the daemon runs with explicit unrestricted scope, so
  // scheduled imports keep working exactly as before scoped callers existed.
  const ctx: BankingContext = { orgId: s.org_id, userId: SYSTEM_ACTOR_ID, requestId: sftpImportAuditSource(s.id), allowedSubsidiaryIds: null };
  const result: ScheduleRun = { scheduleId: s.id, filesSeen: 0, imported: 0, duplicates: 0, errors: [], files: [] };
  let entries: { name: string; isDir: boolean }[] = [];
  try { entries = await backend.list(s.folder); } catch (e) { result.errors.push(`list ${s.folder}: ${(e as Error).message}`); return result; }

  for (const e of entries) {
    if (e.isDir || e.name.startsWith(".")) continue;
    result.filesSeen++;
    const filePath = `${s.folder}/${e.name}`;
    const outcome: ScheduleFileOutcome = { file: e.name, imported: 0, duplicates: 0, skipped: [], statementIds: [] };
    result.files.push(outcome);
    try {
      const sourceBytes = await backend.read(filePath);
      // Format sniffing works on lossy text, but parsing must see the exact
      // bytes: the engine decodes BOMs and legacy encodings itself, and a
      // UTF-8 string coercion here corrupts every non-UTF8 file (e.g. UTF-16
      // bank exports) before the parser runs.
      const fmt = s.format === "auto" ? detectFormat(e.name, sourceBytes.toString("utf8")) : s.format;
      if (!fmt) throw new Error(`could not detect a statement format for ${e.name}`);
      const { lines, skipped, meta } = parse(fmt, sourceBytes, s.csv_mapping);
      // Identity before import: a stranger file refuses here (recorded on
      // the outcome, left in the folder) instead of becoming this
      // account's lines and balance evidence.
      assertScheduleAccountBinding({
        scheduleId: s.id,
        filename: e.name,
        expectedExternalAccountId: s.expected_external_account_id,
        foundExternalAccountId: meta.externalAccountId,
      });
      const res = await importStatement(
        {
          accountId: s.account_id,
          source: fmt === "csv" ? "csv" : fmt,
          lines,
          skippedLines: skipped,
          statementDate: meta.statementDate ?? null,
          openingBalance: null,
          closingBalance: meta.closingBalance ?? null,
          currency: meta.currency ?? null,
          sourceEvidence: {
            content: sourceBytes,
            filename: e.name,
            parserVersion: BANK_STATEMENT_PARSER_VERSION,
            csvMapping: fmt === "csv" ? s.csv_mapping : null,
          },
          dryRun: false,
        },
        ctx,
      );
      result.imported += res.imported;
      result.duplicates += res.duplicates;
      outcome.imported = res.imported;
      outcome.duplicates = res.duplicates;
      outcome.skipped = res.skipped;
      if (res.statementId) outcome.statementIds.push(res.statementId);
      // Archive the consumed file so it isn't re-imported: a unique dated,
      // content-hashed generation that never overwrites a previous archive
      // (a bank reusing a routine filename daily keeps every generation).
      const archived = await archiveConsumedFile(backend, s.folder, e.name, sourceBytes);
      await backend.rename(filePath, archived);
    } catch (err) {
      const message = (err as Error).message;
      result.errors.push(`${e.name}: ${message}`);
      outcome.error = message;
    }
  }
  return result;
}

/**
 * Persist one finished schedule scan onto its schedule row. A zero matched
 * row count means the schedule was deleted mid-scan (deactivation alone
 * still matches — the update carries no is_active predicate): the run
 * evidence (files seen, statement ids, errors) must not be dropped while
 * the returned run claims success. It is recorded where it cannot be lost —
 * an audit_log row keyed to the schedule — and reported as a named error in
 * the returned run, so both the operator surface and the scheduler log show
 * what happened instead of a phantom clean scan.
 */
export async function recordScheduleRunOutcome(
  s: Pick<ScheduleRow, "id" | "org_id">,
  run: ScheduleRun,
): Promise<ScheduleRun> {
  const updated = await db.execute(sql`
    update sftp_import_schedules set last_run_at = now(), last_result = ${JSON.stringify(run)}::jsonb where id = ${s.id} and org_id = ${s.org_id}
  `);
  if ((updated.rowCount ?? 0) > 0) return run;
  const message =
    `schedule '${s.id}' was deleted during the scan — last_result was not recorded; ` +
    `the run evidence is preserved in the audit trail and in this result`;
  await db.execute(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id, request_id)
    values (${s.org_id}, 'sftp_import_schedules', ${s.id}, 'scan_outcome_unrecorded', ${JSON.stringify(run)}::jsonb, ${SYSTEM_ACTOR_ID}, ${sftpImportAuditSource(s.id)})
  `);
  return { ...run, errors: [...run.errors, message] };
}

/** Stable advisory-lock identity shared by scheduler ticks and manual runs. */
export function sftpImportScheduleRunLockKey(orgId: string, scheduleId: string): string {
  return `sftp-import-schedule:${orgId}:${scheduleId}`;
}

/**
 * Claim and run one schedule. The session advisory lock serializes every
 * entrypoint for the full external-file lifetime and releases automatically
 * if the worker dies. The row token is durable evidence of the active attempt;
 * after a process death, the next lock owner replaces that stale token and
 * resumes from the still-unarchived source files.
 */
async function runClaimedSchedule(s: ScheduleRow): Promise<ScheduleRun> {
  const lockConnection = await pool.connect();
  const lockKey = sftpImportScheduleRunLockKey(s.org_id, s.id);
  let acquired = false;
  try {
    acquired = (await lockConnection.query<{ acquired: boolean }>(
      "select pg_try_advisory_lock(hashtextextended($1, 0)) as acquired",
      [lockKey],
    )).rows[0]?.acquired === true;
    if (!acquired) {
      return {
        scheduleId: s.id, filesSeen: 0, imported: 0, duplicates: 0,
        errors: ["this SFTP import schedule is already running; wait for the active scan to finish"],
        files: [], alreadyRunning: true,
      };
    }

    const claimToken = randomUUID();
    const claimed = await withOrgContext(s.org_id, () => db.execute(sql`
      update sftp_import_schedules
         set run_claim_token = ${claimToken}, run_claimed_at = now()
       where id = ${s.id} and org_id = ${s.org_id} and is_active
       returning id
    `));
    if (!claimed.rows[0]) {
      return {
        scheduleId: s.id, filesSeen: 0, imported: 0, duplicates: 0,
        errors: ["this SFTP import schedule is no longer active; activate it before running"],
        files: [],
      };
    }

    let run: ScheduleRun;
    try {
      run = await withOrgContext(s.org_id, () => runSchedule(s));
    } catch (e) {
      run = { scheduleId: s.id, filesSeen: 0, imported: 0, duplicates: 0, errors: [(e as Error).message], files: [] };
    }
    const saved = await withOrgContext(s.org_id, () => db.execute(sql`
      update sftp_import_schedules
         set last_run_at = now(), last_result = ${JSON.stringify(run)}::jsonb,
             run_claim_token = null, run_claimed_at = null
       where id = ${s.id} and org_id = ${s.org_id} and run_claim_token = ${claimToken}
       returning id
    `));
    if (!saved.rows[0]) {
      const message = `SFTP schedule '${s.id}' disappeared or its run claim changed before the outcome could be saved`;
      await withOrgContext(s.org_id, () => db.execute(sql`
        insert into audit_log (org_id, table_name, row_id, action, changes, actor_id, request_id)
        values (${s.org_id}, 'sftp_import_schedules', ${s.id}, 'scan_outcome_unrecorded', ${JSON.stringify(run)}::jsonb,
                ${SYSTEM_ACTOR_ID}, ${sftpImportAuditSource(s.id)})
      `));
      return { ...run, errors: [...run.errors, message] };
    }

    // The unbound schedule notice is part of the claimant's outcome work too;
    // another invocation that loses the lock never writes schedule evidence.
    if (s.format !== "csv" && !normalizeExternalAccountId(s.expected_external_account_id)) {
      await withOrgContext(s.org_id, () => ensureUnboundScheduleNotice(s));
    }
    return run;
  } finally {
    let releaseError: Error | undefined;
    if (acquired) {
      try {
        const unlocked = await lockConnection.query<{ unlocked: boolean }>(
          "select pg_advisory_unlock(hashtextextended($1, 0)) as unlocked",
          [lockKey],
        );
        if (!unlocked.rows[0]?.unlocked) releaseError = new Error("SFTP schedule advisory lock could not be released");
      } catch (error) {
        releaseError = error instanceof Error ? error : new Error(String(error));
      }
    }
    lockConnection.release(releaseError);
  }
}

/** Run every active import schedule due for a scan (called from the scheduler tick). */
export async function runDueSftpImports(orgId?: string, scheduleId?: string): Promise<ScheduleRun[]> {
  // Discovering due schedules spans organizations (the scheduler tick passes no
  // orgId) and crosses an explicit trusted boundary; each import then runs
  // inside its own tenant. A timer callback holds no request store, so without
  // these the connection layer denies by default and the scan sees nothing.
  const rows = await withBypassContext(() =>
    db.execute<ScheduleRow>(sql`
    select sc.id, sc.org_id, sc.account_id, sc.format, sc.folder, sc.csv_mapping,
           sc.expected_external_account_id, sc.created_by,
           a.number as account_number, a.name as account_name, sv.name as server_name,
           sv.backend, sv.bucket, sv.root_prefix
      from sftp_import_schedules sc
      join sftp_servers sv on sv.id = sc.sftp_server_id and sv.org_id = sc.org_id and sv.is_active
      join accounts a on a.id = sc.account_id and a.org_id = sc.org_id
      join orgs o on o.id = sc.org_id
     where sc.is_active
       and o.env_kind = 'production'
       and case (o.settings->'features'->>'bankFeeds') when 'true' then true when 'false' then false else false end -- registry fallback shape (non-boolean stored values fall back to the default instead of throwing 22P02)
       ${orgId ? sql`and sc.org_id = ${orgId}` : sql``}
       ${scheduleId ? sql`and sc.id = ${scheduleId}` : sql``}
  `));
  const runs: ScheduleRun[] = [];
  for (const s of rows.rows) {
    let run: ScheduleRun;
    try { run = await runClaimedSchedule(s); }
    catch (e) { run = { scheduleId: s.id, filesSeen: 0, imported: 0, duplicates: 0, errors: [(e as Error).message], files: [] }; }
    runs.push(run);
  }
  return runs;
}

/** Outbound: write a payment run's bank file into an SFTP server's outbound folder. */
export async function deliverRunToSftp(runId: string, sftpServerId: string, orgId: string, userId: string, now: Date): Promise<{ filename: string; path: string }> {
  // Reclaim first: a worker that crashed mid-publish leaves its file in
  // delivering with a dead lease, and the reclaim has no other production
  // caller — without this call the file would wedge there forever. Expired
  // leases park as delivery_uncertain (never silent re-publish), so this is
  // safe to run ahead of every delivery.
  await reclaimExpiredDeliveryClaims({ orgId, userId });
  const svr = (await db.execute<{ org_id: string; backend: string; bucket: string | null; root_prefix: string; payment_folder: string }>(sql`
    select s.org_id, s.backend, s.bucket, s.root_prefix, coalesce(p.sftp_folder, 'outbound') as payment_folder
      from payment_runs r join payment_bank_profiles p on p.id = r.payment_bank_profile_id and p.org_id = r.org_id
      join sftp_servers s on s.id = ${sftpServerId} and s.org_id = r.org_id and s.is_active
     where r.id = ${runId} and r.org_id = ${orgId}
       and (p.sftp_server_id is null or p.sftp_server_id = s.id)
  `));
  if (!svr.rows[0]) throw new Error("SFTP server not found or inactive");
  const file = await generatePaymentFileArtifact(runId, orgId, userId, { now });
  const backend = backendFor({ backend: svr.rows[0].backend, bucket: svr.rows[0].bucket, rootPrefix: svr.rows[0].root_prefix, orgId: svr.rows[0].org_id });
  const folder = svr.rows[0].payment_folder.replace(/^\/+|\/+$/g, "");
  if (!folder || folder.split("/").some((part) => part === ".." || part === ".")) throw new Error("payment profile SFTP folder is invalid");
  // Defence in depth: the artifact name is validated at creation, but rows
  // stored before that guard must still fail closed at publish time — and the
  // joined path must provably stay inside the configured folder, because the
  // backend normalizes dot segments on write. Validated BEFORE the claim so
  // no failure here can strand a held lease.
  const path = resolveOutboundPath(folder, file.filename);
  const targetRef = `${sftpServerId}:${path}`;
  // Claim the delivery BEFORE the external write, in one transaction: the
  // row is locked and must be approved (or a live re-delivery) — a void,
  // supersede, rejection, or rollback that committed first refuses here, so
  // a disallowed file can never reach the endpoint. The claim's lease also
  // makes concurrent lifecycle moves refuse while the publish is in flight.
  const claim = await claimPaymentFileDelivery({ fileId: file.id, orgId, userId, owner: `sftp:${sftpServerId}` });
  try {
    await backend.write(path, file.content);
  } catch (error) {
    // Nothing was published: record the failure evidence, then release the
    // claim so the file is deliverable again.
    await recordPaymentFileDeliveryFailure({ fileId: file.id, orgId, userId, channel: "sftp", targetRef, error: error instanceof Error ? error.message : String(error) });
    await releaseDeliveryClaim({ fileId: file.id, orgId, userId, token: claim.token });
    throw error;
  }
  // The bytes are published: the file must end this function recorded as
  // delivered (never as undelivered). A bounded record retry absorbs a
  // transient commit failure; if the record still fails, the file is parked
  // as delivery_uncertain — published but unconfirmed, re-delivery blocked,
  // operator-visible — and the throw says exactly that.
  // The delivery evidence carries the approved artifact's hash alongside the
  // path: anyone fetching the published file later (the bank, an operator, a
  // verifier) can prove the bytes are still the approved ones. Computed over
  // exactly the bytes published below — the same content the artifact row's
  // content_hash was built from.
  const sha256 = createHash("sha256").update(file.content).digest("hex");
  let recordError: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await recordPaymentFileSftpDelivery({ fileId: file.id, orgId, userId, targetRef, claimToken: claim.token, response: { path, sha256 } });
      return { filename: file.filename, path };
    } catch (error) {
      recordError = error;
    }
  }
  const recordMessage = recordError instanceof Error ? recordError.message : String(recordError);
  await markDeliveryUncertain({ fileId: file.id, orgId, userId, token: claim.token, error: recordMessage });
  throw new Error(
    `the bank file was published to ${path} but recording the delivery failed (${recordMessage}); the file is parked as delivery-uncertain — resolve it before re-delivering`,
  );
}
