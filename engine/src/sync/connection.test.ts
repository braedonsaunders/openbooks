import assert from "node:assert/strict";
import test from "node:test";
import { sealJson } from "../platform/secrets.ts";
import { buildSource, sourceType, validateSourceConfig, type ConnectionRow } from "./connection.ts";
import { QbdSource } from "./qbd-source.ts";
import { NetSuiteSource } from "./netsuite-source.ts";

process.env.OPENBOOKS_DATA_KEY ??=
  "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";

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

function netsuiteRow(
  config: Record<string, unknown>,
  secrets: Record<string, unknown> | null,
): ConnectionRow {
  return {
    id: "22222222-3333-4444-8555-666666666666",
    orgId: "00000000-0000-4000-8000-000000000001",
    source: "netsuite",
    displayName: "NetSuite test",
    authKind: "token",
    status: "active",
    config,
    secrets: secrets === null ? null : sealJson(secrets),
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

const NETSUITE_CONFIG = { account: "1234567", host: "https://1234567.suitetalk.api.netsuite.com" };
const NETSUITE_SECRETS = {
  consumerKey: "ck",
  consumerSecret: "cs",
  tokenKey: "tk",
  tokenSecret: "ts",
};

test("buildSource refuses a NetSuite connection with a blank token secret, naming it", () => {
  // The old gate checked only the consumer key: this exact row used to
  // build a source that signed with an empty secret and died remotely.
  assert.throws(
    () => buildSource(netsuiteRow(NETSUITE_CONFIG, { ...NETSUITE_SECRETS, tokenSecret: "" })),
    /NetSuite connection is missing credentials: token secret — set them on the connection before syncing/,
  );
});

test("buildSource names every missing NetSuite credential at once", () => {
  assert.throws(
    () => buildSource(netsuiteRow({ account: "   " }, { consumerKey: "ck" })),
    /NetSuite connection is missing credentials: account, host, consumer secret, token key, token secret/,
  );
});

test("buildSource builds a NetSuite source once every credential is present", () => {
  const source = buildSource(netsuiteRow(NETSUITE_CONFIG, NETSUITE_SECRETS));
  assert.ok(source instanceof NetSuiteSource);
});
