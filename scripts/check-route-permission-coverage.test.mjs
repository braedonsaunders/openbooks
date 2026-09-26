import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeImports,
  findRouteFeatures,
  isPublicRoute,
  loadPublicSurface,
} from "./check-route-permission-coverage.mjs";

const proxy = `
const EXACT_PUBLIC_PATHS = new Set(["/api/login", "/mcp"]);
const PUBLIC_SEGMENT_ROOTS = ["/api/v1", "/api/sign"] as const;
`;
const surface = loadPublicSurface(proxy);

test("factory, jsonObject and sql imports are detected by specifier", () => {
  assert.equal(analyzeImports(`import { defineRoute } from "@/lib/api/route";`, "web/app/api/x").defineRoute, true);
  assert.equal(analyzeImports(`import { defineRoute } from "../../../lib/api/route";`, "web/app/api/x").defineRoute, true);
  assert.equal(analyzeImports(`import { guardPermission } from "../../../lib/authz";`, "web/app/api/x").defineRoute, false);
  assert.equal(analyzeImports(`import { jsonObject } from "@/lib/api/json";`, "web/app/api/x").jsonObject, true);
  assert.equal(analyzeImports(`import { sql } from "drizzle-orm";`, "web/app/api/x").sql, true);
  assert.equal(analyzeImports(`import { sql } from "./other";`, "web/app/api/x").sql, false);
});

test("feature declarations distinguish keys, reasons and empty reasons", () => {
  const [keyed] = findRouteFeatures(`defineRoute({ permission: "a", feature: "orders", handler })`);
  assert.equal(keyed.hasFeature, true);
  const [none] = findRouteFeatures(`defineRoute({ permission: "a", feature: { none: "always on" }, handler })`);
  assert.equal(none.noneReason, "always on");
  assert.equal(none.noneEmpty, false);
  const [empty] = findRouteFeatures(`defineRoute({ permission: "a", feature: { none: "" }, handler })`);
  assert.equal(empty.noneEmpty, true);
  const [missing] = findRouteFeatures(`defineRoute({ permission: "a", handler })`);
  assert.equal(missing.hasFeature, false);
});

test("public paths match exact entries and segment roots only", () => {
  assert.equal(isPublicRoute("/api/login", surface), true);
  assert.equal(isPublicRoute("/api/v1/records/x", surface), true);
  assert.equal(isPublicRoute("/api/accounts", surface), false);
  assert.equal(isPublicRoute("/api/v10", surface), false);
});
