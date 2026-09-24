import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { SYSTEM_ACTOR_ID, importStatement, type ParsedStatementLine } from "../banking/banking.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrgReporting,
  type ScratchOrg,
} from "../testing/fixtures.ts";

// The storage backend resolves its data root from the engine env snapshot
// (taken when db.ts first loads), so hand that snapshot a throwaway directory
// before seeding any watch-folder files.
const scratchDataDir = mkdtempSync(join(tmpdir(), "openbooks-sftp-import-job-"));
const { env } = await import("../platform/db.ts");
env.OPENBOOKS_DATA_DIR = scratchDataDir;

const { recordScheduleRunOutcome, runDueSftpImports, sftpImportAuditSource } = await import("./import-job.ts");
const { db, withOrgContext } = await import("../platform/db.ts");

const DB = !!process.env.OPENBOOKS_DB_URL;

const ZERO_UUID = "00000000-0000-0000-0000-000000000000";
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Minimal OFX v1 SGML statement carrying one STMTTRN per fitid (CAD outflows). */
function ofxStatement(fitids: string[]): Buffer {
  const header =
    ["OFXHEADER:100", "DATA:OFXSGML", "VERSION:102", "SECURITY:NONE",
     "ENCODING:USASCII", "CHARSET:1252", "COMPRESSION:NONE", "OLDFILEUID:NONE",
     "NEWFILEUID:NONE", "", ""].join("\r\n");
  const body =
    `<OFX><CURDEF>CAD` +
    fitids.map((id, i) =>
      `<STMTTRN><DTPOSTED>20260715</DTPOSTED><TRNAMT>-${(i + 1) * 10}.50</TRNAMT>` +
      `<NAME>SFTP Vendor ${i}</NAME><FITID>${id}</FITID></STMTTRN>`).join("") +
    `</OFX>`;
  return Buffer.from(header + body, "utf8");
}

interface SftpFixture {
  org: ScratchOrg;
  /** A real user: the trap the scheduler must stop impersonating. */
  authorId: string;
  serverId: string;
  rootPrefix: string;
  authoredScheduleId: string;
  unauthoredScheduleId: string;
}

function localServerDir(rootPrefix: string): string {
  return join(scratchDataDir, "sftp", rootPrefix);
}

function stageFile(rootPrefix: string, folder: string, filename: string, bytes: Buffer): void {
  mkdirSync(join(localServerDir(rootPrefix), folder), { recursive: true });
  writeFileSync(join(localServerDir(rootPrefix), folder, filename), bytes);
}

function listFolder(rootPrefix: string, folder: string): string[] {
  try {
    return readdirSync(join(localServerDir(rootPrefix), folder));
  } catch {
    return [];
  }
}

async function seedSftpFixture(): Promise<SftpFixture> {
  const org = await createScratchOrg();
  const authorId = await createScratchUser(org.orgId, "Schedule Author", "admin");
  await db.execute(sql`
    update accounts
       set reconcilable = true, currency_restriction = 'CAD'
     where id = ${org.accounts.bank} and org_id = ${org.orgId}
  `);
  await db.execute(sql`
    update orgs set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features}',
      coalesce(settings->'features', '{}'::jsonb) || '{"bankFeeds": true}'::jsonb)
     where id = ${org.orgId}
  `);
  const serverId = randomUUID();
  // Local and object storage roots are tenant-bound at the backend boundary;
  // keep the fixture inside this org's namespace while retaining a unique lane.
  const rootPrefix = `sftp/${org.orgId}/sftp-it-${randomUUID()}`;
  // The server row itself names a real creator — attribution metadata that
  // must never leak onto the statements its schedules pull.
  await db.execute(sql`
    insert into sftp_servers (id, org_id, name, username, backend, bucket, root_prefix, is_active, created_by)
    values (${serverId}, ${org.orgId}, 'Scratch SFTP', 'feedbot', 'local', null, ${rootPrefix}, true, ${authorId})
  `);
  // One schedule authored by a real user, one with NO author at all: both are
  // engine-initiated scans and both must land with system provenance.
  const authoredScheduleId = randomUUID();
  await db.execute(sql`
    insert into sftp_import_schedules (id, org_id, sftp_server_id, account_id, format, folder, is_active, created_by)
    values (${authoredScheduleId}, ${org.orgId}, ${serverId}, ${org.accounts.bank}, 'auto', 'inbound', true, ${authorId})
  `);
  const unauthoredScheduleId = randomUUID();
  await db.execute(sql`
    insert into sftp_import_schedules (id, org_id, sftp_server_id, account_id, format, folder, is_active, created_by)
    values (${unauthoredScheduleId}, ${org.orgId}, ${serverId}, ${org.accounts.bank}, 'auto', 'inbound-unauthored', true, null)
  `);
  stageFile(rootPrefix, "inbound", "acct.ofx", ofxStatement(["sftp-deposit-a", "sftp-deposit-b"]));
  stageFile(rootPrefix, "inbound-unauthored", "raw.ofx", ofxStatement(["sftp-noauthor-a"]));
  return { org, authorId, serverId, rootPrefix, authoredScheduleId, unauthoredScheduleId };
}

type ActorRow = {
  bankTransactionId: string;
  statementActor: string | null;
  lineActor: string | null;
  auditActor: string | null;
  requestId: string | null;
};

async function loadScheduledActors(orgId: string, prefix: string): Promise<ActorRow[]> {
  const r = (await db.execute<ActorRow>(sql`
    select bsl.bank_transaction_id as "bankTransactionId",
           bs.created_by as "statementActor",
           bsl.created_by as "lineActor",
           al.actor_id as "auditActor",
           al.request_id as "requestId"
      from bank_statement_lines bsl
      join bank_statements bs on bs.id = bsl.statement_id and bs.org_id = bsl.org_id
      join audit_log al on al.org_id = bs.org_id
        and al.table_name = 'bank_statements' and al.row_id = bs.id
     where bsl.org_id = ${orgId} and bsl.bank_transaction_id like ${prefix}
     order by bsl.bank_transaction_id
  `));
  return r.rows;
}

/** Every actor column touched in the org equals exactly the expected id set. */
async function countForeignActorRows(orgId: string, forbidden: string[]): Promise<number> {
  // A bare JS array binds as a row constructor under Drizzle; bind an explicit
  // Postgres array literal ({a,b}) and cast instead.
  const forbiddenIds = `{${forbidden.join(",")}}`;
  const r = (await db.execute<{ n: number }>(sql`
    select (
      (select count(*) from bank_statements where org_id = ${orgId} and created_by = any(${forbiddenIds}::uuid[])) +
      (select count(*) from bank_statement_lines where org_id = ${orgId} and created_by = any(${forbiddenIds}::uuid[])) +
      (select count(*) from audit_log where org_id = ${orgId} and actor_id = any(${forbiddenIds}::uuid[]))
    )::int as n
  `));
  return Number(r.rows[0]!.n);
}

type LastResultRow = {
  lastRunAt: Date | null;
  lastResult: {
    scheduleId: string;
    filesSeen: number;
    imported: number;
    duplicates: number;
    errors: string[];
    files: { file: string; imported: number; duplicates: number; statementIds: string[]; error?: string }[];
  } | null;
};

async function loadSchedule(id: string): Promise<LastResultRow> {
  const r = (await db.execute<LastResultRow>(sql`
    select last_run_at as "lastRunAt", last_result as "lastResult"
      from sftp_import_schedules where id = ${id}
  `));
  return r.rows[0]!;
}

test(
  "scheduled SFTP imports surface processed-file archival failures",
  { skip: !DB },
  async () => {
    const f = await seedSftpFixture();
    try {
      // A file planted where the archive's day-directory goes makes the local
      // backend's rename fail after the statement transaction has committed
      // (no generation can be created under it). The source must remain
      // visible for a later retry, while the run and its per-file outcome
      // must make the archival failure operator-visible. The blocker sits
      // inside processed/, which the scan skips as a directory — only the
      // archival rename trips over it.
      const day = new Date().toISOString().slice(0, 10);
      mkdirSync(join(localServerDir(f.rootPrefix), "inbound", "processed"), { recursive: true });
      writeFileSync(join(localServerDir(f.rootPrefix), "inbound", "processed", day), Buffer.from("not a directory"));

      const runs = await runDueSftpImports(f.org.orgId);
      const authored = runs.find((run) => run.scheduleId === f.authoredScheduleId)!;
      assert.equal(authored.imported, 2, "the statement import commits before archival is attempted");
      assert.equal(authored.errors.length, 1);
      assert.match(authored.errors[0]!, /^acct\.ofx: /);
      const fileOutcome = authored.files.find((entry) => entry.file === "acct.ofx")!;
      assert.ok(fileOutcome.error, "the file outcome records the archival failure");
      assert.equal(fileOutcome.imported, 2);
      assert.deepEqual(listFolder(f.rootPrefix, "inbound"), ["acct.ofx", "processed"]);
      assert.deepEqual(listFolder(f.rootPrefix, join("inbound", "processed")), [day]);

      const schedule = await loadSchedule(f.authoredScheduleId);
      assert.deepEqual(schedule.lastResult?.errors, authored.errors, "the persisted run retains the archival error");
    } finally {
      await dropScratchOrgReporting(f.org.orgId);
      rmSync(scratchDataDir, { recursive: true, force: true });
    }
  },
);

test(
  "scheduled SFTP imports carry system provenance, never the schedule author or an org uuid",
  { skip: !DB },
  async () => {
    const f = await seedSftpFixture();
    try {
      // Identity hygiene mirrors the API-feed contract: a documented,
      // uuid-shaped engine actor distinct from the zero UUID, any user, or the
      // org id that older code stood in with.
      assert.match(SYSTEM_ACTOR_ID, UUID_SHAPE);
      assert.notEqual(SYSTEM_ACTOR_ID, ZERO_UUID);
      assert.notEqual(SYSTEM_ACTOR_ID, f.authorId);
      assert.notEqual(SYSTEM_ACTOR_ID, f.org.orgId);

      const runs = await runDueSftpImports(f.org.orgId);
      const byId = new Map(runs.map((run) => [run.scheduleId, run]));
      const authored = byId.get(f.authoredScheduleId);
      const unauthored = byId.get(f.unauthoredScheduleId);
      assert.ok(authored && unauthored, "both seeded schedules must be scanned");
      assert.deepEqual(authored.errors, [], `scan errors surfaced: ${JSON.stringify(authored)}`);
      assert.equal(authored.filesSeen, 1);
      assert.equal(authored.imported, 2);
      assert.deepEqual(unauthored.errors, [], "the null-author schedule must import cleanly");
      assert.equal(unauthored.imported, 1);

      const actors = await loadScheduledActors(f.org.orgId, "sftp-%");
      assert.equal(actors.length, 3);
      for (const row of actors) {
        // THE regression: persisted provenance is the documented system actor
        // on every evidence surface — not the historical schedule author and
        // not the organization id standing in for a missing one.
        assert.equal(row.statementActor, SYSTEM_ACTOR_ID, `statement actor for ${row.bankTransactionId}`);
        assert.equal(row.lineActor, SYSTEM_ACTOR_ID, `line actor for ${row.bankTransactionId}`);
        assert.equal(row.auditActor, SYSTEM_ACTOR_ID, `audit actor for ${row.bankTransactionId}`);
      }

      // Durable job marker: each audit row names the exact schedule whose scan
      // imported the file, without ever naming a human.
      const authoredAudit = await db.execute<{ n: number }>(sql`
        select count(*)::int as n from audit_log
         where org_id = ${f.org.orgId} and table_name = 'bank_statements'
           and request_id = ${sftpImportAuditSource(f.authoredScheduleId)}
      `);
      assert.equal(Number(authoredAudit.rows[0]!.n), 1);
      const unauthoredAudit = await db.execute<{ n: number }>(sql`
        select count(*)::int as n from audit_log
         where org_id = ${f.org.orgId} and table_name = 'bank_statements'
           and request_id = ${sftpImportAuditSource(f.unauthoredScheduleId)}
      `);
      assert.equal(Number(unauthoredAudit.rows[0]!.n), 1);

      // No impersonation anywhere in the tenant's financial evidence.
      assert.equal(await countForeignActorRows(f.org.orgId, [f.authorId, f.org.orgId]), 0);

      // Durable run/file provenance: last_result links schedule → run → file →
      // statement ids.
      const schedule = await loadSchedule(f.authoredScheduleId);
      assert.ok(schedule.lastRunAt, "a scanned schedule records last_run_at");
      const result = schedule.lastResult!;
      assert.equal(result.scheduleId, f.authoredScheduleId);
      assert.deepEqual(result.errors, []);
      const fileOutcome = result.files.find((entry) => entry.file === "acct.ofx")!;
      assert.ok(fileOutcome, "the run records the exact source file it saw");
      assert.deepEqual(fileOutcome.error, undefined);
      assert.equal(fileOutcome.imported, 2);
      const statementIds = await db.execute<{ id: string }>(sql`
        select id from bank_statements
         where org_id = ${f.org.orgId} and account_id = ${f.org.accounts.bank}
           and source_file_sha256 is not null
      `);
      assert.ok(fileOutcome.statementIds.length >= 1);
      const persistedIds = new Set(statementIds.rows.map((row) => row.id));
      for (const statementId of fileOutcome.statementIds) {
        assert.ok(persistedIds.has(statementId), `recorded statement ${statementId} exists`);
      }

      // The watch folder archives exactly what was consumed: only the
      // processed/ archive folder remains, holding one dated, content-hashed
      // generation of the consumed file.
      const day = new Date().toISOString().slice(0, 10);
      assert.deepEqual(listFolder(f.rootPrefix, "inbound"), ["processed"]);
      assert.deepEqual(listFolder(f.rootPrefix, join("inbound", "processed")), [day]);
      const generations = listFolder(f.rootPrefix, join("inbound", "processed", day));
      assert.equal(generations.length, 1);
      assert.match(generations[0]!, /^acct\.[0-9a-f]{12}\.ofx$/);

      // Content-hash dedupe unchanged: replaying the exact source bytes under
      // a NEW filename is recognized as already imported — counted as
      // duplicates, no new statement/evidence rows, and the repeat still
      // carries system provenance rather than some other identity.
      const beforeStatements = (await db.execute<{ n: number }>(sql`
        select count(*)::int as n from bank_statements where org_id = ${f.org.orgId}
      `)).rows[0]!.n;
      const replayBytes = ofxStatement(["sftp-deposit-a", "sftp-deposit-b"]);
      assert.deepEqual(replayBytes, readFileSync(join(localServerDir(f.rootPrefix), "inbound/processed", day, generations[0]!)));
      stageFile(f.rootPrefix, "inbound", "acct.ofx", replayBytes);
      const reruns = await runDueSftpImports(f.org.orgId);
      const rerun = reruns.find((run) => run.scheduleId === f.authoredScheduleId)!;
      assert.deepEqual(rerun.errors, []);
      assert.equal(rerun.imported, 0, "replayed exact source bytes import nothing");
      assert.equal(rerun.duplicates, 2, "every replayed line is recognized as a duplicate");
      const afterStatements = (await db.execute<{ n: number }>(sql`
        select count(*)::int as n from bank_statements where org_id = ${f.org.orgId}
      `)).rows[0]!.n;
      assert.equal(afterStatements, beforeStatements);
      assert.equal(await countForeignActorRows(f.org.orgId, [f.authorId, f.org.orgId]), 0);
      // The replay archives as a numbered second generation: the first
      // archive is never replaced, even by identical bytes.
      const generationsAfter = listFolder(f.rootPrefix, join("inbound", "processed", day));
      assert.equal(generationsAfter.length, 2);
      assert.ok(generationsAfter.includes(generations[0]!), "the first generation survives the replay");
      const second = generationsAfter.find((name) => name !== generations[0]!)!;
      assert.match(second, /^acct\.[0-9a-f]{12}\.2\.ofx$/);
      assert.deepEqual(replayBytes, readFileSync(join(localServerDir(f.rootPrefix), "inbound/processed", day, second)));
    } finally {
      await dropScratchOrgReporting(f.org.orgId);
      rmSync(scratchDataDir, { recursive: true, force: true });
    }
  },
);

test(
  "interactive statement import keeps the operator, with no job marker",
  { skip: !DB },
  async () => {
    const f = await seedSftpFixture();
    try {
      const lines: ParsedStatementLine[] = [
        {
          postedOn: "2026-07-14",
          amount: "-45.25",
          description: "Manual upload vendor",
          bankTransactionId: "manual-upload-1",
        },
      ];
      // The shipped upload route builds this context from gate.user.id; drive
      // the identical engine call shape to pin what interactivity means.
      const result = await importStatement(
        {
          accountId: f.org.accounts.bank,
          source: "ofx",
          lines,
          currency: "CAD",
        },
        { orgId: f.org.orgId, userId: f.authorId },
      );
      assert.equal(result.imported, 1);

      const r = (await db.execute<{
        statementActor: string | null;
        lineActor: string | null;
        auditActor: string | null;
        requestId: string | null;
      }>(sql`
        select bs.created_by as "statementActor",
               bsl.created_by as "lineActor",
               al.actor_id as "auditActor",
               al.request_id as "requestId"
          from bank_statement_lines bsl
          join bank_statements bs on bs.id = bsl.statement_id and bs.org_id = bsl.org_id
          join audit_log al on al.org_id = bs.org_id
            and al.table_name = 'bank_statements' and al.row_id = bs.id
         where bsl.org_id = ${f.org.orgId} and bsl.bank_transaction_id = 'manual-upload-1'
      `));
      const row = r.rows[0]!;
      assert.equal(row.statementActor, f.authorId);
      assert.equal(row.lineActor, f.authorId);
      assert.equal(row.auditActor, f.authorId);
      // Interactive evidence names no background job either way round: the
      // marker is reserved for engine-initiated scans.
      assert.equal(row.requestId, null);
      assert.equal(
        await countForeignActorRows(f.org.orgId, [SYSTEM_ACTOR_ID]),
        0,
        "an interactive import must never be attributed to the system actor",
      );
    } finally {
      await dropScratchOrgReporting(f.org.orgId);
      rmSync(scratchDataDir, { recursive: true, force: true });
    }
  },
);

test(
  "scheduled SFTP imports decode non-UTF8 statement bytes like interactive uploads",
  { skip: !DB },
  async () => {
    const f = await seedSftpFixture();
    try {
      // UTF-16LE with BOM and no conflicting encoding declarations — the
      // interactive upload path decodes these exact bytes; the scheduled path
      // must not corrupt them through a lossy UTF-8 string coercion first.
      const utf16 = Buffer.concat([
        Buffer.from([0xff, 0xfe]),
        Buffer.from(
          "<OFX><CURDEF>CAD" +
          "<STMTTRN><DTPOSTED>20260715</DTPOSTED><TRNAMT>-42.50</TRNAMT>" +
          "<NAME>UTF16 Vendor</NAME><FITID>sftp-utf16-a</FITID></STMTTRN>" +
          "</OFX>",
          "utf16le",
        ),
      ]);
      const scheduleId = randomUUID();
      await db.execute(sql`
        insert into sftp_import_schedules (id, org_id, sftp_server_id, account_id, format, folder, is_active, created_by)
        values (${scheduleId}, ${f.org.orgId}, ${f.serverId}, ${f.org.accounts.bank}, 'auto', 'inbound-utf16', true, ${f.authorId})
      `);
      stageFile(f.rootPrefix, "inbound-utf16", "utf16.ofx", utf16);

      const runs = await runDueSftpImports(f.org.orgId);
      const mine = runs.find((run) => run.scheduleId === scheduleId)!;
      assert.ok(mine, "the utf16 schedule must be scanned");
      assert.deepEqual(mine.errors, [], `scan errors surfaced: ${JSON.stringify(mine.errors)}`);
      assert.equal(mine.imported, 1);
      const lines = await db.execute<{ amount: string }>(sql`
        select amount from bank_statement_lines
         where org_id = ${f.org.orgId} and bank_transaction_id = 'sftp-utf16-a'
      `);
      assert.equal(lines.rows.length, 1);
      assert.equal(lines.rows[0]!.amount, "-42.5000");
    } finally {
      await dropScratchOrgReporting(f.org.orgId);
    }
  },
);

test(
  "a failing watch-folder file never starves the files behind it",
  { skip: !DB },
  async () => {
    const f = await seedSftpFixture();
    try {
      // Byte-order first: a persistently unparseable file that sorts ahead
      // of a good one. The scan must record its failure on its own outcome
      // and still attempt every later key.
      stageFile(f.rootPrefix, "inbound", "a-broken.ofx", Buffer.from("not a statement at all"));
      const lateFitid = `sftp-late-${randomUUID()}`;
      stageFile(f.rootPrefix, "inbound", "z-good.ofx", ofxStatement([lateFitid]));

      const runs = await runDueSftpImports(f.org.orgId);
      const authored = runs.find((run) => run.scheduleId === f.authoredScheduleId)!;
      assert.ok(authored, "the authored schedule must be scanned");
      assert.deepEqual(
        authored.files.map((entry) => entry.file).sort(),
        ["a-broken.ofx", "acct.ofx", "z-good.ofx"],
        "every listed key is attempted, including the keys behind the failure",
      );
      const broken = authored.files.find((entry) => entry.file === "a-broken.ofx")!;
      assert.ok(broken.error, "the failing file records its own error");
      assert.equal(broken.imported, 0);
      assert.match(authored.errors.join("\n"), /^a-broken\.ofx: /m);
      const good = authored.files.find((entry) => entry.file === "z-good.ofx")!;
      assert.equal(good.error, undefined);
      assert.equal(good.imported, 1, "the file behind the failure is still attempted and imported");
      assert.equal(authored.files.find((entry) => entry.file === "acct.ofx")!.imported, 2);
      const lines = await db.execute<{ n: number }>(sql`
        select count(*)::int as n from bank_statement_lines
         where org_id = ${f.org.orgId} and bank_transaction_id = ${lateFitid}
      `);
      assert.equal(lines.rows[0]!.n, 1);
      // The failure stays in the folder for a later retry; the import moves on.
      assert.ok(listFolder(f.rootPrefix, "inbound").includes("a-broken.ofx"));
      assert.ok(!listFolder(f.rootPrefix, "inbound").includes("z-good.ofx"));
    } finally {
      await dropScratchOrgReporting(f.org.orgId);
      rmSync(scratchDataDir, { recursive: true, force: true });
    }
  },
);

test(
  "a schedule deleted mid-scan keeps its run evidence in audit and names it in the result",
  { skip: !DB },
  async () => {
    const f = await seedSftpFixture();
    try {
      const run = {
        scheduleId: f.authoredScheduleId,
        filesSeen: 1,
        imported: 2,
        duplicates: 0,
        errors: [] as string[],
        files: [{
          file: "acct.ofx",
          imported: 2,
          duplicates: 0,
          statementIds: ["00000000-0000-4000-8000-000000000010"],
        }],
      };
      // The schedule row still exists: the outcome lands on last_result,
      // the returned run is untouched, and no audit row is written.
      const recorded = await withOrgContext(f.org.orgId, () =>
        recordScheduleRunOutcome({ id: f.authoredScheduleId, org_id: f.org.orgId }, run));
      assert.deepEqual(recorded.errors, []);
      assert.equal((await loadSchedule(f.authoredScheduleId)).lastResult?.imported, 2);

      // Deleted mid-scan: zero matched rows. The evidence must survive in
      // audit and the returned run must say so by name — never a phantom
      // clean scan while the evidence is silently dropped.
      await db.execute(sql`delete from sftp_import_schedules where id = ${f.authoredScheduleId}`);
      const orphaned = await withOrgContext(f.org.orgId, () =>
        recordScheduleRunOutcome({ id: f.authoredScheduleId, org_id: f.org.orgId }, run));
      assert.equal(orphaned.errors.length, 1);
      assert.match(orphaned.errors[0]!, /was deleted during the scan/);
      assert.match(orphaned.errors[0]!, /last_result was not recorded/);
      const audit = (await db.execute<{ action: string; changes: typeof run; request: string | null }>(sql`
        select action, changes, request_id as request from audit_log
         where org_id = ${f.org.orgId} and table_name = 'sftp_import_schedules' and row_id = ${f.authoredScheduleId}
      `)).rows;
      assert.equal(audit.length, 1);
      assert.equal(audit[0]!.action, "scan_outcome_unrecorded");
      assert.deepEqual(audit[0]!.changes, run);
      assert.equal(audit[0]!.request, sftpImportAuditSource(f.authoredScheduleId));
    } finally {
      await dropScratchOrgReporting(f.org.orgId);
      rmSync(scratchDataDir, { recursive: true, force: true });
    }
  },
);
