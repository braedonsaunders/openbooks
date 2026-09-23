import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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

// Own data root (separate lane from the import-job suite): the local
// backend resolves its root from the engine env snapshot at first load.
const scratchDataDir = mkdtempSync(join(tmpdir(), "openbooks-sftp-acct-binding-"));
const { env } = await import("../platform/db.ts");
env.OPENBOOKS_DATA_DIR = scratchDataDir;

const { runDueSftpImports } = await import("./import-job.ts");
const { db, pool, withBypass, withOrgContext } = await import("../platform/db.ts");

const DB = !!process.env.OPENBOOKS_DB_URL;

before(async () => {
  if (!DB) return;
  const client = await pool.connect();
  try {
    const { readFileSync } = await import("node:fs");
    await client.query(readFileSync("schema/migrations/generated/0291_sftp_import_schedule_expected_account.sql", "utf8"));
  } finally {
    client.release();
  }
});

/** OFX v1 SGML statement, optionally carrying a BANKACCTFROM/ACCTID. */
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
      `<NAME>Binding Vendor ${i}</NAME><FITID>${id}</FITID></STMTTRN>`).join("") +
    `</OFX>`;
  return Buffer.from(header + body, "utf8");
}

interface BindingFixture {
  orgId: string;
  rootPrefix: string;
  boundScheduleId: string;
  unboundScheduleId: string;
}

function stageFile(rootPrefix: string, folder: string, filename: string, bytes: Buffer): void {
  mkdirSync(join(scratchDataDir, "sftp", rootPrefix, folder), { recursive: true });
  writeFileSync(join(scratchDataDir, "sftp", rootPrefix, folder, filename), bytes);
}

function listFolder(rootPrefix: string, folder: string): string[] {
  try {
    return readdirSync(join(scratchDataDir, "sftp", rootPrefix, folder));
  } catch {
    return [];
  }
}

async function seedBindingFixture(): Promise<BindingFixture> {
  const leased = await withBypass(async () => {
    const org = await createScratchOrg();
    const authorId = await createScratchUser(org.orgId, "Binding Admin", "admin");
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
  const rootPrefix = `sftp/${org.orgId}/binding-${randomUUID()}`;
  const boundScheduleId = randomUUID();
  const unboundScheduleId = randomUUID();
  await withOrgContext(org.orgId, async () => {
    await db.execute(sql`
      insert into sftp_servers (id, org_id, name, username, backend, bucket, root_prefix, is_active, created_by)
      values (${serverId}, ${org.orgId}, 'Binding SFTP', ${`binding-${serverId.slice(0, 8)}`}, 'local', null, ${rootPrefix}, true, ${authorId})
    `);
    // Same server, same account, different folders: only the binding tells
    // the folders apart. The bound schedule stores a spaced/lowercase
    // spelling to prove comparison is canonical, not string-equal.
    await db.execute(sql`
      insert into sftp_import_schedules (id, org_id, sftp_server_id, account_id, format, folder, is_active, expected_external_account_id, created_by)
      values (${boundScheduleId}, ${org.orgId}, ${serverId}, ${org.accounts.bank}, 'ofx', 'inbound-a', true, 'br 001-77', ${authorId})
    `);
    await db.execute(sql`
      insert into sftp_import_schedules (id, org_id, sftp_server_id, account_id, format, folder, is_active, created_by)
      values (${unboundScheduleId}, ${org.orgId}, ${serverId}, ${org.accounts.bank}, 'ofx', 'inbound-b', true, ${authorId})
    `);
  });
  // A same-currency statement for account B dropped in account A's folder:
  // the defect filed it as A's lines. The stranger must refuse instead.
  stageFile(rootPrefix, "inbound-a", "own.ofx", ofxStatement(["bind-own-1"], "BR001-77"));
  stageFile(rootPrefix, "inbound-a", "stranger.ofx", ofxStatement(["bind-stranger-1"], "OTHER-99"));
  // Unbound schedule: an identified file pauses with the binding remedy,
  // while an identifier-less file imports on folder isolation.
  stageFile(rootPrefix, "inbound-b", "identified.ofx", ofxStatement(["bind-unbound-1"], "BR001-77"));
  stageFile(rootPrefix, "inbound-b", "plain.ofx", ofxStatement(["bind-plain-1"]));
  return { orgId: org.orgId, rootPrefix, boundScheduleId, unboundScheduleId };
}

async function lineCount(orgId: string): Promise<number> {
  return withOrgContext(orgId, async () =>
    (await db.execute<{ n: number }>(sql`select count(*)::int as n from bank_statement_lines where org_id = ${orgId}`)).rows[0]!.n,
  );
}

test("account identity gates the scheduled import end to end", { skip: !DB }, async () => {
  const fixture = await seedBindingFixture();
  try {
    const before = await lineCount(fixture.orgId);
    const runs = await withBypass(() => runDueSftpImports(fixture.orgId));
    const bound = runs.find((r) => r.scheduleId === fixture.boundScheduleId)!;
    const unbound = runs.find((r) => r.scheduleId === fixture.unboundScheduleId)!;

    // RED before the fix: both folders imported every file into the
    // schedule's account with no comparison — the stranger's lines became
    // A's evidence and the unbound identified file imported silently.
    const own = bound.files.find((f) => f.file === "own.ofx")!;
    assert.equal(own.imported, 1, "the bound account's own file must import");
    const stranger = bound.files.find((f) => f.file === "stranger.ofx")!;
    assert.equal(stranger.imported, 0);
    assert.match(stranger.error ?? "", /OTHER-99/);
    assert.match(stranger.error ?? "", /br 001-77/i);

    const identified = unbound.files.find((f) => f.file === "identified.ofx")!;
    assert.equal(identified.imported, 0);
    assert.match(identified.error ?? "", /no expected account configured/);
    const plain = unbound.files.find((f) => f.file === "plain.ofx")!;
    assert.equal(plain.imported, 1, "an identifier-less file imports on folder isolation");

    // Refused files stay in the folder (never archived as processed);
    // imported ones move into dated, content-hashed processed generations.
    const day = new Date().toISOString().slice(0, 10);
    assert.deepEqual(listFolder(fixture.rootPrefix, "inbound-a").sort(), ["processed", "stranger.ofx"]);
    assert.deepEqual(listFolder(fixture.rootPrefix, join("inbound-a", "processed")), [day]);
    const ownGenerations = listFolder(fixture.rootPrefix, join("inbound-a", "processed", day));
    assert.equal(ownGenerations.length, 1);
    assert.match(ownGenerations[0]!, /^own\.[0-9a-f]{12}\.ofx$/);
    assert.deepEqual(listFolder(fixture.rootPrefix, "inbound-b").sort(), ["identified.ofx", "processed"]);
    assert.deepEqual(listFolder(fixture.rootPrefix, join("inbound-b", "processed")), [day]);
    const plainGenerations = listFolder(fixture.rootPrefix, join("inbound-b", "processed", day));
    assert.equal(plainGenerations.length, 1);
    assert.match(plainGenerations[0]!, /^plain\.[0-9a-f]{12}\.ofx$/);
    // Exactly the two imported files' lines landed (one line each).
    assert.equal((await lineCount(fixture.orgId)) - before, 2);
  } finally {
    await withBypass(() => dropScratchOrgReporting(fixture.orgId));
  }
});

test.after(() => {
  rmSync(scratchDataDir, { recursive: true, force: true });
});
