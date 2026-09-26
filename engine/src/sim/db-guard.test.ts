import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  assertDisposableDatabaseUrl,
  isDedicatedSimDatabase,
} from "./db-guard.ts";

test("simulator CLI refuses provisioning against a non-loopback database", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", "engine/src/sim/cli.ts", "provision"], {
    env: { ...process.env, NODE_ENV: "production", OPENBOOKS_SIM: "1", OPENBOOKS_DB_URL: "postgresql://db.example.invalid/openbooks_prod", OPENBOOKS_BYPASS_DB_URL: "postgres://openbooks_bypass:ci-test-bypass-dummy-password@127.0.0.1:5432/openbooks_test_sim" }, // BYPASS passes the production import gate so the loopback guard is what refuses
    encoding: "utf8",
    timeout: 5_000,
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /OPENBOOKS_DB_URL host must be 127\.0\.0\.1 or localhost/);
});

test("shared dedicated-database policy still accepts a remote test database", () => {
  const remoteTestUrl =
    "postgresql://10.0.0.85:5432/openbooks_test_mtik7828_20260901";

  const parsed = assertDisposableDatabaseUrl(remoteTestUrl, "replay");
  assert.equal(parsed.databaseName, "openbooks_test_mtik7828_20260901");
  assert.equal(isDedicatedSimDatabase(remoteTestUrl), true);
  assert.throws(
    () =>
      assertDisposableDatabaseUrl(remoteTestUrl, "ledger parity provisioning", {
        requireLoopback: true,
      }),
    /127\.0\.0\.1 or localhost/,
  );
});

test("uniquely test-scoped loopback URL is accepted", () => {
  const testUrl = "postgres://127.0.0.1:55432/openbooks_test_mtik7828_20260901";

  const parsed = assertDisposableDatabaseUrl(testUrl, "ledger parity provisioning", {
    requireLoopback: true,
  });
  assert.deepEqual(parsed, {
    host: "127.0.0.1",
    databaseName: "openbooks_test_mtik7828_20260901",
  });
  assert.equal(isDedicatedSimDatabase(testUrl), true);
});

test("loopback database without a disposable marker is rejected", () => {
  assert.throws(
    () => assertDisposableDatabaseUrl("postgres://127.0.0.1/openbooks", "provision"),
    /approved disposable marker/,
  );
});
