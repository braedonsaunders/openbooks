import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";

const DB = process.env.OPENBOOKS_DB_URL;

test("scratch-org creation refuses an unmarked database before inserting", { skip: !DB }, async () => {
  const moduleUrl = new URL("./test-fixtures.ts", import.meta.url).href;
  const script = `
    import { sql } from "drizzle-orm";
    import { db, withBypassContext } from "./engine/src/db.ts";
    import { createScratchOrg, dropScratchOrg } from ${JSON.stringify(moduleUrl)};
    const countScratchOrgs = async () => Number((await withBypassContext(async () => await db.execute(sql\`select count(*)::int as n from orgs where name like 'Scratch %'\`))).rows[0]?.n ?? 0);
    const before = await countScratchOrgs();
    let org;
    let error;
    try { org = await createScratchOrg(); } catch (cause) { error = String(cause); }
    const afterAttempt = await countScratchOrgs();
    if (org) await dropScratchOrg(org.orgId);
    process.stdout.write(JSON.stringify({ before, afterAttempt, error }) + "\\n");
    if (!error || afterAttempt !== before) process.exitCode = 1;
  `;
  const result = await new Promise<{ status: number | null; output: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: new URL("../..", import.meta.url),
      env: {
        ...process.env,
        OPENBOOKS_TEST_FIXTURE_OWNER_PORT: "",
        OPENBOOKS_TEST_FIXTURE_POOL: "",
        OPENBOOKS_TEST_DB_ISOLATED: "",
        OPENBOOKS_TEST_DB_MARKER: "openbooks-ci-ephemeral-not-this-database",
        OPENBOOKS_TEST_ALLOW_UNMARKED_DB: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.once("error", reject);
    child.once("close", (status) => resolve({ status, output }));
  });
  assert.equal(result.status, 0, result.output);
  const report = JSON.parse(result.output.trim().split("\n").at(-1)!);
  assert.equal(report.afterAttempt, report.before, result.output);
  assert.match(report.error, /ephemeral database marker|unmarked|shared/i, result.output);
});
