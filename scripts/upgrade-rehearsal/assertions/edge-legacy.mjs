#!/usr/bin/env node
/**
 * Post-upgrade legacy assertions for the edge-legacy dataset (P1B.11).
 *
 * Runs on the CANDIDATE runtime after the upgrade (rehearse.mjs runs it via
 * `npx tsx` with the repo root as cwd). Environment:
 *
 *   OPENBOOKS_DB_URL     the upgraded install
 *   UPGRADE_SEEDED_ORGS  JSON array of seeded org ids
 *
 * Prints {"assertions": [{"name", "ok", "detail"?}]} as its last JSON line
 * and exits 0. Any failed check refuses the rehearsal by name.
 *
 * (a) The executed lien waiver renamed after signing (EDGE-W-1) is frozen
 *     or refused as unverifiable legacy — never re-rendered from live rows.
 * (b) The active unbound SFTP schedule is paused with a named notice after
 *     one scheduler tick — never auto-assigned, never misattributed.
 * (c) Every reconstructed-history row (0274/0292/0297/0298) appears in
 *     upgrade_legacy_provenance with its verbatim note (pinned against
 *     0326's bytes).
 * (d) Posted stock-count history is intact, no draft count is left empty,
 *     and the grandfathered notice rows are recorded under 0293/0299.
 */
import pg from "pg";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..", "..");

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok: ok === true, ...(detail ? { detail } : {}) });
  console.log(`${ok === true ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

async function main() {
  const dbUrl = requireEnv("OPENBOOKS_DB_URL");
  const seededOrgs = JSON.parse(requireEnv("UPGRADE_SEEDED_ORGS"));
  const client = new pg.Client({ connectionString: dbUrl });
  await client.connect();
  try {
    await checkWaiverFrozenOrLegacy(client, seededOrgs);
    await checkUnboundSchedulePaused(client, seededOrgs);
    await checkReconstructedHistoryProvenance(client, seededOrgs);
    await checkPostedCountsIntact(client, seededOrgs);
  } finally {
    await client.end();
  }
  console.log(JSON.stringify({ assertions: checks }));
}

/**
 * (a) EDGE-W-1 was signed, then its vendor and project were renamed. 0292
 * adds executed_snapshot with no backfill, so the row must still carry no
 * frozen image — and because the live rows drifted, the candidate runtime
 * must present it as legacy-unverified (the derived predicate in
 * web/lib/compliance.ts isLegacyExecutedLienWaiver: signed with no
 * snapshot, or void with a signing instant). Any snapshot present would be
 * live rows laundered as executed truth.
 */
async function checkWaiverFrozenOrLegacy(client, seededOrgs) {
  const { rows } = await client.query(
    `select w.id, w.status, w.signed_at,
            (w.executed_snapshot is not null) as has_snapshot,
            p.display_name as vendor, j.name as project
       from public.lien_waivers w
       join public.parties p on p.id = w.party_id
       join public.projects j on j.id = w.project_id
      where w.org_id = any($1) and w.waiver_number = 'EDGE-W-1'`,
    [seededOrgs],
  );
  if (rows.length !== 1) {
    check("waiver-frozen-or-legacy", false, `EDGE-W-1: found ${rows.length} rows, want exactly 1`);
    return;
  }
  const w = rows[0];
  const problems = [];
  if (w.status !== "signed") problems.push(`status is ${w.status}, want signed`);
  if (w.has_snapshot) problems.push("executed_snapshot is set: no backfill may invent signed-time truth");
  if (w.vendor !== "EDGE Vendor Renamed") problems.push(`vendor reads ${JSON.stringify(w.vendor)}: live rows drifted, so only the legacy branch is safe`);
  if (w.project !== "EDGE Tower Renamed") problems.push(`project reads ${JSON.stringify(w.project)}: live rows drifted, so only the legacy branch is safe`);
  const legacy = (!w.has_snapshot && w.status === "signed") || (w.status === "void" && w.signed_at !== null);
  if (!legacy) problems.push("row is outside the legacy-unverified predicate yet has no frozen image: it would re-render from live rows as executed");
  check("waiver-frozen-or-legacy", problems.length === 0, problems.join("; ") || "EDGE-W-1 signed, snapshot NULL, renamed live rows, inside the legacy predicate");
}

/**
 * (b) The EDGE schedule is active with no bound account. Predicate owned by
 * m73: is_active, format <> 'csv', expected_external_account_id IS NULL, on
 * an active same-org server in a production bankFeeds-on org. There is no
 * stored paused flag — "paused" is the derived badge plus the named house
 * notice the scheduler raises. The tick runs here (the harness runs none),
 * with one identified file staged for a FOREIGN account: it must refuse by
 * name instead of becoming this account's lines, the binding must stay
 * NULL, and the notice must name the schedule's setting.
 */
async function checkUnboundSchedulePaused(client, seededOrgs) {
  const { rows } = await client.query(
    `select sc.id, sc.org_id, sc.format, sc.folder,
            sc.expected_external_account_id as binding,
            sv.name as server_name, sv.backend, sv.root_prefix
       from public.sftp_import_schedules sc
       join public.sftp_servers sv
         on sv.id = sc.sftp_server_id and sv.org_id = sc.org_id and sv.is_active
       join public.orgs o on o.id = sc.org_id
      where sc.org_id = any($1)
        and sc.is_active and sc.format <> 'csv'
        and sc.expected_external_account_id is null
        and sv.name = 'EDGE bank'
        and o.env_kind = 'production'
        and coalesce((o.settings->'features'->>'bankFeeds')::boolean, false)`,
    [seededOrgs],
  );
  if (rows.length !== 1) {
    check("unbound-schedule-paused", false, `in-scope EDGE schedule rows: ${rows.length}, want exactly 1`);
    return;
  }
  const s = rows[0];
  if (s.backend !== "local") {
    check("unbound-schedule-paused", false, `EDGE server backend is ${s.backend}, want local (a rehearsal has no S3)`);
    return;
  }

  // Scratch data root, set before the engine loads (the local backend
  // resolves its root from the engine env snapshot at first load).
  const dataDir = mkdtempSync(join(tmpdir(), "edge-legacy-sftp-"));
  process.env.OPENBOOKS_DATA_DIR = dataDir;
  const engineUrl = (path) => pathToFileURL(join(ROOT, "engine", "src", ...path)).href;
  const { runDueSftpImports } = await import(engineUrl(["sftp", "import-job.ts"]));
  const { SFTP_UNBOUND_SCHEDULE_NOTICE_KIND, sftpUnboundScheduleNoticeHref } = await import(
    engineUrl(["sftp", "schedule-notice.ts"])
  );

  // One identified statement for a FOREIGN account: OFX SGML shaped like
  // m73's own notice fixture (engine/src/sftp/sftp-import-unbound-notice...),
  // so it parses and reaches the identity gate instead of a parse error.
  const header = ["OFXHEADER:100", "DATA:OFXSGML", "VERSION:102", "SECURITY:NONE",
    "ENCODING:USASCII", "CHARSET:1252", "COMPRESSION:NONE", "OLDFILEUID:NONE",
    "NEWFILEUID:NONE", "", ""].join("\r\n");
  const body = `<OFX><BANKACCTFROM><BANKID>001</BANKID><ACCTID>EDGE-FOREIGN-1</ACCTID></BANKACCTFROM><CURDEF>USD` +
    `<STMTTRN><DTPOSTED>20260115</DTPOSTED><TRNAMT>-10.50</TRNAMT><NAME>Edge Vendor</NAME>` +
    `<FITID>edge-foreign-1</FITID></STMTTRN></OFX>`;
  const folder = join(dataDir, "sftp", s.root_prefix, s.folder);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "EDGE-unbound.ofx"), Buffer.from(header + body, "utf8"));

  const before = await client.query(
    "select count(*)::int as n from public.bank_statements where org_id = $1",
    [s.org_id],
  );
  const runs = await runDueSftpImports(s.org_id);
  const run = runs.find((r) => r.scheduleId === s.id);

  const problems = [];
  if (!run) problems.push("scheduler tick produced no run for the EDGE schedule");
  else {
    if (run.filesSeen < 1) problems.push(`tick saw ${run.filesSeen} files, want the staged one`);
    if (run.imported !== 0) problems.push(`tick imported ${run.imported} statement(s) from an unbound schedule`);
    if (!run.errors.some((e) => /no expected account configured/i.test(e))) {
      problems.push(`tick errors do not name the missing binding: ${JSON.stringify(run.errors)}`);
    }
  }
  const after = await client.query(
    `select sc.expected_external_account_id as binding, sc.is_active
       from public.sftp_import_schedules sc where sc.id = $1`,
    [s.id],
  );
  if (after.rows[0]?.binding !== null) problems.push("binding was assigned by the tick: accounts are never auto-assigned");
  if (after.rows[0]?.is_active !== true) problems.push("schedule was deactivated by the tick: the operator's is_active is never rewritten");
  const statements = await client.query(
    "select count(*)::int as n from public.bank_statements where org_id = $1",
    [s.org_id],
  );
  if (statements.rows[0].n !== before.rows[0].n) {
    problems.push(`bank_statements grew ${before.rows[0].n} -> ${statements.rows[0].n}: the foreign statement was misattributed`);
  }
  const href = sftpUnboundScheduleNoticeHref(s.id);
  const notices = await client.query(
    `select count(*)::int as n from public.notifications
      where org_id = $1 and kind = $2 and href = $3 and read_at is null`,
    [s.org_id, SFTP_UNBOUND_SCHEDULE_NOTICE_KIND, href],
  );
  if (notices.rows[0].n < 1) {
    problems.push(`no unread ${SFTP_UNBOUND_SCHEDULE_NOTICE_KIND} notice at ${href} after the tick`);
  }
  check("unbound-schedule-paused", problems.length === 0, problems.join("; ") || "tick refused the foreign statement by name, binding stayed NULL, notice raised");
}

/**
 * (c) Every reconstructed-history row appears in upgrade_legacy_provenance
 * with its verbatim note. Table, key columns, and note texts are pinned
 * against 0326_upgrade_legacy_provenance.sql: readers key off
 * (org, migration, table, row) membership, and the column comment names
 * release-lane assertions as the verbatim matchers of note text.
 */
const PROVENANCE_NOTES = {
  "0274_retention_action_completion_snapshot":
    "retention action inherited from the live schedule; governing action at completion unrecorded — unverified legacy",
  "0292_lien_waiver_executed_snapshot":
    "executed before execution snapshots existed; print image not frozen at signing — unverified legacy",
  "0297_recognition_rule_versions":
    "rule predates versioning; pre-upgrade policy edits were made in place so the pinned row may not be the policy its obligations were built under — unverified legacy",
  "0298_item_rate_version_profile_pins":
    "rate pin backfilled from the live profile; governing policy at version time unrecorded — unverified legacy",
  "0293_stock_count_line_subject_unique":
    "duplicate subject posted before the 0293 guard; double-posted variance stands — grandfathered legacy",
  "0299_stock_count_line_counted_nonnegative":
    "negative count posted before the 0299 guard; phantom variance stands — grandfathered legacy",
};

/**
 * Provenance rows, or null when the registry itself is absent (0326 not yet
 * applied: the checks below refuse by name instead of crashing without JSON).
 */
async function provenanceRow(client, orgIds, migration, table, rowId) {
  try {
    const { rows } = await client.query(
      `select note from public.upgrade_legacy_provenance
        where org_id = any($1) and migration = $2 and table_name = $3 and row_id = $4`,
      [orgIds, migration, table, rowId],
    );
    return rows;
  } catch (error) {
    if (error?.code === "42P01") return null;
    throw error;
  }
}

async function checkReconstructedHistoryProvenance(client, seededOrgs) {
  const problems = [];
  const want = async (label, migration, table, rowId) => {
    if (!rowId) {
      problems.push(`${label}: shape row not found, cannot check its provenance row`);
      return;
    }
    const rows = await provenanceRow(client, seededOrgs, migration, table, rowId);
    if (rows === null) {
      problems.push(`${label}: upgrade_legacy_provenance is absent — 0326 has not applied, cannot verify`);
    } else if (rows.length !== 1) {
      problems.push(`${label}: ${rows.length} provenance row(s) for (${migration}, ${table}, ${rowId}), want exactly 1`);
    } else if (rows[0].note !== PROVENANCE_NOTES[migration]) {
      problems.push(`${label}: provenance note is not verbatim 0326: ${JSON.stringify(rows[0].note)}`);
    }
  };
  const doc = await client.query(
    `select id from public.hrm_documents where org_id = any($1) and title = 'EDGE file'`,
    [seededOrgs],
  );
  await want("0274/EDGE file", "0274_retention_action_completion_snapshot", "hrm_documents", doc.rows[0]?.id);
  const waiver = await client.query(
    `select id from public.lien_waivers where org_id = any($1) and waiver_number = 'EDGE-W-1'`,
    [seededOrgs],
  );
  await want("0292/EDGE-W-1", "0292_lien_waiver_executed_snapshot", "lien_waivers", waiver.rows[0]?.id);
  const rule = await client.query(
    `select id from public.recognition_rules where org_id = any($1) and code = 'EDGE-RR'`,
    [seededOrgs],
  );
  await want("0297/EDGE-RR", "0297_recognition_rule_versions", "recognition_rules", rule.rows[0]?.id);
  const pin = await client.query(
    `select p.id from public.item_rate_version_profiles p
       join public.item_rate_versions v on v.org_id = p.org_id and v.id = p.version_id
       join public.item_rate_books b on b.org_id = v.org_id and b.id = v.rate_book_id
       join public.items i on i.org_id = p.org_id and i.id = p.item_id
      where p.org_id = any($1) and b.code = 'EDGE-RB' and i.name = 'EDGE rate item'`,
    [seededOrgs],
  );
  if (pin.rows.length !== 1) {
    problems.push(`0298/EDGE pin: found ${pin.rows.length} pin row(s), want exactly 1`);
  } else {
    await want("0298/EDGE pin", "0298_item_rate_version_profile_pins", "item_rate_version_profiles", pin.rows[0].id);
  }
  check("reconstructed-history-provenance", problems.length === 0, problems.join("; ") || "0274/0292/0297/0298 rows recorded with verbatim 0326 notes");
}

/**
 * (d, data half) The grandfathered posted count survives the upgrade with
 * every line, and no draft/review count is left empty (the 0299 remedy's
 * fixed bug class: two DELETEs that stranded empty counts).
 */
async function checkPostedCountsIntact(client, seededOrgs) {
  const problems = [];
  const { rows: posted } = await client.query(
    `select id, status from public.stock_counts
      where org_id = any($1) and memo = 'EDGE posted'`,
    [seededOrgs],
  );
  if (posted.length !== 1 || posted[0].status !== "posted") {
    problems.push(`EDGE posted count: found ${posted.length} row(s), want one posted`);
  } else {
    const lines = await client.query(
      `select counted_quantity, expected_quantity
         from public.stock_count_lines
        where org_id = any($1) and stock_count_id = $2
        order by counted_quantity`,
      [seededOrgs, posted[0].id],
    );
    // Numeric comparison: numeric columns report scale (9.0000), so compare
    // by value, never by text.
    const counted = lines.rows.map((l) => Number(l.counted_quantity)).join(",");
    if (counted !== "-5,9,9") problems.push(`EDGE posted lines counted [${counted}], want [-5,9,9]: posted history is immutable`);
    if (!lines.rows.every((l) => Number(l.expected_quantity) === 10)) {
      problems.push("EDGE posted expected quantities moved");
    }
  }
  const empty = await client.query(
    `select count(*)::int as n from public.stock_counts c
      where c.org_id = any($1) and c.status is distinct from 'posted'
        and not exists (select 1 from public.stock_count_lines l
                         where l.org_id = c.org_id and l.stock_count_id = c.id)`,
    [seededOrgs],
  );
  if (empty.rows[0].n !== 0) problems.push(`${empty.rows[0].n} draft/review count(s) left with no lines`);
  // (d, recorded half) Every EDGE posted line stands grandfathered: all
  // three share one subject so all three record under 0293, and the
  // negative line records under 0299 too.
  if (posted.length === 1 && posted[0].status === "posted") {
    const lines = await client.query(
      `select id, counted_quantity from public.stock_count_lines
        where org_id = any($1) and stock_count_id = $2`,
      [seededOrgs, posted[0].id],
    );
    for (const line of lines.rows) {
      const rows293 = await provenanceRow(client, seededOrgs,
        "0293_stock_count_line_subject_unique", "stock_count_lines", line.id);
      if (rows293 === null) {
        problems.push(`posted line ${line.id}: upgrade_legacy_provenance is absent — 0326 has not applied`);
      } else if (rows293.length !== 1 || rows293[0].note !== PROVENANCE_NOTES["0293_stock_count_line_subject_unique"]) {
        problems.push(`posted line ${line.id}: 0293 grandfathered row missing or note not verbatim`);
      }
      if (Number(line.counted_quantity) < 0) {
        const rows299 = await provenanceRow(client, seededOrgs,
          "0299_stock_count_line_counted_nonnegative", "stock_count_lines", line.id);
        if (rows299 === null) {
          problems.push(`posted line ${line.id}: upgrade_legacy_provenance is absent — 0326 has not applied`);
        } else if (rows299.length !== 1 || rows299[0].note !== PROVENANCE_NOTES["0299_stock_count_line_counted_nonnegative"]) {
          problems.push(`posted line ${line.id}: 0299 grandfathered row missing or note not verbatim`);
        }
      }
    }
  }
  check("posted-counts-intact", problems.length === 0, problems.join("; ") || "EDGE posted keeps 3 lines (-5,9,9); no empty draft counts; grandfathered rows recorded");
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exit(1);
  },
);
