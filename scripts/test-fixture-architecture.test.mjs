import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

const fixtures = readFileSync(new URL("../engine/src/test-fixtures.ts", import.meta.url), "utf8");
const runner = readFileSync(new URL("./test-suite.mjs", import.meta.url), "utf8");
const workflow = readFileSync(new URL("../.github/workflows/test.yml", import.meta.url), "utf8");

test("integration fixtures use a bounded committed pool with fail-closed lifecycle evidence", () => {
  assert.match(fixtures, /OPENBOOKS_TEST_FIXTURE_POOL_SIZE/);
  assert.match(fixtures, /getScratchOrgLifecycleMetrics/);
  assert.match(fixtures, /fullTeardown/);
  assert.match(fixtures, /resets/);
  assert.match(fixtures, /OPENBOOKS_TEST_DB_ISOLATED/);
  assert.match(fixtures, /activeLeases/);
  assert.match(fixtures, /committed/i);
  assert.match(fixtures, /leak/i);
  assert.match(fixtures, /savepoint/i);
  assert.match(fixtures, /snapshotSchema/);
  assert.match(fixtures, /shobj_description/);
});

test("the canonical integration runner owns fixture pool setup and shutdown", () => {
  assert.match(runner, /OPENBOOKS_TEST_FIXTURE_POOL_SIZE/);
  assert.match(runner, /test-fixture-lifecycle/);
  assert.match(runner, /OPENBOOKS_TEST_FIXTURE_OWNER_PORT/);
  assert.match(runner, /test-concurrency=1/);
  assert.match(runner, /suite === 'integration'/);
  assert.match(runner, /suite === 'unit'/);
});

test("suite harness propagates child failure and always records the owner receipt", async () => {
  const { runChild, stopFixtureOwner } = await import("./test-suite.mjs");
  const dir = mkdtempSync(join(tmpdir(), "openbooks-fixture-termination-"));
  const failingChild = join(dir, "failing-child.mjs");
  writeFileSync(failingChild, "process.exit(23);\n", "utf8");
  const childStatus = await runChild([failingChild], { ...process.env });
  assert.equal(childStatus, 23, "the harness must preserve a failing child exit code");

  const ownerFile = join(dir, "owner.mjs");
  writeFileSync(ownerFile, `
import { createServer } from "node:net";
const metrics = { poolSize: 4, fullBootstrap: 4, leases: 7, releases: 7, resets: 7,
  fullTeardown: 4, schemaWideVerification: 4, activeLeases: 0, leakDetections: 0 };
const server = createServer((socket) => {
  let data = "";
  socket.on("data", (chunk) => { data += chunk; });
  socket.on("end", () => {
    const request = JSON.parse(data.trim());
    if (request.op !== "close") { socket.end(JSON.stringify({ ok: false }) + "\\n"); return; }
    process.stdout.write("[fixture-lifecycle] " + JSON.stringify(metrics) + "\\n");
    socket.end(JSON.stringify({ ok: true, metrics }) + "\\n", () => server.close(() => process.exit(0)));
  });
});
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  console.log("READY " + address.port);
});
`, "utf8");

  const owner = spawn(process.execPath, [ownerFile], {
    cwd: resolve(new URL("..", import.meta.url).pathname),
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
  });
  let output = "";
  const ready = await new Promise((resolveReady, rejectReady) => {
    const timeout = setTimeout(
      () => rejectReady(new Error(`termination probe owner readiness timed out: ${output}`)),
      5_000,
    );
    owner.stdout.on("data", (chunk) => {
      output += chunk.toString();
      const match = output.match(/READY (\d+)/);
      if (match) { clearTimeout(timeout); resolveReady(Number(match[1])); }
    });
    owner.stderr.on("data", (chunk) => { output += chunk.toString(); });
    owner.once("error", (error) => { clearTimeout(timeout); rejectReady(error); });
  });
  try {
    const response = await stopFixtureOwner({
      owner,
      port: ready,
      clearTimeout: () => {},
      get output() { return output; },
    });
    assert.equal(response.ok, true);
    const receiptLine = output.split("\n").find((line) => line.startsWith("[fixture-lifecycle] "));
    assert.ok(receiptLine, "owner must emit a lifecycle receipt before exit");
    const receipt = JSON.parse(receiptLine.slice("[fixture-lifecycle] ".length));
    assert.equal(receipt.activeLeases, 0);
    assert.equal(receipt.leakDetections, 0);
    assert.equal(receipt.fullBootstrap, receipt.fullTeardown);
    assert.equal(receipt.fullBootstrap, receipt.schemaWideVerification);
    assert.ok(receipt.fullBootstrap <= receipt.poolSize);
  } finally {
    if (owner.exitCode === null && owner.signalCode === null) {
      owner.kill();
      await new Promise((resolveClose) => owner.once("close", resolveClose));
    }
  }
});

test("CI marks its database isolated and reports fixture lifecycle counts", () => {
  assert.match(workflow, /OPENBOOKS_TEST_DB_ISOLATED:\s*["']?1/);
  assert.match(workflow, /OPENBOOKS_TEST_FIXTURE_POOL_SIZE:/);
  assert.match(workflow, /OPENBOOKS_TEST_DB_MARKER/);
  assert.match(workflow, /fixture.*lifecycle|lifecycle.*fixture/i);
});

test("the lifecycle receipt survives an owner that exits immediately after writing it", async () => {
  // process.stdout is a pipe for the spawned owner, so its writes are
  // asynchronous. An immediate process.exit() truncates them, which once let a
  // fully green suite fail CI's receipt gate with no failing test. Two
  // independent guarantees now carry the receipt: a synchronous file write, and
  // a stream write that is flushed before the exit.
  const owner = readFileSync(new URL("./test-fixture-lifecycle.mjs", import.meta.url), "utf8");
  assert.match(owner, /writeFileSync\(RECEIPT_PATH/, "the owner must persist the receipt to a file");
  assert.doesNotMatch(
    owner,
    /process\.stdout\.write\(`\$\{receipt\}\\n`\);\s*\n\s*server\.close\(\(\) => process\.exit/,
    "the owner must not exit before its receipt write is acknowledged",
  );
  assert.match(owner, /process\.stdout\.write\(`\$\{receipt\}\\n`, \(\) =>/, "the exit must wait on the write callback");
  assert.match(workflow, /fixture-lifecycle-receipt\.txt/, "CI must read the persisted receipt, not only the tee'd stream");

  // Demonstrate the underlying platform behavior rather than trusting the shape
  // of the source: fill the pipe, then compare both exit disciplines.
  const dir = mkdtempSync(join(tmpdir(), "receipt-flush-"));
  const child = join(dir, "child.mjs");
  const run = (mode) =>
    new Promise((resolveRun) => {
      const proc = spawn(process.execPath, [child, mode], { stdio: ["ignore", "pipe", "inherit"] });
      let out = "";
      proc.stdout.on("data", (chunk) => {
        out += chunk.toString();
      });
      proc.once("close", () => resolveRun(out.includes("[fixture-lifecycle]")));
    });
  writeFileSync(
    child,
    [
      "const receipt = '[fixture-lifecycle] {}';",
      "process.stdout.write('x'.repeat(200000) + '\\n');",
      "if (process.argv[2] === 'unflushed') { process.stdout.write(receipt + '\\n'); process.exit(0); }",
      "else process.stdout.write(receipt + '\\n', () => process.exit(0));",
    ].join("\n"),
  );
  assert.equal(await run("unflushed"), false, "an unflushed exit is expected to lose the receipt");
  assert.equal(await run("flushed"), true, "a flushed exit must retain the receipt");
});

const behavior = process.env.OPENBOOKS_TEST_FIXTURE_BEHAVIOR === "1";

test("pool refuses shared databases even when the isolation flag is spoofed", { skip: !behavior }, async () => {
  const { ScratchOrgPool, hasEphemeralDatabaseMarker } = await import("../engine/src/test-fixtures.ts");
  const store = { bootstrap: async () => ({ orgId: "unused" }), reset: async () => {}, teardown: async () => {} };
  assert.throws(
    () => new ScratchOrgPool({ size: 2, isolatedDatabase: false, store }),
    /dedicated ephemeral database/,
  );
  assert.equal(hasEphemeralDatabaseMarker("openbooks-ci-ephemeral-real", "openbooks-ci-ephemeral-fake"), false);
  assert.equal(hasEphemeralDatabaseMarker("openbooks-ci-ephemeral-real", undefined), false);
  assert.equal(hasEphemeralDatabaseMarker("openbooks-ci-ephemeral-real", "openbooks-ci-ephemeral-real"), true);
});

test("leases reset committed state, preserve tenant isolation, and bound lifecycle work", { skip: !behavior }, async () => {
  const { ScratchOrgPool } = await import("../engine/src/test-fixtures.ts");
  let next = 0;
  const records = new Map();
  const baselineRows = new Map([["baseline-account", "original"], ["baseline-setting", "production"]]);
  const store = {
    bootstrap: async () => {
      const org = { orgId: `scratch-${++next}`, rows: new Map(baselineRows), resetCommits: 0 };
      records.set(org.orgId, org);
      return org;
    },
    reset: async (org) => {
      // A real reset is a committed transaction; the lease cannot be
      // reissued until this marker is durable and all rows are restored.
      org.rows.clear();
      for (const [key, value] of baselineRows) org.rows.set(key, value);
      org.resetCommits += 1;
    },
    teardown: async (org) => {
      assert.deepEqual(org.rows, baselineRows, "teardown must receive a clean committed slot");
      records.delete(org.orgId);
    },
  };
  const pool = new ScratchOrgPool({ size: 2, isolatedDatabase: true, store });
  const first = await pool.lease();
  const second = await pool.lease();
  assert.notEqual(first.orgId, second.orgId, "leases must never share a tenant");
  first.rows.set("baseline-account", "mutated");
  first.rows.set("new-row", "must-disappear");
  first.rows.delete("baseline-setting");
  second.rows.set("other-tenant-row", "private");
  await pool.release(first.orgId);
  assert.equal(first.resetCommits, 1, "release waits for the committed reset");
  assert.deepEqual(first.rows, baselineRows, "committed reset restores updates/deletes and removes inserts");
  assert.equal(second.rows.get("other-tenant-row"), "private", "cross-tenant state is isolated");
  const recycled = await pool.lease();
  assert.equal(recycled.orgId, first.orgId, "clean slot is recycled");
  assert.deepEqual(recycled.rows, baselineRows, "mutated baseline/new rows are reset before reuse");
  await pool.release(second.orgId);
  await pool.release(recycled.orgId);
  await pool.close();
  const metrics = pool.metrics;
  assert.equal(metrics.fullBootstrap, 2);
  assert.equal(metrics.fullTeardown, 2);
  assert.equal(metrics.schemaWideVerification, 2);
  assert.ok(metrics.fullBootstrap <= metrics.poolSize);
  assert.ok(metrics.fullTeardown <= metrics.poolSize);
  assert.ok(metrics.schemaWideVerification <= metrics.poolSize);
  assert.equal(metrics.activeLeases, 0);
});

test("leaked rows taint a slot and fail closed", { skip: !behavior }, async () => {
  const { ScratchOrgPool } = await import("../engine/src/test-fixtures.ts");
  const store = {
    bootstrap: async () => ({ orgId: "leaky", rows: new Set(["uncommitted-leak"]) }),
    reset: async (org) => {
      if (org.rows.size > 0) throw new Error("leaked rows remain after reset");
    },
    teardown: async () => {},
  };
  const pool = new ScratchOrgPool({ size: 1, isolatedDatabase: true, store });
  const org = await pool.lease();
  await assert.rejects(() => pool.release(org.orgId), /leaked rows/);
  assert.equal(pool.metrics.leakDetections, 1);
  await assert.rejects(() => pool.close(), /lifecycle failures/);
  assert.equal(pool.metrics.activeLeases, 0);
});

test("worker lifecycle releases owner leases that legacy tests leave outstanding", { skip: !behavior }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "openbooks-fixture-worker-"));
  const workerFile = join(dir, "worker.test.mjs");
  const fixtureModule = new URL("../engine/src/test-fixtures.ts", import.meta.url).href;
  writeFileSync(workerFile, `
import test from "node:test";
import { createScratchOrg } from ${JSON.stringify(fixtureModule)};
await createScratchOrg();
test("legacy lease is returned by the lifecycle hook", () => {});
`, "utf8");
  let releaseCount = 0;
  const owner = createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const request = JSON.parse(buffer.slice(0, newline));
      if (request.op === "lease") {
        socket.end(JSON.stringify({ ok: true, org: { orgId: "worker-lease" } }) + "\n");
      } else if (request.op === "release") {
        releaseCount += 1;
        socket.end(JSON.stringify({ ok: true }) + "\n");
      } else {
        socket.end(JSON.stringify({ ok: false, error: "unexpected operation" }) + "\n");
      }
    });
  });
  await new Promise((resolveReady) => owner.listen(0, "127.0.0.1", resolveReady));
  const address = owner.address();
  assert.ok(address && typeof address !== "string");
  const result = await new Promise((resolveResult, rejectResult) => {
    const child = spawn(process.execPath, [
      "--import", "tsx",
      "--import", "./engine/src/test-database-bypass.ts",
      "--import", "./scripts/test-fixture-lifecycle.mjs",
      "--test", "--test-force-exit", workerFile,
    ], {
      cwd: resolve(new URL("..", import.meta.url).pathname),
      env: {
        ...process.env,
        NODE_TEST_CONTEXT: undefined,
        OPENBOOKS_DB_URL: "",
        OPENBOOKS_TRUSTED_TEST_BYPASS: "1",
        OPENBOOKS_TEST_FIXTURE_OWNER_PORT: String(address.port),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.once("error", rejectResult);
    child.once("close", (status) => resolveResult({ status, output }));
  });
  await new Promise((resolveClose) => owner.close(resolveClose));
  assert.equal(result.status, 0, result.output);
  assert.equal(releaseCount, 1, "worker lifecycle must release every outstanding owner lease");
});

test("real pooled leases restore committed baseline rows and stay cross-tenant isolated", {
  skip: !behavior || !process.env.OPENBOOKS_DB_URL || !process.env.OPENBOOKS_TEST_DB_MARKER,
}, async () => {
  const { createScratchOrg, dropScratchOrg } = await import("../engine/src/test-fixtures.ts");
  const { db, withBypassContext } = await import("../engine/src/db.ts");
  const { sql } = await import("drizzle-orm");
  const { randomUUID } = await import("node:crypto");
  const first = await createScratchOrg();
  const second = await createScratchOrg();
  const baseline = await withBypassContext(async () => {
    const account = await db.execute(sql`select name from accounts where id = ${first.accounts.invAsset}`);
    const org = await db.execute(sql`select settings from orgs where id = ${first.orgId}`);
    const book = await db.execute(sql`select name from accounting_books where id = ${first.bookId}`);
    const location = await db.execute(sql`select name from locations where id = ${first.locationId}`);
    const stock = await db.execute(sql`select code from stock_locations where id = ${first.stockLocationId}`);
    const secondAccount = await db.execute(sql`select name from accounts where id = ${second.accounts.invAsset}`);
    return { account: account.rows[0].name, settings: org.rows[0].settings, book: book.rows[0].name, location: location.rows[0].name, stock: stock.rows[0].code, secondAccount: secondAccount.rows[0].name };
  });
  const addedId = randomUUID();
  await withBypassContext(() => db.transaction(async (tx) => {
    await tx.execute(sql`update accounts set name = 'MUTATED BASELINE' where id = ${first.accounts.invAsset}`);
    await tx.execute(sql`update accounting_books set name = 'MUTATED BOOK' where id = ${first.bookId}`);
    await tx.execute(sql`update locations set name = 'MUTATED LOCATION' where id = ${first.locationId}`);
    await tx.execute(sql`update orgs set settings = '{"leakProbe":true}'::jsonb where id = ${first.orgId}`);
    await tx.execute(sql`delete from stock_locations where id = ${first.stockLocationId}`);
    await tx.execute(sql`
      insert into accounts (id, org_id, number, name, type, is_summary, is_active, eliminate, reconcilable, required_dimensions, custom, subsidiary_include_children)
      values (${addedId}, ${first.orgId}, ${"9" + Date.now().toString().slice(-8)}, 'Lease-only row', 'expense', false, true, false, false, '[]'::jsonb, '{}'::jsonb, true)`);
  }));
  await dropScratchOrg(first.orgId);
  const recycled = await createScratchOrg();
  assert.equal(recycled.orgId, first.orgId, "release must recycle the same bounded slot");
  const restored = await withBypassContext(async () => {
    const account = await db.execute(sql`select name from accounts where id = ${recycled.accounts.invAsset}`);
    const org = await db.execute(sql`select settings from orgs where id = ${recycled.orgId}`);
    const book = await db.execute(sql`select name from accounting_books where id = ${recycled.bookId}`);
    const location = await db.execute(sql`select name from locations where id = ${recycled.locationId}`);
    const stock = await db.execute(sql`select code from stock_locations where id = ${recycled.stockLocationId}`);
    const added = await db.execute(sql`select count(*)::int as count from accounts where id = ${addedId}`);
    const secondAccount = await db.execute(sql`select name from accounts where id = ${second.accounts.invAsset}`);
    return { account: account.rows[0].name, settings: org.rows[0].settings, book: book.rows[0].name, location: location.rows[0].name, stock: stock.rows[0].code, added: added.rows[0].count, secondAccount: secondAccount.rows[0].name };
  });
  assert.equal(restored.account, baseline.account, "baseline account update was restored");
  assert.deepEqual(restored.settings, baseline.settings, "baseline org settings were restored");
  assert.equal(restored.book, baseline.book, "baseline book update was restored");
  assert.equal(restored.location, baseline.location, "baseline location update was restored");
  assert.equal(restored.stock, baseline.stock, "deleted baseline stock location was restored");
  assert.equal(restored.added, 0, "lease-created rows were removed");
  assert.equal(restored.secondAccount, baseline.secondAccount, "a different tenant was untouched");
  await dropScratchOrg(second.orgId);
  await dropScratchOrg(recycled.orgId);
});

test("the canonical multi-file node invocation keeps lifecycle counts suite-global", { skip: !behavior }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "openbooks-fixture-probe-"));
  const log = join(dir, "metrics.ndjson");
  writeFileSync(log, "", "utf8");
  const ownerScript = join(dir, "owner.mjs");
  writeFileSync(ownerScript, `import { createServer } from "node:net"; import { appendFileSync } from "node:fs";
let claimed = false;
const server = createServer(socket => { let buffer = ""; socket.on("data", chunk => { buffer += chunk; const newline = buffer.indexOf("\\n"); if (newline < 0) return; const request = JSON.parse(buffer.slice(0, newline)); const delta = claimed ? 0 : 4; claimed = true; appendFileSync(${JSON.stringify(log)}, JSON.stringify({ workerPid: request.workerPid, fullBootstrap: delta, fullTeardown: delta, schemaWideVerification: delta }) + "\\n"); socket.end("{\\"ok\\":true}\\n"); }); });
server.listen(Number(process.env.OPENBOOKS_FIXTURE_PROBE_OWNER_PORT), "127.0.0.1", () => console.log("READY"));
`, "utf8");
  const port = 40000 + (process.pid % 20000);
  const owner = spawn(process.execPath, [ownerScript], { stdio: ["ignore", "pipe", "inherit"], env: { ...process.env, OPENBOOKS_FIXTURE_PROBE_OWNER_PORT: String(port) } });
  await new Promise((resolveReady) => setTimeout(resolveReady, 100));
  for (const name of ["a", "b"]) {
    writeFileSync(join(dir, `${name}.test.mjs`), `import test from "node:test"; import { createConnection } from "node:net";
const response = await new Promise((resolve, reject) => { const socket = createConnection({ host: "127.0.0.1", port: Number(process.env.OPENBOOKS_FIXTURE_PROBE_PORT) }); let data = ""; socket.on("data", chunk => data += chunk); socket.on("end", () => resolve(JSON.parse(data))); socket.on("error", reject); socket.on("connect", () => socket.end(JSON.stringify({ workerPid: process.pid }) + "\\n")); });
test("${name}", () => { if (!response.ok) throw new Error("owner rejected lease"); });
`, "utf8");
  }
  const files = [join(dir, "a.test.mjs"), join(dir, "b.test.mjs")];
  try {
    const result = await new Promise((resolveResult, rejectResult) => {
      const child = spawn(process.execPath, [
        "--import", "tsx", "--import", "./engine/src/test-database-bypass.ts", "--test", "--test-force-exit", "--test-concurrency=1", ...files,
      ], { cwd: resolve(new URL("..", import.meta.url).pathname), env: { ...process.env, NODE_TEST_CONTEXT: undefined, OPENBOOKS_TRUSTED_TEST_BYPASS: "1", OPENBOOKS_FIXTURE_PROBE_PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      child.stdout.on("data", chunk => { output += chunk; });
      child.stderr.on("data", chunk => { output += chunk; });
      child.once("error", rejectResult);
      child.once("close", status => resolveResult({ status, output }));
    });
    assert.equal(result.status, 0, result.output);
  } finally {
    owner.kill();
  }
  const rows = readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(rows.length, 2);
  assert.equal(new Set(rows.map((row) => row.workerPid)).size, 2, "canonical runner keeps file workers isolated");
  for (const metric of ["fullBootstrap", "fullTeardown", "schemaWideVerification"]) {
    assert.ok(rows.reduce((sum, row) => sum + row[metric], 0) <= 4, `${metric} multiplied across workers`);
  }
});
