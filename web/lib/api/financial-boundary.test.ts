import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

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
const SHARED_BOUNDARY_FACTORY_RE = /\b(?:makePATCH|makeConvertPOST)\s*\(/;

interface MutationRoute {
  file: string;
  methods: string[];
  source: string;
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

test("every JSON mutation route parses its body through the shared zod boundary", () => {
  const routes = routeFiles(API_ROOT)
    .map(mutationRoute)
    .filter((route): route is MutationRoute => route !== null);
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

test("payment posting preserves provider FX evidence through its request boundary", () => {
  const routeSource = readFileSync(
    join(API_ROOT, "payments/post-with-applications/route.ts"),
    "utf8",
  );
  const allocationStart = routeSource.indexOf("const allocationInput = z.object({");
  const bodyStart = routeSource.indexOf("const postWithApplicationsBody", allocationStart);

  assert.notEqual(allocationStart, -1, "payment posting allocation boundary is missing");
  assert.notEqual(bodyStart, -1, "payment posting body boundary is missing");
  assert.match(
    routeSource.slice(allocationStart, bodyStart),
    /settlementFxRateId:\s*nullableUuidId\.optional\(\)/,
    "payment posting must retain the tenant-owned provider FX observation id",
  );
});
