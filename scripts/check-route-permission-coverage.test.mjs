import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeRouteBodies,
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

test("route body schemas and handlers reject opaque validation gaps and request replay", () => {
  const cases = [
    {
      name: "unallowed unknown body field",
      source: `defineRoute({ permission: "x", feature: "orders", body: z.object({ payload: z.unknown() }), handler: async () => ok() })`,
      expected: 'body field "payload" uses z.unknown()',
    },
    {
      name: "reasoned opaque JSON body field",
      source: `defineRoute({ permission: "x", feature: "orders", body: z.object({ payload: z.unknown() }), opaque: { payload: "Organization-defined JSON is stored without interpretation." }, handler: async () => ok() })`,
      expected: null,
    },
    {
      name: "empty opaque reason",
      source: `defineRoute({ permission: "x", feature: "orders", body: z.object({ payload: z.any() }), opaque: { payload: " " }, handler: async () => ok() })`,
      expected: "needs a non-empty reason",
    },
    {
      name: "body with only optional fields",
      source: `defineRoute({ permission: "x", feature: "orders", body: z.object({ name: z.string().optional() }), handler: async () => ok() })`,
      expected: "body object has only optional fields",
    },
    {
      name: "optional body fields with a no-op refinement",
      source: `defineRoute({ permission: "x", feature: "orders", body: z.object({ name: z.string().optional() }).refine(() => true), handler: async () => ok() })`,
      expected: "body object has only optional fields",
    },
    {
      name: "optional patch fields with a non-empty refinement",
      source: `defineRoute({ permission: "x", feature: "orders", body: z.object({ name: z.string().optional() }).refine((body) => Object.keys(body).length > 0), handler: async () => ok() })`,
      expected: null,
    },
    {
      name: "discriminated body variants require an action",
      source: `defineRoute({ permission: "x", feature: "orders", body: z.discriminatedUnion("action", [z.object({ action: z.literal("create"), name: z.string().optional() }), z.object({ action: z.literal("delete"), id: z.string() })]), handler: async () => ok() })`,
      expected: null,
    },
    {
      name: "handler request replay",
      source: `defineRoute({ permission: "x", feature: "orders", body: z.object({ name: z.string() }), handler: async ({ request }) => new Request(request.url) })`,
      expected: "handler constructs a new Request",
    },
  ];

  for (const item of cases) {
    const violations = analyzeRouteBodies(item.source);
    if (item.expected === null) {
      assert.deepEqual(violations, [], item.name);
    } else {
      assert.ok(violations.some(({ message }) => message.includes(item.expected)), item.name);
    }
  }
});
