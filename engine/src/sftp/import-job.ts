import { sql } from "drizzle-orm";
import { db } from "../db.ts";
import {
  importStatement,
  parseOfx,
  parseCsv,
  parseCamt053,
  parseBai2,
  parseMt940,
  type CsvMapping,
  type ParsedStatement,
  type ParsedStatementLine,
} from "../banking.ts";
import { generatePaymentFileArtifact, recordPaymentFileSftpDelivery } from "../payment-operations.ts";
import { backendFor } from "./backend.ts";

/**
 * Inbound bank-feed loop: on each scheduler tick, walk every active SFTP import
 * schedule's watch folder, parse + import any new statement files into its bank
 * account, then move each file to `<folder>/processed/`. Outbound delivery
 * writes a payment run's file into a server's `outbound/` folder for the bank
 * to fetch. Both reuse the SFTP backend (MinIO/local) and the format parsers.
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

function parse(format: Exclude<Fmt, "auto">, text: string, mapping: CsvMapping | null): { lines: ParsedStatementLine[]; meta: Omit<ParsedStatement, "lines"> } {
  if (format === "ofx") { const p = parseOfx(text); return { lines: p.lines, meta: { currency: p.currency, statementDate: p.statementDate, closingBalance: p.closingBalance } }; }
  if (format === "camt053") { const p = parseCamt053(text); return { lines: p.lines, meta: { currency: p.currency, statementDate: p.statementDate, closingBalance: p.closingBalance } }; }
  if (format === "bai2") { const p = parseBai2(text); return { lines: p.lines, meta: { currency: p.currency, statementDate: p.statementDate, closingBalance: p.closingBalance } }; }
  if (format === "mt940") { const p = parseMt940(text); return { lines: p.lines, meta: { currency: p.currency, statementDate: p.statementDate, closingBalance: p.closingBalance } }; }
  if (!mapping) throw new Error("CSV import needs a column mapping on the schedule");
  return { lines: parseCsv(text, mapping), meta: {} };
}

export interface ScheduleRun {
  scheduleId: string;
  filesSeen: number;
  imported: number;
  duplicates: number;
  errors: string[];
}

interface ScheduleRow {
  id: string; org_id: string; account_id: string; format: Fmt; folder: string; csv_mapping: CsvMapping | null;
  created_by: string | null; backend: string; bucket: string | null; root_prefix: string;
}

async function runSchedule(s: ScheduleRow): Promise<ScheduleRun> {
  const backend = backendFor({ backend: s.backend, bucket: s.bucket, rootPrefix: s.root_prefix });
  const ctx = { orgId: s.org_id, userId: s.created_by ?? s.org_id };
  const result: ScheduleRun = { scheduleId: s.id, filesSeen: 0, imported: 0, duplicates: 0, errors: [] };
  let entries: { name: string; isDir: boolean }[] = [];
  try { entries = await backend.list(s.folder); } catch (e) { result.errors.push(`list ${s.folder}: ${(e as Error).message}`); return result; }

  for (const e of entries) {
    if (e.isDir || e.name.startsWith(".")) continue;
    result.filesSeen++;
    const filePath = `${s.folder}/${e.name}`;
    try {
      const text = (await backend.read(filePath)).toString("utf8");
      const fmt = s.format === "auto" ? detectFormat(e.name, text) : s.format;
      if (!fmt) throw new Error(`could not detect a statement format for ${e.name}`);
      const { lines, meta } = parse(fmt, text, s.csv_mapping);
      const res = await importStatement(
        { accountId: s.account_id, source: fmt === "csv" ? "csv" : fmt, lines, statementDate: meta.statementDate ?? null, openingBalance: null, closingBalance: meta.closingBalance ?? null, currency: meta.currency ?? null, dryRun: false },
        ctx,
      );
      result.imported += res.imported;
      result.duplicates += res.duplicates;
      // archive the processed file so it isn't re-imported
      await backend.rename(filePath, `${s.folder}/processed/${e.name}`).catch(() => {});
    } catch (err) {
      result.errors.push(`${e.name}: ${(err as Error).message}`);
    }
  }
  return result;
}

/** Run every active import schedule due for a scan (called from the scheduler tick). */
export async function runDueSftpImports(): Promise<ScheduleRun[]> {
  const rows = (await db.execute(sql`
    select sc.id, sc.org_id, sc.account_id, sc.format, sc.folder, sc.csv_mapping, sc.created_by,
           sv.backend, sv.bucket, sv.root_prefix
      from sftp_import_schedules sc
      join sftp_servers sv on sv.id = sc.sftp_server_id and sv.is_active
     where sc.is_active
  `)) as unknown as { rows: ScheduleRow[] };
  const runs: ScheduleRun[] = [];
  for (const s of rows.rows) {
    let run: ScheduleRun;
    try { run = await runSchedule(s); }
    catch (e) { run = { scheduleId: s.id, filesSeen: 0, imported: 0, duplicates: 0, errors: [(e as Error).message] }; }
    runs.push(run);
    await db.execute(sql`
      update sftp_import_schedules set last_run_at = now(), last_result = ${JSON.stringify(run)}::jsonb where id = ${s.id}
    `);
  }
  return runs;
}

/** Outbound: write a payment run's bank file into an SFTP server's outbound folder. */
export async function deliverRunToSftp(runId: string, sftpServerId: string, orgId: string, userId: string, now: Date): Promise<{ filename: string; path: string }> {
  const svr = (await db.execute(sql`
    select backend, bucket, root_prefix from sftp_servers where id = ${sftpServerId} and org_id = ${orgId} and is_active
  `)) as unknown as { rows: { backend: string; bucket: string | null; root_prefix: string }[] };
  if (!svr.rows[0]) throw new Error("SFTP server not found or inactive");
  const file = await generatePaymentFileArtifact(runId, orgId, userId, { now });
  const approval = (await db.execute(sql`select status from payment_files where id = ${file.id}`)) as unknown as { rows: { status: string }[] };
  if (!approval.rows[0] || !["approved", "delivered"].includes(approval.rows[0].status)) {
    throw new Error("the generated payment file requires approval before SFTP delivery");
  }
  const backend = backendFor({ backend: svr.rows[0].backend, bucket: svr.rows[0].bucket, rootPrefix: svr.rows[0].root_prefix });
  const path = `outbound/${file.filename}`;
  await backend.write(path, file.content);
  await recordPaymentFileSftpDelivery({ fileId: file.id, orgId, userId, targetRef: `${sftpServerId}:${path}`, response: { path } });
  return { filename: file.filename, path };
}
