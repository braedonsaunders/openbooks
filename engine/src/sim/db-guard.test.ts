import assert from "node:assert/strict";
import test from "node:test";
import {
  assertDisposableDatabaseUrl,
  isDedicatedSimDatabase,
} from "./db-guard.ts";

test("production OpenBooks URL is rejected before any database query", () => {
  const productionUrl = "postgresql://10.0.0.85:5432/openbooks";

  assert.throws(
    () =>
      assertDisposableDatabaseUrl(productionUrl, "ledger parity provisioning", {
        requireLoopback: true,
      }),
    (error: unknown) => {
      assert.match((error as Error).message, /127\.0\.0\.1 or localhost/);
      return true;
    },
  );
  assert.equal(isDedicatedSimDatabase(productionUrl), false);
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
