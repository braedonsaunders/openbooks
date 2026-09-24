import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";

// Behaviour contract for the change-request queue (/hrm/change-requests).
// These tests CALL the queue loader and the pure segment mapping with
// hand-built inputs and assert on what the page observes: refusal data
// for unknown segments and scope denials, exact per-segment counts, and
// segment filtering. The seams below stub I/O only (feature switches,
// group tabs, the engine list read, the departments lookup, translations
// backed by the REAL en catalog). The refusal classes are the real engine
// errors, and authz stubbing is the sanctioned seam — permission logic
// itself is proven by the existing scope DB tests, not doubled here.
const hrmCatalog = JSON.parse(
  readFileSync(new URL("../../../../messages/en/hrm.json", import.meta.url), "utf8"),
) as Record<string, unknown>;

function lookup(key: string): string {
  let node: unknown = hrmCatalog;
  for (const part of key.split(".")) {
    if (node !== null && typeof node === "object") node = (node as Record<string, unknown>)[part];
    else return key;
  }
  return typeof node === "string" ? node : key;
}

(globalThis as Record<string, unknown>).__queueCatalogs = { hrm: hrmCatalog };

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    const parent = context.parentURL ?? "";
    const owned = parent.endsWith("/web/lib/hrm/change-requests.ts");
    if (owned && specifier === "next-intl/server") {
      return {
        shortCircuit: true,
        format: "module",
        url:
          "data:text/javascript," +
          encodeURIComponent(
            `export async function getTranslations(ns) {
              const catalogs = globalThis.__queueCatalogs;
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
            `export async function isFeatureEnabled(orgId, key) {
              const flags = globalThis.__queueFeatures;
              if (flags && key in flags) return flags[key];
              return true;
            }
            export async function requireFeatureEnabled() {}`,
          ),
      };
    }
    if (owned && specifier.endsWith("components/module-home/group-tabs")) {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export async function hrmGroupTabs() { return []; }",
      };
    }
    if (owned && specifier === "@openbooks/engine/src/hrm/change-requests.ts") {
      return {
        shortCircuit: true,
        format: "module",
        url:
          "data:text/javascript," +
          encodeURIComponent(
            `export async function listChangeRequests() {
              const s = globalThis.__queueList;
              if (s && s.error) throw s.error;
              return (s && s.rows) || [];
            }
            export class HrmChangeRequestError extends Error {}`,
          ),
      };
    }
    // The authorization module is NOT stubbed: it is side-effect-free, so
    // the loader and these tests share the real HrmAuthorizationError and
    // the loader's instanceof catch keeps working. Stubbing an error-class
    // module would split the class identity and every refusal test would
    // see the error propagate instead of converting to data.
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
const { resolveQueueStatus, segmentOfServiceStatus } = await import(
  "../../../../lib/hrm/queue-status.ts"
);
const { HrmAuthorizationError } = await import(
  "@openbooks/engine/src/hrm/authorization.ts"
);

const gap = globalThis as Record<string, unknown>;

function authzWith(permissions: string[]) {
  return {
    user: { orgId: "org-queue", id: "actor-queue" },
    permissions: new Set(permissions),
    allowedSubsidiaryIds: null,
  } as never;
}

const HR_ADMIN = authzWith(["hrm.employment.read", "hrm.employment.manage"]);

function stubList(rows: Array<Record<string, unknown>> | { error: unknown }) {
  gap.__queueList = Array.isArray(rows) ? { rows } : rows;
}

function serviceRow(id: string, status: string): Record<string, unknown> {
  return {
    id,
    employmentId: "emp-1",
    payload: { kind: "hire", status: "active", effectiveFrom: "2026-09-01" },
    status,
    submittedBy: null,
    createdBy: "actor-queue",
    submittedAt: null,
    createdAt: new Date("2026-08-20T10:00:00.000Z"),
    appliedEmploymentChangeId: null,
  };
}

test("an unknown segment refuses naming the five segments, never a silent All", async () => {
  stubList([]);
  const data = await loadChangeRequestQueue(HR_ADMIN, { status: "bogus" });
  assert.ok(data.refusal, "the refusal travels as data the page renders");
  assert.equal(data.refusal.title, lookup("queue.refusalTitle"), "the refusal carries the catalogued title");
  assert.ok(
    data.refusal.message.includes("bogus"),
    "the refusal names the segment the URL asked for",
  );
  for (const segment of ["draft", "submitted", "approved", "rejected", "withdrawn"]) {
    assert.ok(data.refusal.message.includes(segment), `the refusal names the valid ${segment} segment`);
  }
  assert.equal(data.hasContent, false, "no rows render beside the refusal");
  assert.deepEqual(data.rows, [], "no rows leak through a refused segment");
});

test("an absent segment lists every request with exact per-segment counts", async () => {
  stubList([
    serviceRow("cr-draft", "draft"),
    serviceRow("cr-pending-1", "pending_approval"),
    serviceRow("cr-pending-2", "pending_approval"),
    serviceRow("cr-approved", "approved"),
    serviceRow("cr-applied", "applied"),
  ]);
  const data = await loadChangeRequestQueue(HR_ADMIN, {});
  assert.equal(data.refusal, null, "All carries no refusal");
  assert.equal(data.hasContent, true, "the list renders");
  assert.equal(data.total, 5, "applied rows count toward the total under All");
  assert.deepEqual(
    data.counts,
    { draft: 1, submitted: 2, approved: 1, rejected: 0, withdrawn: 0 },
    "applied belongs to no segment, so the segment counts stay exact",
  );
  assert.equal(data.rows.length, 5, "All shows every service row, applied included");
  const submitted = data.segments.find((segment) => segment.value === "submitted");
  assert.ok(submitted?.label.includes("(2)"), "the segment label carries its count");
});

test("the submitted segment shows pending approvals only", async () => {
  stubList([
    serviceRow("cr-draft", "draft"),
    serviceRow("cr-pending-1", "pending_approval"),
    serviceRow("cr-pending-2", "pending_approval"),
  ]);
  const data = await loadChangeRequestQueue(HR_ADMIN, { status: "submitted" });
  assert.equal(data.refusal, null, "a known segment carries no refusal");
  assert.deepEqual(
    data.rows.map((row) => row.id),
    ["cr-pending-1", "cr-pending-2"],
    "submitted names pending_approval, never drafts",
  );
});

test("a subsidiary-scope denial refuses with the remedy, never a partial list", async () => {
  const remedy = "a role restricted to specific subsidiaries cannot read the org-wide queue — ask an administrator for access";
  stubList({ error: new HrmAuthorizationError(remedy) });
  const data = await loadChangeRequestQueue(HR_ADMIN, {});
  assert.ok(data.refusal, "the denial travels as data");
  assert.equal(data.refusal.message, remedy, "the remedy arrives verbatim");
  assert.deepEqual(data.rows, [], "no partial list pretends to be the whole queue");
  assert.equal(data.hasContent, false, "the table suppresses while refused");
});

test("an unexpected system failure propagates instead of an empty queue", async () => {
  stubList({ error: new TypeError("connection terminated") });
  await assert.rejects(
    loadChangeRequestQueue(HR_ADMIN, {}),
    /connection terminated/,
    "the failure reaches the caller, never a null list",
  );
});

test("the segment mapping leaves applied to All and refuses anything else", () => {
  assert.deepEqual(resolveQueueStatus(null), { ok: true, segment: null, serviceStatus: null }, "absent means All");
  assert.deepEqual(
    resolveQueueStatus("submitted"),
    { ok: true, segment: "submitted", serviceStatus: "pending_approval" },
    "submitted filters the pending state",
  );
  assert.equal(segmentOfServiceStatus("applied"), null, "an applied request counts toward no segment");
  const refused = resolveQueueStatus("applied");
  assert.equal(refused.ok, false, "applied is not a segment");
  if (!refused.ok) {
    assert.equal(refused.refusal.code, "UNKNOWN_QUEUE_STATUS", "the refusal is coded");
    assert.ok(refused.refusal.message.includes("applied"), "the refusal names the rejected value");
  }
});
