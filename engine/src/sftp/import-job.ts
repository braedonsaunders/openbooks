import { sql } from "drizzle-orm";
import { db, withBypassContext, withOrgContext } from "../platform/db.ts";
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
  type StatementSourceContent,
} from "../banking/banking.ts";
import { claimPaymentFileDelivery, generatePaymentFileArtifact, markDeliveryUncertain, reclaimExpiredDeliveryClaims, recordPaymentFileDeliveryFailure, recordPaymentFileSftpDelivery, releaseDeliveryClaim } from "../payments/operations.ts";
import { backendFor } from "./backend.ts";
import { resolveOutboundPath } from "./delivery-path.ts";

/**
 * Inbound bank-feed loop: on each scheduler tick, walk every active SFTP import
 * schedule's watch folder, parse + import any new statement files into its bank
 * account, then move each file to `<folder>/processed/`. Outbound delivery
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

function parse(format: Exclude<Fmt, "auto">, content: StatementSourceContent, mapping: CsvMapping | null): { lines: ParsedStatementLine[]; meta: Omit<ParsedStatement, "lines"> } {
  // The file's account identifier rides through meta on every format that
  // carries one; CSV has none (its meta stays empty) and relies on
  // watch-folder isolation instead.
  if (format === "ofx") { const p = parseOfx(content); return { lines: p.lines, meta: { currency: p.currency, statementDate: p.statementDate, closingBalance: p.closingBalance, externalAccountId: p.externalAccountId } }; }
  if (format === "camt053") { const p = parseCamt053(content); return { lines: p.lines, meta: { currency: p.currency, statementDate: p.statementDate, closingBalance: p.closingBalance, externalAccountId: p.externalAccountId } }; }
  if (format === "bai2") { const p = parseBai2(content); return { lines: p.lines, meta: { currency: p.currency, statementDate: p.statementDate, closingBalance: p.closingBalance, externalAccountId: p.externalAccountId } }; }
  if (format === "mt940") { const p = parseMt940(content); return { lines: p.lines, meta: { currency: p.currency, statementDate: p.statementDate, closingBalance: p.closingBalance, externalAccountId: p.externalAccountId } }; }
  if (!mapping) throw new Error("CSV import needs a column mapping on the schedule");
  return { lines: parseCsv(content, mapping), meta: {} };
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
}
type ScheduleRow = {
  id: string; org_id: string; account_id: string; format: Fmt; folder: string; csv_mapping: CsvMapping | null;
  expected_external_account_id: string | null;
  backend: string; bucket: string | null; root_prefix: string;
};

async function runSchedule(s: ScheduleRow): Promise<ScheduleRun> {
  const backend = backendFor({ backend: s.backend, bucket: s.bucket, rootPrefix: s.root_prefix, orgId: s.org_id });
  // Engine-initiated write provenance: a schedule scan is performed by the
  // system itself — the bank machine file has no human importer and neither
  // the schedule's author nor any org-scoped id may stand in as one
  // ({@link SYSTEM_ACTOR_ID} is the documented non-user engine actor). The
  // schedule identity travels on ctx.requestId so each audit row stays
  // traceable back to the exact run/schedule that imported it.
  const ctx: BankingContext = { orgId: s.org_id, userId: SYSTEM_ACTOR_ID, requestId: sftpImportAuditSource(s.id) };
  const result: ScheduleRun = { scheduleId: s.id, filesSeen: 0, imported: 0, duplicates: 0, errors: [], files: [] };
  let entries: { name: string; isDir: boolean }[] = [];
  try { entries = await backend.list(s.folder); } catch (e) { result.errors.push(`list ${s.folder}: ${(e as Error).message}`); return result; }

  for (const e of entries) {
    if (e.isDir || e.name.startsWith(".")) continue;
    result.filesSeen++;
    const filePath = `${s.folder}/${e.name}`;
    const outcome: ScheduleFileOutcome = { file: e.name, imported: 0, duplicates: 0, statementIds: [] };
    result.files.push(outcome);
    try {
      const sourceBytes = await backend.read(filePath);
      // Format sniffing works on lossy text, but parsing must see the exact
      // bytes: the engine decodes BOMs and legacy encodings itself, and a
      // UTF-8 string coercion here corrupts every non-UTF8 file (e.g. UTF-16
      // bank exports) before the parser runs.
      const fmt = s.format === "auto" ? detectFormat(e.name, sourceBytes.toString("utf8")) : s.format;
      if (!fmt) throw new Error(`could not detect a statement format for ${e.name}`);
      const { lines, meta } = parse(fmt, sourceBytes, s.csv_mapping);
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
      if (res.statementId) outcome.statementIds.push(res.statementId);
      // archive the processed file so it isn't re-imported
      await backend.rename(filePath, `${s.folder}/processed/${e.name}`);
    } catch (err) {
      const message = (err as Error).message;
      result.errors.push(`${e.name}: ${message}`);
      outcome.error = message;
    }
  }
  return result;
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
           sc.expected_external_account_id,
           sv.backend, sv.bucket, sv.root_prefix
      from sftp_import_schedules sc
      join sftp_servers sv on sv.id = sc.sftp_server_id and sv.org_id = sc.org_id and sv.is_active
      join orgs o on o.id = sc.org_id
     where sc.is_active
       and o.env_kind = 'production'
       and coalesce((o.settings->'features'->>'bankFeeds')::boolean, false)
       ${orgId ? sql`and sc.org_id = ${orgId}` : sql``}
       ${scheduleId ? sql`and sc.id = ${scheduleId}` : sql``}
  `));
  const runs: ScheduleRun[] = [];
  for (const s of rows.rows) {
    let run: ScheduleRun;
    try { run = await withOrgContext(s.org_id, () => runSchedule(s)); }
    catch (e) { run = { scheduleId: s.id, filesSeen: 0, imported: 0, duplicates: 0, errors: [(e as Error).message], files: [] }; }
    runs.push(run);
    await withOrgContext(s.org_id, () =>
      db.execute(sql`
      update sftp_import_schedules set last_run_at = now(), last_result = ${JSON.stringify(run)}::jsonb where id = ${s.id} and org_id = ${s.org_id}
    `));
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
  let recordError: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await recordPaymentFileSftpDelivery({ fileId: file.id, orgId, userId, targetRef, claimToken: claim.token, response: { path } });
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
