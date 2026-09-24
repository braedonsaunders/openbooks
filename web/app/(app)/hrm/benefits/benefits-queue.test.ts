import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";

// Behaviour contract for the benefits desk (/hrm/benefits). These tests
// CALL the benefits loader with hand-built service rows and assert on
// what the page observes: refusal data for an unknown segment, exact
// per-status counts on the windows view, and the enrolments view swap
// (a different entity, not a status). Seams stub I/O only (group and
// rewards tabs, the engine benefits reads, the departments lookup,
// translations backed by the REAL en catalog). Authz stubbing is the
// sanctioned seam, with permission logic proven by the existing scope DB
// tests, not doubled here.
const hrmCatalog = JSON.parse(
  readFileSync(new URL("../../../../messages/en/hrm.json", import.meta.url), "utf8"),
) as Record<string, unknown>;

(globalThis as Record<string, unknown>).__benefitsCatalogs = { hrm: hrmCatalog };

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    const parent = context.parentURL ?? "";
    const owned =
      parent.endsWith("/web/lib/hrm/benefits.ts") ||
      parent.endsWith("/web/lib/hrm/workspace-tabs.ts") ||
      parent.endsWith("/web/lib/hrm/change-requests.ts");
    if (owned && specifier === "next-intl/server") {
      return {
        shortCircuit: true,
        format: "module",
        url:
          "data:text/javascript," +
          encodeURIComponent(
            `export async function getLocale() { return 'en'; }
             export async function getTranslations(ns) {
              const catalogs = globalThis.__benefitsCatalogs;
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
    if (
      specifier === "../features" ||
      specifier.endsWith("/lib/features") ||
      specifier === "./features"
    ) {
      return {
        shortCircuit: true,
        format: "module",
        url:
          "data:text/javascript," +
          encodeURIComponent(
            `export async function isFeatureEnabled() { return true; }
             export async function requireFeatureEnabled() {}
             export async function subsidiaryFeatureEnabled() { return false; }`,
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
    if (owned && specifier === "@openbooks/engine/src/platform/business-date.ts") {
      return {
        shortCircuit: true,
        format: "module",
        url: "data:text/javascript,export async function businessToday() { return '2026-09-22'; } export function utcDateFromParts() { throw new Error('unstubbed'); }",
      };
    }
    if (owned && specifier === "@openbooks/engine/src/hrm/benefits/benefits-read.ts") {
      return {
        shortCircuit: true,
        format: "module",
        url:
          "data:text/javascript," +
          encodeURIComponent(
            `export async function listEnrollmentWindows(db, orgId, actorId, filter) {
              const s = globalThis.__benefitsReads;
              const windows = (s && s.windows) || [];
              if (filter && filter.status) return windows.filter((w) => w.status === filter.status);
              return windows;
            }
            export async function listEnrollments() {
              const s = globalThis.__benefitsReads;
              return (s && s.enrolments) || [];
            }
            export async function benefitsCockpit() {
              return { openWindows: [], pendingCount: 0, missingCount: 0 };
            }`,
          ),
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

const { loadBenefits } = await import("../../../../lib/hrm/benefits.ts");

const gap = globalThis as Record<string, unknown>;

function authzWith(permissions: string[]) {
  return {
    user: { orgId: "org-benefits", id: "actor-benefits" },
    permissions: new Set(permissions),
    allowedSubsidiaryIds: null,
  } as never;
}

const HR_BENEFITS = authzWith(["hrm.benefits.read", "hrm.benefits.manage"]);

function stubReads(windows: Array<Record<string, unknown>>, enrolments: Array<Record<string, unknown>>) {
  gap.__benefitsReads = { windows, enrolments };
}

function windowRow(id: string, status: string): Record<string, unknown> {
  return { id, kind: "annual", status, opensOn: "2026-11-01", closesOn: "2026-11-30" };
}

function enrolmentRow(id: string, windowId: string): Record<string, unknown> {
  return { id, windowId, employmentId: "emp-1", employeeName: "Ada", status: "elected" };
}

test("an unknown segment refuses naming the segment, never an empty table", async () => {
  stubReads([], []);
  const data = await loadBenefits(HR_BENEFITS, { segment: "enrolments" });
  assert.ok(data.refusal, "the refusal travels as data the page renders");
  assert.ok(data.refusal.message.includes("enrolments"), "the refusal names the rejected value");
  assert.equal(data.hasContent, false, "no rows render beside the refusal");
  assert.equal(data.showingEnrolments, false, "a refused segment shows neither view");
});

test("the windows view binds rows with exact per-status counts", async () => {
  stubReads(
    [windowRow("w-open", "open"), windowRow("w-draft", "draft"), windowRow("w-closed", "closed")],
    [enrolmentRow("e-1", "w-open")],
  );
  const data = await loadBenefits(HR_BENEFITS, {});
  assert.equal(data.refusal, null, "the windows view carries no refusal");
  assert.equal(data.showingEnrolments, false, "windows are the default view");
  assert.deepEqual(
    data.segments.map((segment) => [segment.value, segment.count]),
    [["all", 3], ["open", 1], ["draft", 1], ["closed", 1]],
    "enrolments never leak into the status counts",
  );
  assert.equal(data.windowRows.length, 3, "every window lists");
  const open = data.windowRows[0]!;
  assert.equal(open.rangeLabel, "2026-11-01 – 2026-11-30", "the range renders verbatim");
  assert.ok(open.windowHref.includes("window=w-open"), "each window opens its own drawer");
});

test("the enrolments view swaps the table for the other entity", async () => {
  stubReads([windowRow("w-open", "open")], [enrolmentRow("e-1", "w-open")]);
  const data = await loadBenefits(HR_BENEFITS, { view: "enrolments" });
  assert.equal(data.refusal, null, "the enrolments view carries no refusal");
  assert.equal(data.showingEnrolments, true, "the view flag swaps the table");
  assert.equal(data.enrollmentRows.length, 1, "enrolments list on their own view");
  assert.equal(data.enrollmentRows[0]!.employeeLabel, "Ada", "rows resolve the employee name");
  assert.ok(data.newWindowHref.includes("view=enrolments"), "dialogs opened from the view close back onto it");
});

test("the benefits copy ships with translated statuses in every section", () => {
  const catalog = JSON.parse(
    readFileSync(new URL("../../../../messages/en/hrm.json", import.meta.url), "utf8"),
  ) as {
    benefits: {
      title: string;
      windowsTitle: string;
      enrolmentsTitle: string;
      segments: { open: string; draft: string; closed: string };
    };
  };
  assert.ok(catalog.benefits.title.length > 0, "the page title resolves from the catalog");
  assert.ok(catalog.benefits.windowsTitle.length > 0, "the windows view resolves its own title");
  assert.ok(catalog.benefits.enrolmentsTitle.length > 0, "the enrolments view resolves a different title");
  for (const status of ["open", "draft", "closed"] as const) {
    assert.ok(
      catalog.benefits.segments[status].length > 0,
      `the ${status} segment resolves its own label, never a bare status code`,
    );
  }
});
