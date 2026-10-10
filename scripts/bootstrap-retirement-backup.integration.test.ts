import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import pg from "pg";
import { ensureRetirementBackupAccess } from "./bootstrap/retirement-backup-access.ts";

const exec = promisify(execFile);
const adminUrl = process.env.OPENBOOKS_TEST_ADMIN_DB_URL;
const enabled = Boolean(process.env.OPENBOOKS_DB_URL || adminUrl);
const ident = (value: string) => `"${value.replaceAll('"', '""')}"`;

test("retirement backup admission requires complete read-only dump access without changing private authority", { skip: !enabled, timeout: 120_000 }, async () => {
  assert.ok(adminUrl, "use the marked database administrator endpoint for the retirement backup caller");
  const admin = new pg.Client({ connectionString: adminUrl });
  const role = `ob_retirement_dump_${randomBytes(6).toString("hex")}`;
  const password = randomBytes(32).toString("hex");
  const dumpUrl = new URL(adminUrl); dumpUrl.username = role; dumpUrl.password = password;
  const reader = new pg.Client({ connectionString: dumpUrl.toString() });
  const directory = await mkdtemp(join(tmpdir(), "retirement-backup-"));
  let roleCreated = false, connected = false;
  await admin.connect();
  try {
    assert.equal((await admin.query("select to_regclass('tenant_retirement.runs') is not null as present")).rows[0]?.present, true,
      "the coordinated native bootstrap must install retirement before this caller");
    const authority = async () => (await admin.query(`select p.oid::regprocedure::text as signature,p.proowner,
      p.proacl::text as acl,pg_get_functiondef(p.oid) as definition from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='tenant_retirement' order by signature`)).rows;
    const beforeAuthority = await authority();
    const beforePublicAcl = (await admin.query(`select c.relname,c.relacl::text as acl from pg_class c
      join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' order by c.relname`)).rows;
    await admin.query(`create role ${ident(role)} login nosuperuser bypassrls nocreatedb nocreaterole noreplication password '${password}'`);
    roleCreated = true;
    const database = (await admin.query("select current_database() as name")).rows[0].name as string;
    await admin.query(`grant connect on database ${ident(database)} to ${ident(role)}`);
    const privateAcl = async () => (await admin.query(`select c.relname,c.relowner,c.relacl::text as acl from pg_class c
      join pg_namespace n on n.oid=c.relnamespace where n.nspname='tenant_retirement' order by c.relname`)).rows;
    const beforeAcl = await privateAcl();
    await assert.rejects(ensureRetirementBackupAccess(admin, role, { verifyOnly: true }), /SELECT grants are incomplete.*--retirement-backup-access-only/);
    assert.deepEqual(await privateAcl(), beforeAcl, "the release preflight refuses without installing grants");
    const release = await readFile(new URL("../deploy/swarm-release.sh", import.meta.url), "utf8");
    assert.ok(release.indexOf("--retirement-backup-access-only --verify") < release.indexOf('pg_dump -Fc'), "native read-only admission precedes the mandatory snapshot");
    assert.match(release, /verification failed; refusing before snapshot or migrations/);
    assert.doesNotMatch(release, /--exclude-schema[= ]['"]?tenant_retirement/);
    assert.equal(await ensureRetirementBackupAccess(admin, role), true);
    const installedAcl = await privateAcl();
    assert.deepEqual(installedAcl.map(row => [row.relname, row.relowner]), beforeAcl.map(row => [row.relname, row.relowner]), "table and sequence ownership stays private");
    assert.equal(await ensureRetirementBackupAccess(admin, role, { verifyOnly: true }), true);
    assert.equal(await ensureRetirementBackupAccess(admin, role), true);
    assert.deepEqual(await privateAcl(), installedAcl, "provisioning and verification replay without changing existing grants");
    await reader.connect(); connected = true;
    assert.equal(await ensureRetirementBackupAccess(reader, role, { verifyOnly: true }), true, "verification needs no private-owner privileges");
    assert.deepEqual((await reader.query("select rolsuper,rolbypassrls from pg_roles where rolname=session_user")).rows, [{ rolsuper: false, rolbypassrls: true }]);
    const tables = (await admin.query<{ name: string; column: string }>(`select c.relname::text as name,
      (select a.attname::text from pg_attribute a where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped order by a.attnum limit 1) as column
      from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='tenant_retirement' and c.relkind in ('r','p') order by c.relname`)).rows;
    assert.ok(tables.length >= 5);
    for (const table of tables) {
      const relation = `tenant_retirement.${ident(table.name)}`;
      assert.deepEqual((await reader.query(`select count(*)::text as count from ${relation}`)).rows,
        (await admin.query(`select count(*)::text as count from ${relation}`)).rows, `${table.name} is completely readable`);
      await assert.rejects(reader.query(`delete from ${relation} where false`), { code: "42501" });
      await assert.rejects(reader.query(`update ${relation} set ${ident(table.column)}=default where false`), { code: "42501" });
      await assert.rejects(reader.query(`insert into ${relation} (${ident(table.column)}) overriding system value select ${ident(table.column)} from ${relation} where false`), { code: "42501" });
    }
    const sequences = (await admin.query<{ name: string }>(`select c.relname::text as name from pg_class c
      join pg_namespace n on n.oid=c.relnamespace where n.nspname='tenant_retirement' and c.relkind='S'`)).rows;
    assert.ok(sequences.length > 0, "the event identity counter belongs in the dump");
    for (const sequence of sequences) {
      const relation = `tenant_retirement.${ident(sequence.name)}`;
      assert.deepEqual((await reader.query(`select last_value,is_called from ${relation}`)).rows, (await admin.query(`select last_value,is_called from ${relation}`)).rows);
      await assert.rejects(reader.query("select nextval($1::regclass)", [relation]), { code: "42501" });
      await assert.rejects(reader.query("select setval($1::regclass,1)", [relation]), { code: "42501" });
    }
    const owners = (await admin.query<{ name: string }>(`select distinct pg_get_userbyid(c.relowner) as name from pg_class c
      join pg_namespace n on n.oid=c.relnamespace where n.nspname='tenant_retirement'`)).rows;
    for (const owner of owners) {
      await assert.rejects(reader.query(`set role ${ident(owner.name)}`), { code: "42501" });
      assert.equal((await admin.query("select pg_has_role($1,$2,'MEMBER') as member", [role, owner.name])).rows[0].member, false);
    }
    const dump = join(directory, "retirement.dump");
    // The URL is carried only in the private child environment, never argv.
    await exec("pg_dump", ["-Fc", "--schema=tenant_retirement", "--file", dump], { env: { ...process.env, PGDATABASE: dumpUrl.toString() }, timeout: 60_000 });
    const listing = await exec("pg_restore", ["--list", dump], { timeout: 30_000 });
    for (const table of tables) assert.ok(listing.stdout.includes(`TABLE DATA tenant_retirement ${table.name} `));
    for (const sequence of sequences) assert.ok(listing.stdout.includes(`SEQUENCE SET tenant_retirement ${sequence.name} `));
    await admin.query(`grant insert on tenant_retirement.runs to ${ident(role)}`);
    await assert.rejects(ensureRetirementBackupAccess(admin, role), /write, grant-option or schema-create/);
    assert.equal((await admin.query("select has_table_privilege($1,'tenant_retirement.runs','INSERT') as allowed", [role])).rows[0].allowed, true,
      "unsafe existing grants refuse reconciliation rather than being silently replaced");
    await admin.query(`revoke insert on tenant_retirement.runs from ${ident(role)}`);
    assert.deepEqual(await authority(), beforeAuthority, "private function owners, bodies and ACLs remain exact");
    assert.deepEqual((await admin.query(`select c.relname,c.relacl::text as acl from pg_class c
      join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' order by c.relname`)).rows, beforePublicAcl);
  } finally {
    if (connected) await reader.end();
    try {
      if (roleCreated) {
        await admin.query(`drop owned by ${ident(role)}`);
        await admin.query(`drop role ${ident(role)}`);
      }
    } finally { await admin.end(); await rm(directory, { recursive: true, force: true }); }
  }
});
