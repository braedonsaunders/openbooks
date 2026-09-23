import assert from "node:assert/strict";
import test from "node:test";
import { buildSource, sourceType, validateSourceConfig, type ConnectionRow } from "./connection.ts";
import { QbdSource } from "./qbd-source.ts";

function qbdRow(config: Record<string, unknown>): ConnectionRow {
  return {
    id: "11111111-2222-4333-8555-666666666666",
    orgId: "00000000-0000-4000-8000-000000000001",
    source: "qbd",
    displayName: "QBD test",
    authKind: "token",
    status: "active",
    config,
    secrets: null,
    mirrorEnabled: false,
    mirrorSchedule: "",
    postedChangePolicy: "append_only_automatic",
    postedChangeAuthorizedBy: null,
    postedChangeAuthorizedAt: null,
    cursor: null,
    lastRunAt: null,
    lastError: null,
  };
}

test("buildSource refuses a QuickBooks Desktop connection with no base currency", () => {
  for (const config of [
    { historyStartDate: "2020-01-01" },
    { historyStartDate: "2020-01-01", baseCurrency: "" },
    { historyStartDate: "2020-01-01", baseCurrency: "   " },
  ]) {
    let message: string | null = null;
    try {
      buildSource(qbdRow(config));
    } catch (error) {
      message = (error as Error).message;
    }
    // Refused by name before any capture or import — never a silent USD.
    assert.equal(
      message,
      "QuickBooks Desktop connection needs its base currency — set it on the connection before syncing",
    );
  }
});

test("buildSource refuses a QuickBooks Desktop connection with an invalid base currency", () => {
  for (const baseCurrency of ["ZZZ", "USDD", "12", "USDX"]) {
    assert.throws(
      () => buildSource(qbdRow({ historyStartDate: "2020-01-01", baseCurrency })),
      /has an invalid base currency .* — set it on the connection before syncing/,
    );
  }
});

test("buildSource builds a QuickBooks Desktop source with a valid base currency and no USD default", () => {
  const source = buildSource(qbdRow({ historyStartDate: "2020-01-01", baseCurrency: "CAD" }));
  assert.ok(source instanceof QbdSource);
  assert.equal(source.baseCurrency, "CAD");
  // Registry form is canonicalized, and the constructor itself invents
  // nothing when the (required) value is absent at runtime.
  const padded = buildSource(qbdRow({ historyStartDate: "2020-01-01", baseCurrency: " cad " }));
  assert.ok(padded instanceof QbdSource);
  assert.equal(padded.baseCurrency, "CAD");
  const bypassed = new QbdSource({
    orgId: "org",
    connectionId: "conn",
    historyStartDate: "2020-01-01",
    baseCurrency: "GBP",
  });
  assert.equal(bypassed.baseCurrency, "GBP");
});

test("save-time validation shares the build path's base-currency validator", () => {
  const manifest = sourceType("qbd");
  assert.ok(manifest);
  const opts = { today: "2026-09-23" };
  assert.equal(
    validateSourceConfig(manifest, { historyStartDate: "2020-01-01", region: "CA", baseCurrency: "CAD" }, opts),
    null,
  );
  assert.equal(
    validateSourceConfig(manifest, { historyStartDate: "2020-01-01", region: "CA", baseCurrency: "ZZZ" }, opts),
    "Base currency has an invalid value",
  );
});
