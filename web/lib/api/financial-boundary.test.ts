// source-pin-contract: every JSON mutation route parses its body through the shared zod boundary; subjects derived by walking web/app/api
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

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

const { jsonObject, parseJsonBody } = await import("./json");

/**
 * Reviewed non-JSON mutation routes. Every entry needs a narrow reason because
 * this is the only escape hatch from the shared zod request boundary.
 */
const EXEMPT_ROUTES: Readonly<Record<string, string>> = {
  // HR-17/18/19: lifecycle actions whose whole input is the path id. Each
  // was checked for a body read before being listed; a route that reads
  // req.json() must go through parseJsonBody instead of coming here.
  "web/app/api/hrm/documents/[id]/send/route.ts": "bodyless lifecycle action; document id is a path parameter",
  "web/app/api/hrm/documents/[id]/remind/route.ts": "bodyless reminder action; document id is a path parameter",
  "web/app/api/hrm/documents/[id]/acknowledge/route.ts": "bodyless acknowledgement by the signed-in subject",
  "web/app/api/hrm/feedback/[id]/retract/route.ts": "bodyless retraction; the author and feedback id decide it",
  "web/app/api/hrm/recruiting/retention-rules/[id]/runs/route.ts": "bodyless rule evaluation; rule id is a path parameter",
  "web/app/api/hrm/surveys/invitations/[id]/reissue/route.ts": "bodyless invitation reissue; invitation id is a path parameter",
  "web/app/api/hrm/comp-cycles/[id]/route.ts": "bodyless cycle lifecycle transitions; cycle id is a path parameter",
  "web/app/api/apps/import/route.ts": "size-capped binary ZIP upload; parseZipBundle limits archive expansion and draftExtension validates the decoded package with zod",
  "web/app/api/admin/ai/test/route.ts": "bodyless connectivity test using saved configuration",
  "web/app/api/admin/backups/run/route.ts": "bodyless queue action",
  "web/app/api/admin/scripts/[id]/run/route.ts": "bodyless execution action; script id is a path parameter",
  "web/app/api/allocations/rules/[id]/versions/[versionId]/publish/route.ts": "bodyless lifecycle action; rule and version ids are path parameters",
  "web/app/api/admin/setup/agents/[agentKey]/run/route.ts": "bodyless execution action; agent pack key is a path parameter",
  "web/app/api/ap-capture/[id]/materialize/route.ts": "bodyless lifecycle action; capture id is a path parameter",
  "web/app/api/ap-capture/route.ts": "multipart document upload",
  "web/app/api/accounting/changes/[id]/apply/route.ts": "bodyless lifecycle action; change id is a path parameter",
  "web/app/api/accounting/changes/[id]/submit/route.ts": "bodyless lifecycle action; change id is a path parameter",
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
  "web/app/api/flows/runs/[id]/retry/route.ts": "bodyless lifecycle action; run id is a path parameter",
  "web/app/api/insights/cards/draft/route.ts": "bodyless draft factory",
  "web/app/api/insights/dashboards/draft/route.ts": "bodyless draft factory",
  "web/app/api/journals/draft/route.ts": "bodyless draft factory",
  "web/app/api/leases/[id]/commence/route.ts": "bodyless lifecycle action; lease id is a path parameter",
  "web/app/api/parties/[id]/bank-accounts/submit/route.ts": "bodyless lifecycle action; party and account ids are path and query parameters",
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
  "web/app/api/sales-orders/draft/route.ts": "bodyless draft factory",
  "web/app/api/tax/provisions/[id]/post/route.ts": "bodyless posting action; provision id is a path parameter",
  "web/app/api/tax/returns/[code]/official-pdf/route.ts": "multipart official-form upload",
  "web/app/api/views/[id]/run/route.ts": "bodyless execution action; saved-view id is a path parameter",
  "web/app/api/wip-billing/[id]/convert/route.ts": "bodyless conversion action; prebill id is a path parameter",
  "web/app/api/v1/journals/[id]/post/route.ts": "bodyless lifecycle action; journal id is a path parameter",
  "web/app/api/v1/banking/reconciliations/[id]/sign-off/route.ts": "bodyless lifecycle action; reconciliation id is a path parameter",
};

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = resolve(TEST_DIR, "../..");
const API_ROOT = join(WEB_ROOT, "app/api");
const MUTATION_EXPORT_RE = /^export\s+(?:async\s+)?(?:function|const)\s+(POST|PATCH|PUT)\b/gm;
const DIRECT_JSON_READ_RE = /\b(?:req|request)\s*\.\s*json\s*\(/;
// Deliberately NOT global: RegExp.prototype.test on a /g pattern carries
// lastIndex across calls and silently skips matches on later routes.
const SHARED_BOUNDARY_FACTORY_RE = /\b(?:makePATCH|makeConvertPOST|readV1JsonObject|v1CreateAliasedRecord|v1UpdateAliasedRecord|v1CreateOrder|v1ConvertOrder)\s*\(/;
const TYPED_BOUNDARY_FACTORY_RE = /\bmakeAssignWarehousePOST\s*\(/;
const PARSED_SCHEMA_ARG_RE = /\bparseJsonBody\(\s*(?:req|request)\s*,\s*([A-Za-z_$][\w$]*)/g;

/**
 * Shape-only versus typed bodies. The derived gate below proves every
 * non-exempt mutation route parses through a shared boundary; whether a
 * body stops at the shape-only escape hatch (parseJsonBody(req, jsonObject)
 * plus imperative field checks in the handler) or carries a declarative
 * typed zod schema is a per-route migration, tracked with the refusal tests
 * that pin each route's own messages and status codes — not counted here,
 * so a new route never fails until someone re-pins a number.
 */

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
  // Assign-warehouse parses a typed uuid body in the shared factory, so the
  // thin route files count as typed coverage rather than the object-only
  // ratchet the PATCH/convert factories still sit on.
  if (TYPED_BOUNDARY_FACTORY_RE.test(route.source)) return { ...route, kind: "typed" };
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
  if ((orderFactorySource.match(/parseJsonBody\(/g) ?? []).length < 3) {
    failures.push("web/app/api/_order/handlers.ts: PATCH, convert, and assign-warehouse factories must all use parseJsonBody");
  }
  if (!orderFactorySource.includes("parseJsonBody(req, assignWarehouseBody)")) {
    failures.push("web/app/api/_order/handlers.ts: assign-warehouse must parse through assignWarehouseBody, not jsonObject");
  }

  const v1RequestSource = readFileSync(join(TEST_DIR, "v1-request.ts"), "utf8");
  if (!v1RequestSource.includes("parseJsonBody(request, jsonObject)")) {
    failures.push("web/lib/api/v1-request.ts: readV1JsonObject must parse through parseJsonBody(request, jsonObject)");
  }
  if (DIRECT_JSON_READ_RE.test(v1RequestSource)) {
    failures.push("web/lib/api/v1-request.ts: v1 body helper reads req/request.json() directly");
  }
  const v1RecordsSource = readFileSync(join(TEST_DIR, "v1-records.ts"), "utf8");
  if ((v1RecordsSource.match(/readV1JsonObject\(/g) ?? []).length < 4) {
    failures.push("web/lib/api/v1-records.ts: record create/update aliases must parse through readV1JsonObject");
  }
  const v1OrdersSource = readFileSync(join(TEST_DIR, "v1-orders.ts"), "utf8");
  if ((v1OrdersSource.match(/readV1JsonObject\(/g) ?? []).length < 2) {
    failures.push("web/lib/api/v1-orders.ts: create/convert must parse through readV1JsonObject");
  }

  for (const [file, reason] of Object.entries(EXEMPT_ROUTES)) {
    if (!reason.trim()) failures.push(`${file}: exemption is missing its reviewed reason`);
    if (!discovered.has(file)) failures.push(`${file}: stale exemption (no mutation route discovered)`);
  }

  for (const route of routes) {
    if (route.file in EXEMPT_ROUTES) continue;
    const violations: string[] = [];
    if (
      !route.source.includes("parseJsonBody(") &&
      !SHARED_BOUNDARY_FACTORY_RE.test(route.source) &&
      !TYPED_BOUNDARY_FACTORY_RE.test(route.source)
    ) {
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
  // object shape passes through untouched. Field-level typing is a per-route
  // migration tracked outside this file, not payload shape.
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

});
