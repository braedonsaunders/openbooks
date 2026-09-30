import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import test from "node:test";
import { sql } from "drizzle-orm";
import { installEngineSeams } from "../composition/install.ts";
import { db, withOrgContext, withBypass } from "../platform/db.ts";
import { loadRun } from "../sim/runner.ts";
import { wipeSimOrg } from "../sim/world.ts";
import { generateTemplate, SampleCompanyPreconditionError } from "./service.ts";

installEngineSeams();
test("a lost database connection preserves an attested checkpoint and refuses a duplicate build", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  let runDir = "";
  let orgId = "";
  let wiped = false;
  try {
    await assert.rejects(generateTemplate("manufacturing", {
      simulateTemplate: async (directory) => {
        runDir = directory;
        orgId = loadRun(directory).manifest.orgId;
        throw new Error("connection terminated unexpectedly");
      },
      wipeTemplateAttempt: async () => { wiped = true; },
    }), (error: unknown) => {
      assert.ok(error instanceof SampleCompanyPreconditionError);
      assert.match(error.message, /Restore database access.*resume --run-dir/);
      assert.ok(error.message.includes(runDir));
      assert.ok(error.message.includes(orgId));
      return true;
    });
    assert.equal(wiped, false, "a connection interruption must retain its accounting tenant");
    assert.ok(existsSync(`${runDir}/manifest.json`));
    const marker = await withOrgContext(orgId, async () => (await db.execute<{ attempt: { runDir: string } }>(sql`select settings->'sampleTemplateAttempt' as attempt from orgs where id=${orgId}`)).rows[0]!);
    assert.equal(marker.attempt.runDir, runDir);
    let provisionedAgain = false;
    await assert.rejects(generateTemplate("manufacturing", {
      simulateTemplate: async () => { provisionedAgain = true; throw new Error("unexpected duplicate build"); },
      wipeTemplateAttempt: async () => { wiped = true; },
    }), /Resume its preserved checkpoint/);
    assert.equal(provisionedAgain, false);
    assert.equal(wiped, false);
  } finally {
    if (orgId) await withBypass(() => wipeSimOrg(orgId));
    if (runDir) rmSync(runDir, { recursive: true, force: true });
  }
});
