import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const routeSource = readFileSync(new URL("./route.ts", import.meta.url), "utf8");

test("delegation refuses gates outside the caller's subsidiary scope", () => {
  assert.match(routeSource, /guardSubsidiaryScope\(authz, gate\.subsidiary_id\)/);
});
