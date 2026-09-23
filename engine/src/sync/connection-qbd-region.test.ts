import test from "node:test";
import assert from "node:assert/strict";
import { QBD_WEB_CONNECTOR_REGIONS, sourceType, validateSourceConfig } from "./connection.ts";

const manifest = sourceType("qbd");
assert.ok(manifest);

const base = {
  historyStartDate: "2024-01-01",
  region: "US",
  baseCurrency: "USD",
  companyFile: "",
};

test("the manifest offers only Web Connector-supported regions", () => {
  // Intuit's Web Connector get-started documentation: QBWC 2.2.0.34+ works
  // with US, Canadian (2015+) and UK (2015+) editions only — no AU/NZ.
  assert.deepEqual([...QBD_WEB_CONNECTOR_REGIONS], ["US", "CA", "UK"]);
  const region = manifest.configFields.find((field) => field.key === "region");
  assert.ok(region);
  assert.deepEqual(region.options?.map((option) => option.value), ["US", "CA", "UK"]);
});

test("AU/NZ regions are refused by name at setup validation", () => {
  for (const region of ["AU", "NZ"]) {
    assert.match(
      validateSourceConfig(manifest, { ...base, region }) ?? "",
      new RegExp(`QuickBooks Desktop ${region} editions are not supported by the Intuit Web Connector`),
      `${region} must hear the truthful refusal, not a bare invalid value`,
    );
  }
  for (const region of ["US", "CA", "UK"]) {
    assert.equal(validateSourceConfig(manifest, { ...base, region }), null);
  }
});
