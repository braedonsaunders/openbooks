import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { createScratchOrg, dropScratchOrg } from "../testing/fixtures.ts";
import { createSandbox, deleteSandbox, refreshSandbox } from "./lifecycle.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

async function readySandbox(orgId: string) {
  const created = await createSandbox({
    productionOrgId: orgId,
    name: `Guard ${randomUUID()}`,
    tier: "full",
    masked: false,
  });
  return created;
}

async function sandboxStatus(sandboxId: string): Promise<string | null> {
  const row = (await db.execute<{ status: string }>(sql`
    select status from sandboxes where id = ${sandboxId}`)).rows[0];
  return row?.status ?? null;
}

async function orgExists(orgId: string): Promise<boolean> {
  const row = (await db.execute<{ id: string }>(sql`
    select id from orgs where id = ${orgId}`)).rows[0];
  return !!row;
}

test("delete refuses a sandbox with a refresh in flight instead of wiping under it", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  const created = await readySandbox(org.orgId);
  try {
    // A refresh that marked 'refreshing' and is still cloning.
    await db.execute(sql`update sandboxes set status = 'refreshing' where id = ${created.sandboxId}`);
    await assert.rejects(deleteSandbox(created.sandboxId), /refreshing/);
    assert.equal(await sandboxStatus(created.sandboxId), "refreshing");
    assert.equal(await orgExists(created.sandboxOrgId), true);
  } finally {
    await db.execute(sql`update sandboxes set status = 'ready' where id = ${created.sandboxId}`);
    await deleteSandbox(created.sandboxId).catch(() => undefined);
    await dropScratchOrg(org.orgId);
  }
});

test("refresh refuses a sandbox marked for deletion instead of steamrolling it to ready", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  const created = await readySandbox(org.orgId);
  try {
    // A delete that marked 'deleting' and is still wiping.
    await db.execute(sql`update sandboxes set status = 'deleting' where id = ${created.sandboxId}`);
    await assert.rejects(refreshSandbox(created.sandboxId), /being deleted/);
    assert.equal(await sandboxStatus(created.sandboxId), "deleting");
    assert.equal(await orgExists(created.sandboxOrgId), true);
  } finally {
    await deleteSandbox(created.sandboxId).catch(() => undefined);
    await dropScratchOrg(org.orgId);
  }
});
