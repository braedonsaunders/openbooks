import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { z } from "zod";

// json.ts is server-only (it returns NextResponse objects for route handlers),
// so the runner cannot import it as-is. Shimming the marker package lets these
// tests exercise the real shared boundary at runtime instead of trusting its
// source text. node's test runner isolates each file in its own process, so
// the hook cannot leak elsewhere.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    return nextResolve(specifier, context);
  },
});

const { jsonObject, nullableUuidId, parseJsonBody } = await import("./json");

/**
 * Reviewed non-JSON mutation routes. Every entry needs a narrow reason because
 * this is the only escape hatch from the shared zod request boundary.
 */
const EXEMPT_ROUTES: Readonly<Record<string, string>> = {
  "web/app/api/admin/ai/test/route.ts": "bodyless connectivity test using saved configuration",
  "web/app/api/admin/backups/run/route.ts": "bodyless queue action",
  "web/app/api/admin/scripts/[id]/run/route.ts": "bodyless execution action; script id is a path parameter",
  "web/app/api/ap-capture/[id]/materialize/route.ts": "bodyless lifecycle action; capture id is a path parameter",
  "web/app/api/ap-capture/route.ts": "multipart document upload",
  "web/app/api/assets/draft/route.ts": "bodyless draft factory",
  "web/app/api/assistant/application-command/route.ts": "size-capped raw body carrying a signed confirmation token",
  "web/app/api/banking/reconciliations/[id]/auto-match/route.ts": "bodyless lifecycle action; reconciliation id is a path parameter",
  "web/app/api/banking/reconciliations/[id]/sign-off/route.ts": "bodyless lifecycle action; reconciliation id is a path parameter",
  "web/app/api/billing-requests/[id]/backup/route.ts": "bodyless artifact-generation action; request id is a path parameter",
  "web/app/api/billing-requests/[id]/create-invoice/route.ts": "bodyless lifecycle action; request id is a path parameter",
  "web/app/api/crm/accounts/draft/route.ts": "bodyless draft factory",
  "web/app/api/crm/opportunities/[id]/estimate/route.ts": "bodyless conversion action; opportunity id is a path parameter",
  "web/app/api/equipment/[id]/capitalize/route.ts": "bodyless capitalization action; equipment id is a path parameter",
  "web/app/api/equipment/draft/route.ts": "bodyless draft factory",
  "web/app/api/estimates/draft/route.ts": "bodyless draft factory",
  "web/app/api/expenses/draft/route.ts": "bodyless draft factory",
  "web/app/api/field-tickets/draft/route.ts": "bodyless draft factory",
  "web/app/api/file-cabinet/files/[id]/replace/route.ts": "multipart file replacement",
  "web/app/api/file-cabinet/files/[id]/restore/route.ts": "bodyless restore action; file id is a path parameter",
  "web/app/api/file-cabinet/files/route.ts": "multipart file upload",
  "web/app/api/file-cabinet/folders/[id]/restore/route.ts": "bodyless restore action; folder id is a path parameter",
  "web/app/api/flows/email-action/route.ts": "form-encoded action carrying a signed approval token",
  "web/app/api/insights/cards/draft/route.ts": "bodyless draft factory",
  "web/app/api/insights/dashboards/draft/route.ts": "bodyless draft factory",
  "web/app/api/items/draft/route.ts": "bodyless draft factory",
  "web/app/api/journals/draft/route.ts": "bodyless draft factory",
  "web/app/api/pay/[token]/route.ts": "bodyless token-authenticated checkout action",
  "web/app/api/payments/runs/[id]/file/route.ts": "bodyless artifact-generation action; run id is a path parameter",
  "web/app/api/payments/runs/[id]/files/[fileId]/reprocess/route.ts": "bodyless artifact-reprocessing action; identifiers are path parameters",
  "web/app/api/payments/runs/[id]/post/route.ts": "bodyless lifecycle action; run id is a path parameter",
  "web/app/api/payments/runs/[id]/submit/route.ts": "bodyless lifecycle action; run id is a path parameter",
  "web/app/api/payments/webhooks/[provider]/route.ts": "signature verification requires the unparsed raw text body",
  "web/app/api/platform/connections/[id]/test/route.ts": "bodyless connectivity test; connection id is a path parameter",
  "web/app/api/payroll/runs/[id]/bank-file/[fileId]/route.ts": "bodyless audited artifact-release action; identifiers are path parameters",
  "web/app/api/payroll/runs/[id]/cheques-pdf/route.ts": "bodyless audited print action; run id is a path parameter",
  "web/app/api/projects/draft/route.ts": "bodyless draft factory",
  "web/app/api/purchase-orders/draft/route.ts": "bodyless draft factory",
  "web/app/api/qbd/web-connector/[id]/route.ts": "XML protocol endpoint requiring the raw text body",
  "web/app/api/records/[typeKey]/draft/route.ts": "bodyless draft factory; record type is a path parameter",
  "web/app/api/records/types/route.ts": "bodyless draft factory",
  "web/app/api/sales-orders/draft/route.ts": "bodyless draft factory",
  "web/app/api/tax/provisions/[id]/post/route.ts": "bodyless posting action; provision id is a path parameter",
  "web/app/api/tax/returns/[code]/official-pdf/route.ts": "multipart official-form upload",
  "web/app/api/views/[id]/run/route.ts": "bodyless execution action; saved-view id is a path parameter",
  "web/app/api/wip-billing/[id]/convert/route.ts": "bodyless conversion action; prebill id is a path parameter",
};

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = resolve(TEST_DIR, "../..");
const API_ROOT = join(WEB_ROOT, "app/api");
const MUTATION_EXPORT_RE = /^export\s+(?:async\s+)?(?:function|const)\s+(POST|PATCH|PUT)\b/gm;
const DIRECT_JSON_READ_RE = /\b(?:req|request)\s*\.\s*json\s*\(/;
// Deliberately NOT global: RegExp.prototype.test on a /g pattern carries
// lastIndex across calls and silently skips matches on later routes.
const SHARED_BOUNDARY_FACTORY_RE = /\b(?:makePATCH|makeConvertPOST)\s*\(/;
const PARSED_SCHEMA_ARG_RE = /\bparseJsonBody\(\s*(?:req|request)\s*,\s*([A-Za-z_$][\w$]*)/g;

/**
 * Typed-validation ratchet (audit fnd_au_gatesratchet). The static gate below
 * proves routes *call* the shared boundary; this caps how many reviewed routes
 * still stop at the shape-only escape hatch instead of a typed zod schema —
 * the gap the old gate could not see because parsing was mistaken for
 * validation.
 *
 * Measured at remediation HEAD: 6 shared-factory order routes + 235 routes
 * calling parseJsonBody(req, jsonObject) directly = 241. The number may only
 * decrease: migrate a body to a typed schema and lower this ceiling in the
 * same commit.
 */
const OBJECT_ONLY_ROUTE_CEILING = 241;

interface MutationRoute {
  file: string;
  methods: string[];
  source: string;
}

type BoundaryKind = "shared-factory" | "object-only" | "typed" | "unparsed";

interface ClassifiedRoute extends MutationRoute {
  kind: BoundaryKind;
}

function routeFiles(directory: string): string[] {
  return readdirSync(directory)
    .flatMap((entry) => {
      const path = join(directory, entry);
      return statSync(path).isDirectory() ? routeFiles(path) : path.endsWith(`${sep}route.ts`) ? [path] : [];
    })
    .sort();
}

function mutationRoute(file: string): MutationRoute | null {
  const source = readFileSync(file, "utf8");
  const methods = [...source.matchAll(MUTATION_EXPORT_RE)].map((match) => match[1]!);
  if (methods.length === 0) return null;
  return {
    file: relative(resolve(WEB_ROOT, ".."), file).split(sep).join("/"),
    methods: [...new Set(methods)].sort(),
    source,
  };
}

function parsedSchemaArgs(source: string): string[] {
  return [...source.matchAll(PARSED_SCHEMA_ARG_RE)].map((match) => match[1]!);
}

/**
 * How a route's mutating methods obtain their body. "object-only" covers both
 * the shared order factory (its handlers parse with jsonObject) and routes
 * passing jsonObject themselves; "unparsed" means no shared boundary at all.
 */
function classifyBoundary(route: MutationRoute): ClassifiedRoute {
  if (SHARED_BOUNDARY_FACTORY_RE.test(route.source)) return { ...route, kind: "shared-factory" };
  const schemas = parsedSchemaArgs(route.source);
  if (schemas.length === 0) return { ...route, kind: "unparsed" };
  return {
    ...route,
    kind: schemas.every((schema) => schema === "jsonObject") ? "object-only" : "typed",
  };
}

function discoveredRoutes(): MutationRoute[] {
  return routeFiles(API_ROOT)
    .map(mutationRoute)
    .filter((route): route is MutationRoute => route !== null);
}

function rawRequest(body: string): Request {
  return new Request("http://localhost/api/test", {
    method: "POST",
    body,
    headers: { "content-type": "application/json" },
  });
}

test("every JSON mutation route parses its body through the shared zod boundary", () => {
  const routes = discoveredRoutes();
  const discovered = new Set(routes.map((route) => route.file));
  const failures: string[] = [];
  const orderFactoryFile = join(API_ROOT, "_order/handlers.ts");
  const orderFactorySource = readFileSync(orderFactoryFile, "utf8");

  if (DIRECT_JSON_READ_RE.test(orderFactorySource)) {
    failures.push("web/app/api/_order/handlers.ts: shared mutation factory reads req/request.json() directly");
  }
  if ((orderFactorySource.match(/parseJsonBody\(/g) ?? []).length < 2) {
    failures.push("web/app/api/_order/handlers.ts: PATCH and convert factories must both use parseJsonBody");
  }

  for (const [file, reason] of Object.entries(EXEMPT_ROUTES)) {
    if (!reason.trim()) failures.push(`${file}: exemption is missing its reviewed reason`);
    if (!discovered.has(file)) failures.push(`${file}: stale exemption (no mutation route discovered)`);
  }

  for (const route of routes) {
    if (route.file in EXEMPT_ROUTES) continue;
    const violations: string[] = [];
    if (!route.source.includes("parseJsonBody(") && !SHARED_BOUNDARY_FACTORY_RE.test(route.source)) {
      violations.push("does not use parseJsonBody");
    }
    if (DIRECT_JSON_READ_RE.test(route.source)) violations.push("reads req/request.json() directly");
    if (violations.length > 0) {
      failures.push(`${route.file} [${route.methods.join(", ")}]: ${violations.join("; ")}`);
    }
  }

  assert.equal(
    failures.length,
    0,
    `${failures.length} mutation route boundary violation(s):\n${failures.map((failure) => `- ${failure}`).join("\n")}`,
  );
});

test("the shared object-only boundary fails closed on hostile payloads at runtime", async () => {
  // The static gate proves routes call the shared boundary; this proves the
  // exact composition those routes take — parseJsonBody(req, jsonObject) —
  // rejects everything that is not a JSON object, so the escape hatch cannot
  // rot silently while its call sites keep matching the source-text gate.
  for (const body of ["{not json", "null", "[1,2]", '"text"', "42"]) {
    const parsed = await parseJsonBody(rawRequest(body), jsonObject);
    assert.equal(parsed.ok, false, `boundary accepted non-object payload: ${body}`);
    if (!parsed.ok) {
      assert.equal(parsed.response.status, 400);
      const payload = (await parsed.response.json()) as { error: string };
      assert.equal(payload.error, "invalid request body");
    }
  }

  // And it documents precisely what object-only validation does prove: any
  // object shape passes through untouched. Field-level typing is the tracked
  // gap (see OBJECT_ONLY_ROUTE_CEILING), not payload shape.
  const passthrough = await parseJsonBody(rawRequest(JSON.stringify({ anything: [1, "x"] })), jsonObject);
  assert.equal(passthrough.ok, true);
  if (passthrough.ok) {
    assert.deepEqual(passthrough.data, { anything: [1, "x"] });
  }
});

test("typed request-boundary coverage never regresses (object-only ratchet)", () => {
  const reviewed = discoveredRoutes()
    .filter((route) => !(route.file in EXEMPT_ROUTES))
    .map(classifyBoundary);

  const unparsed = reviewed.filter((route) => route.kind === "unparsed");
  assert.equal(
    unparsed.length,
    0,
    `non-exempt mutation routes outside every shared boundary:\n${unparsed.map((route) => `- ${route.file}`).join("\n")}`,
  );

  // Dropping the parse call entirely must count as a regression, not as
  // progress toward typed coverage.
  const factory = reviewed.filter((route) => route.kind === "shared-factory").length;
  const objectOnly = reviewed.filter((route) => route.kind === "object-only").length;
  const typed = reviewed.filter((route) => route.kind === "typed").length;
  const shapeOnly = factory + objectOnly;
  assert.ok(
    shapeOnly <= OBJECT_ONLY_ROUTE_CEILING,
    `${shapeOnly} reviewed routes validate bodies as bare objects (ceiling ${OBJECT_ONLY_ROUTE_CEILING}): ` +
      `${factory} via the shared order factory + ${objectOnly} calling parseJsonBody(req, jsonObject) directly; ` +
      `${typed} routes already use a typed schema. Migrate a body to a typed zod schema, ` +
      "then lower OBJECT_ONLY_ROUTE_CEILING in web/lib/api/financial-boundary.test.ts.",
  );
});

test("payment posting preserves provider FX evidence through its request boundary", async () => {
  const routeSource = readFileSync(
    join(API_ROOT, "payments/post-with-applications/route.ts"),
    "utf8",
  );

  // Wiring pin: the allocation boundary keeps declaring the tenant-owned
  // provider FX observation id with the shared nullable-uuid atom.
  const allocationStart = routeSource.indexOf("const allocationInput = z.object({");
  const bodyStart = routeSource.indexOf("const postWithApplicationsBody", allocationStart);

  assert.notEqual(allocationStart, -1, "payment posting allocation boundary is missing");
  assert.notEqual(bodyStart, -1, "payment posting body boundary is missing");
  assert.match(
    routeSource.slice(allocationStart, bodyStart),
    /settlementFxRateId:\s*nullableUuidId\.optional\(\)/,
    "payment posting must retain the tenant-owned provider FX observation id",
  );

  // A declared-but-unwired schema would pass a presence-only text check, so
  // pin the parsed allocations flowing into the posting kernel call.
  assert.match(
    routeSource,
    /postPaymentWithApplications\(\s*documentId\s*,\s*allocations\b/,
    "payment posting must pass the parsed allocations into postPaymentWithApplications",
  );

  // Runtime proof of the semantics the text claims, exercised through the
  // same shared entry point the route uses: an absent observation id stays
  // optional and a junk provider reference is refused before any SQL runs.
  const fxObservation = z.object({ settlementFxRateId: nullableUuidId.optional() });
  const withoutFx = await parseJsonBody(rawRequest("{}"), fxObservation);
  assert.equal(withoutFx.ok, true, "absent settlementFxRateId must stay optional");
  const junkFx = await parseJsonBody(rawRequest('{"settlementFxRateId":"garbage"}'), fxObservation);
  assert.equal(junkFx.ok, false, "junk settlementFxRateId must be refused");
  if (!junkFx.ok) {
    assert.equal(junkFx.response.status, 400);
    const payload = (await junkFx.response.json()) as { issues: { path: string; message: string }[] };
    assert.equal(payload.issues[0]?.path, "settlementFxRateId");
    assert.equal(payload.issues[0]?.message, "must be a valid id");
  }
});
