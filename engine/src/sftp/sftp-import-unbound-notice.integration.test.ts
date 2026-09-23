import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import test, { before } from "node:test";
import { sql } from "drizzle-orm";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrgReporting,
} from "../testing/fixtures.ts";

// Own data root (separate lane from the other sftp suites): the local
// backend resolves its root from the engine env snapshot at first load.
const scratchDataDir = mkdtempSync(join(tmpdir(), "openbooks-sftp-unbound-notice-"));
const { env } = await import("../platform/db.ts");
env.OPENBOOKS_DATA_DIR = scratchDataDir;

const { runDueSftpImports } = await import("./import-job.ts");
const {
  SFTP_UNBOUND_SCHEDULE_NOTICE_KIND,
  sftpUnboundScheduleNoticeHref,
} = await import("./schedule-notice.ts");
const { db, withBypass, withOrgContext } = await import("../platform/db.ts");

const DB = !!process.env.OPENBOOKS_DB_URL;

before(async () => {
  if (!DB) return;
  const client = await (await import("../platform/db.ts")).pool.connect();
  try {
    const { readFileSync } = await import("node:fs");
    await client.query(readFileSync("schema/migrations/generated/0291_sftp_import_schedule_expected_account.sql", "utf8"));
  } finally {
    client.release();
  }
});

/** OFX v1 SGML statement carrying one STMTTRN per fitid, optionally identified. */
function ofxStatement(fitids: string[], acctId?: string): Buffer {
  const header =
    ["OFXHEADER:100", "DATA:OFXSGML", "VERSION:102", "SECURITY:NONE",
     "ENCODING:USASCII", "CHARSET:1252", "COMPRESSION:NONE", "OLDFILEUID:NONE",
     "NEWFILEUID:NONE", "", ""].join("\r\n");
  const acct = acctId ? `<BANKACCTFROM><BANKID>001</BANKID><ACCTID>${acctId}</ACCTID></BANKACCTFROM>` : "";
  const body =
    `<OFX>${acct}<CURDEF>CAD` +
    fitids.map((id, i) =>
      `<STMTTRN><DTPOSTED>20260715</DTPOSTED><TRNAMT>-${(i + 1) * 10}.50</TRNAMT>` +
      `<NAME>Notice Vendor ${i}</NAME><FITID>${id}</FITID></STMTTRN>`).join("") +
    `</OFX>`;
  return Buffer.from(header + body, "utf8");
}

interface NoticeFixture {
  orgId: string;
  authorId: string;
  rootPrefix: string;
  ofxScheduleId: string;
  csvScheduleId: string;
}

function stageFile(rootPrefix: string, folder: string, filename: string, bytes: Buffer): void {
  mkdirSync(join(scratchDataDir, "sftp", rootPrefix, folder), { recursive: true });
  writeFileSync(join(scratchDataDir, "sftp", rootPrefix, folder, filename), bytes);
}

async function seedNoticeFixture(): Promise<NoticeFixture> {
  const leased = await withBypass(async () => {
    const org = await createScratchOrg();
    const authorId = await createScratchUser(org.orgId, "Notice Admin", "admin");
    return { org, authorId };
  });
  const { org, authorId } = leased;
  await withOrgContext(org.orgId, async () => {
    await db.execute(sql`
      update accounts set reconcilable = true, currency_restriction = 'CAD'
       where id = ${org.accounts.bank} and org_id = ${org.orgId}
    `);
    await db.execute(sql`
      update orgs set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features}',
        coalesce(settings->'features', '{}'::jsonb) || '{"bankFeeds": true}'::jsonb)
       where id = ${org.orgId}
    `);
  });
  const serverId = randomUUID();
  const rootPrefix = `sftp/${org.orgId}/notice-${randomUUID()}`;
  const ofxScheduleId = randomUUID();
  const csvScheduleId = randomUUID();
  await withOrgContext(org.orgId, async () => {
    await db.execute(sql`
      insert into sftp_servers (id, org_id, name, username, backend, bucket, root_prefix, is_active, created_by)
      values (${serverId}, ${org.orgId}, 'Notice SFTP', ${`notice-${serverId.slice(0, 8)}`}, 'local', null, ${rootPrefix}, true, ${authorId})
    `);
    // Both schedules predate the binding column: NULL expected account.
    await db.execute(sql`
      insert into sftp_import_schedules (id, org_id, sftp_server_id, account_id, format, folder, is_active, created_by)
      values (${ofxScheduleId}, ${org.orgId}, ${serverId}, ${org.accounts.bank}, 'ofx', 'inbound-ofx', true, ${authorId})
    `);
    await db.execute(sql`
      insert into sftp_import_schedules (id, org_id, sftp_server_id, account_id, format, folder, csv_mapping, is_active, created_by)
      values (${csvScheduleId}, ${org.orgId}, ${serverId}, ${org.accounts.bank}, 'csv', 'inbound-csv',
              '{"date": 0, "amount": 1, "description": 2, "bankTransactionId": 3}'::jsonb, true, ${authorId})
    `);
  });
  // An identified OFX statement (refuses while unbound) and a CSV statement
  // (no identifier — imports on folder isolation even while unbound).
  stageFile(rootPrefix, "inbound-ofx", "identified.ofx", ofxStatement(["notice-identified-1"], "BR001-77"));
  stageFile(
    rootPrefix, "inbound-csv", "plain.csv",
    Buffer.from("2026-07-15,-10.50,Notice CSV Vendor,notice-csv-1\n", "utf8"),
  );
  return { orgId: org.orgId, authorId, rootPrefix, ofxScheduleId, csvScheduleId };
}

type NoticeRow = { title: string; body: string | null; href: string | null; read_at: string | null };

async function unreadNotices(orgId: string, userId: string): Promise<NoticeRow[]> {
  return withOrgContext(orgId, async () =>
    (await db.execute<NoticeRow>(sql`
      select title, body, href, read_at::text as read_at from notifications
       where org_id = ${orgId} and user_id = ${userId}
         and kind = ${SFTP_UNBOUND_SCHEDULE_NOTICE_KIND} and read_at is null
       order by created_at
    `)).rows,
  );
}

async function lineCount(orgId: string): Promise<number> {
  return withOrgContext(orgId, async () =>
    (await db.execute<{ n: number }>(sql`select count(*)::int as n from bank_statement_lines where org_id = ${orgId}`)).rows[0]!.n,
  );
}

test("an unbound schedule raises one named notice, and binding lets the next run import", { skip: !DB }, async () => {
  const fixture = await seedNoticeFixture();
  try {
    const before = await lineCount(fixture.orgId);
    const runs = await withBypass(() => runDueSftpImports(fixture.orgId));
    const ofx = runs.find((r) => r.scheduleId === fixture.ofxScheduleId)!;
    const csv = runs.find((r) => r.scheduleId === fixture.csvScheduleId)!;

    // RED before the fix: the identified file refused per file with no
    // schedule-level surfacing anywhere — no notice, no named state.
    const identified = ofx.files.find((f) => f.file === "identified.ofx")!;
    assert.equal(identified.imported, 0, "the identified file must refuse while unbound");
    assert.match(identified.error ?? "", /no expected account configured/);

    // The named attention item: schedule, remedy, and the exact setting.
    const notices = await unreadNotices(fixture.orgId, fixture.authorId);
    assert.equal(notices.length, 1, "exactly one unread notice for the unbound OFX schedule");
    assert.match(notices[0]!.title, /inbound-ofx/);
    assert.match(notices[0]!.body ?? "", /Company Settings → Bank Feeds/);
    assert.equal(notices[0]!.href, sftpUnboundScheduleNoticeHref(fixture.ofxScheduleId));

    // The healthy unbound CSV route stays silent: it imports on folder
    // isolation, so a "paused" claim about it would be false.
    const plain = csv.files.find((f) => f.file === "plain.csv")!;
    assert.equal(plain.imported, 1, "the identifier-less CSV imports while unbound");
    assert.equal(
      (await unreadNotices(fixture.orgId, fixture.authorId)).filter((n) => (n.href ?? "").includes(fixture.csvScheduleId)).length,
      0,
      "no notice names the healthy CSV schedule",
    );

    // Nothing imported unverified: only the CSV line landed.
    assert.equal((await lineCount(fixture.orgId)) - before, 1);

    // A second pass changes nothing: the tick never spams.
    await withBypass(() => runDueSftpImports(fixture.orgId));
    assert.equal((await unreadNotices(fixture.orgId, fixture.authorId)).length, 1);

    // After binding, the next run imports the refused file and raises
    // nothing new.
    await withOrgContext(fixture.orgId, async () => {
      await db.execute(sql`
        update sftp_import_schedules set expected_external_account_id = 'BR001-77'
         where id = ${fixture.ofxScheduleId} and org_id = ${fixture.orgId}
      `);
    });
    const reruns = await withBypass(() => runDueSftpImports(fixture.orgId));
    const ofxRerun = reruns.find((r) => r.scheduleId === fixture.ofxScheduleId)!;
    assert.equal(ofxRerun.files.find((f) => f.file === "identified.ofx")!.imported, 1);
    assert.equal((await unreadNotices(fixture.orgId, fixture.authorId)).length, 1);
  } finally {
    await withBypass(() => dropScratchOrgReporting(fixture.orgId));
  }
});

test.after(() => {
  rmSync(scratchDataDir, { recursive: true, force: true });
});
