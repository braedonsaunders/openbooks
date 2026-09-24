import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { createScratchOrg, dropScratchOrgReporting } from "../testing/fixtures.ts";
import { seedEftSettings } from "./seed-eft-settings.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

/**
 * seed-eft-settings.ts must never infer its tenant: with no org argument it
 * used to stamp placeholder bank settings into whatever org happened to
 * sort first. The target org is now an explicit first argument, a missing
 * or unknown id refuses with the available orgs listed, and nothing is
 * written on refusal.
 */

// The decoy is created FIRST so it is the oldest org: seeding the newer org
// proves the target comes from the argument, not the created_at ordering
// the old query relied on.
async function fixture() {
  const older = await createScratchOrg();
  const newer = await createScratchOrg();
  return { older, newer };
}

async function eftSettings(orgId: string): Promise<unknown> {
  const rows = (await db.execute<{ eft: unknown }>(sql`
    select settings->'eft' as eft from orgs where id = ${orgId}`)).rows;
  return rows[0]!.eft;
}

test("seeding names the newer org and leaves the oldest org alone", { skip: !DB }, async () => {
  const { older, newer } = await fixture();
  try {
    const seeded = await seedEftSettings(newer.orgId);
    assert.equal(seeded.id, newer.orgId);
    const target = (await eftSettings(newer.orgId)) as Record<string, string>;
    assert.equal(target.originatorId, "FILL-ME-10");
    assert.equal(target.transactionCode, "460");
    assert.equal(await eftSettings(older.orgId), null);
  } finally {
    await dropScratchOrgReporting(newer.orgId);
    await dropScratchOrgReporting(older.orgId);
  }
});

test("refusing without an argument lists the orgs and writes nothing", { skip: !DB }, async () => {
  const { older, newer } = await fixture();
  try {
    await assert.rejects(
      () => seedEftSettings(undefined),
      (error: unknown) =>
        error instanceof Error &&
        /pass the org id \(uuid\) as the first argument/.test(error.message) &&
        error.message.includes(newer.orgId),
    );
    assert.equal(await eftSettings(newer.orgId), null);
    assert.equal(await eftSettings(older.orgId), null);
  } finally {
    await dropScratchOrgReporting(newer.orgId);
    await dropScratchOrgReporting(older.orgId);
  }
});

test("refusing an unknown id names it and writes nothing", { skip: !DB }, async () => {
  const { older, newer } = await fixture();
  try {
    await assert.rejects(
      () => seedEftSettings("00000000-0000-0000-0000-000000000000"),
      /no organization with id 00000000-0000-0000-0000-000000000000/,
    );
    assert.equal(await eftSettings(newer.orgId), null);
    assert.equal(await eftSettings(older.orgId), null);
  } finally {
    await dropScratchOrgReporting(newer.orgId);
    await dropScratchOrgReporting(older.orgId);
  }
});
