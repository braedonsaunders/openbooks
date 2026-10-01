import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";

// /hrm/change-requests?reasons=1, Reason codes → New navigated to
// ?reasons=1&row=new and nothing opened — the queue loader built
// currentParams with `status` only, dropping sp.row, so the embedded
// setup-section widget received no rowParam and SetupDrawer never
// rendered. An empty org could not configure a reason code through the
// UI, and change-request submit (correctly) refuses a missing
// action/reason.
//
// The seams below stub I/O only (the page's feature gate, group tabs, engine
// list reads, the departments lookup, translations backed by the REAL
// en catalog). Grants ride a fabricated Authz through the stubbed `can`
// permission logic itself is proven by the existing scope DB tests,
// not doubled here.
const hrmCatalog = JSON.parse(
  readFileSync(new URL("../../../../messages/en/hrm.json", import.meta.url), "utf8"),
) as Record<string, unknown>;

(globalThis as Record<string, unknown>).__reasonsCatalogs = { hrm: hrmCatalog };

registerHooks({
  resolve(specifier, context, nextResolve) {

    const parent = context.parentURL ?? "";
    const owned =
      parent.endsWith("/web/lib/hrm/change-requests.ts") || parent.endsWith("/hrm/change-requests/view.ts");
    if (owned && specifier === "next-intl/server") {
      return {
        shortCircuit: true,
        format: "module",
        url:
          "data:text/javascript," +
          encodeURIComponent(
            `export async function getTranslations(ns) {
              const catalogs = globalThis.__reasonsCatalogs;
              const catalog = catalogs[ns] ?? {};
              const lookup = (key) => {
                let node = catalog;
                for (const part of key.split('.')) {
                  if (node !== null && typeof node === 'object') node = node[part];
                  else return key;
                }
                return typeof node === 'string' ? node : key;
              };
              const t = (key, params) => {
                const template = lookup(key);
                if (!params) return template;
                return template.replace(/\\{(\\w+)\\}/g, (_, name) => (params[name] === undefined ? '{' + name + '}' : String(params[name])));
              };
              t.has = (key) => lookup(key) !== key;
              return t;
            }`,
          ),
      };
    }
    if (owned && (specifier === "../authz" || specifier.endsWith("/lib/authz"))) {
      return {
        shortCircuit: true,
        format: "module",
        url:
          "data:text/javascript," +
          encodeURIComponent(
            `export const can = (authz, perm) => authz.permissions.has('*') || authz.permissions.has(perm);
             export async function requirePermission() { throw new Error('stubbed requirePermission must not run here'); }
             export async function getAuthz() { return null; }`,
          ),
      };
    }
    if (owned && (specifier === "../features" || specifier === "../feature-gates" || specifier.endsWith("/lib/features") || specifier.endsWith("/lib/feature-gates"))) {
      return {
        shortCircuit: true,
        format: "module",
        url:
          "data:text/javascript," +
          encodeURIComponent(
            `export async function isFeatureEnabled() { return true; }
            export async function requireFeatureEnabled() {}`,
          ),
      };
    }
    if (owned && specifier.endsWith("components/module-home/group-tabs")) {
      return {
        shortCircuit: true,
        format: "module",
        url: "data:text/javascript,export async function hrmGroupTabs() { return []; }",
      };
    }
    if (owned && specifier === "@openbooks/engine/src/hrm/change-requests.ts") {
      return {
        shortCircuit: true,
        format: "module",
        url: "data:text/javascript,export async function listChangeRequests() { return []; } export class HrmChangeRequestError extends Error {}",
      };
    }
    if (owned && specifier === "@openbooks/engine/src/hrm/authorization.ts") {
      return {
        shortCircuit: true,
        format: "module",
        url: "data:text/javascript,export class HrmAuthorizationError extends Error {}",
      };
    }
    if (owned && specifier === "@openbooks/engine/src/platform/db.ts") {
      return {
        shortCircuit: true,
        format: "module",
        url: "data:text/javascript,export const db = { execute: async () => ({ rows: [] }) };",
      };
    }
    return nextResolve(specifier, context);
  },
});

const { loadChangeRequestQueue } = await import("../../../../lib/hrm/change-requests.ts");

function authzWith(permissions: string[]) {
  return {
    user: { orgId: "org-reasons", id: "actor-reasons" },
    permissions: new Set(permissions),
    allowedSubsidiaryIds: null,
  } as never;
}

const HR_ADMIN = authzWith(["hrm.employment.read", "hrm.employment.manage"]);

test("?reasons=1&row=new forwards row into the embedded setup section", async () => {
  const data = await loadChangeRequestQueue(HR_ADMIN, {
    status: "submitted",
    reasons: "1",
    row: "new",
    q: "merit",
    showInactive: "true",
    f_action: "promotion",
  });
  assert.equal(data.showReasons, true, "the reasons section renders");
  const params = data.currentParams as Record<string, unknown>;
  assert.equal(params.row, "new", "the loader forwards sp.row so the setup section's New drawer opens");
  assert.equal(params.reasons, "1", "the loader keeps the host gate param so setup links stay inside the section");
  assert.equal(params.status, "submitted", "the queue segment still rides along");
  assert.equal(params.q, "merit", "the section's search term survives the host page");
  assert.equal(params.showInactive, "true", "the section's inactive toggle survives the host page");
  assert.equal(params.f_action, "promotion", "the section's enum filter survives the host page");
  assert.equal(params.request, undefined, "dialog params never leak into the section's links");
  assert.equal(params.propose, undefined, "dialog params never leak into the section's links");
});

test("?reasons=1&row=<id> forwards the edit row the same way", async () => {
  const data = await loadChangeRequestQueue(HR_ADMIN, { reasons: "1", row: "some-uuid" });
  assert.equal(data.showReasons, true, "the reasons section renders");
  assert.equal(
    (data.currentParams as Record<string, unknown>).row,
    "some-uuid",
    "the loader forwards an edit row id, not just 'new'",
  );
});

test("the queue spec hands the forwarded params to the setup-section widget", async () => {
  const { changeRequestQueueSpec } = await import("./view.ts");
  const data = await loadChangeRequestQueue(HR_ADMIN, { reasons: "1", row: "new" });
  const spec = changeRequestQueueSpec(data);
  const blocks = (spec as { body: Array<{ widget?: string; props?: { sp?: unknown } }> }).body;
  const setup = blocks.filter((block) => block.widget === "setup-section");
  assert.equal(setup.length, 1, "the reasons section mounts exactly one setup-section widget");
  assert.deepEqual(
    (setup[0]?.props?.sp as Record<string, unknown> | undefined)?.row,
    "new",
    "?reasons=1&row=new yields a setup section with the New drawer open",
  );
});


test("the queue uses one shared list toolbar without a second titled panel or tab strip", async () => {
  const { changeRequestQueueSpec } = await import("./view.ts");
  const data = await loadChangeRequestQueue(HR_ADMIN, {});
  const spec = changeRequestQueueSpec(data);
  assert.equal(spec.layout, "list");
  assert.ok(!spec.body.some((block) => block.kind === "panel"));
  const list = spec.body.find((block) => block.kind === "widget" && block.widget === "registered-record-list");
  assert.ok(list && list.kind === "widget", "the collection renders directly through the shared list");
  assert.equal(list.props?.source, "hrm_change_requests");
  const toolbar = list.props?.toolbar as Array<{ widget: string; props: { filters: unknown[] } }>;
  assert.equal(toolbar.length, 1);
  assert.equal(toolbar[0]?.widget, "list-toolbar");
  assert.deepEqual(toolbar[0]?.props.filters, [{
    paramKey: "status", label: data.segmentsLabel, allLabel: data.allLabel, options: data.segments,
  }]);
  const header = spec.header[0];
  assert.ok(header?.kind === "page-header");
  assert.ok(!header.actions?.some((action) => action.widget === "module-home-tabs"), "the shared page layout owns the sibling tabs");
});
