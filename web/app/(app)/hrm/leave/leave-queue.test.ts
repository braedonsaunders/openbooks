import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";

// Behaviour contract for the leave desk (/hrm/leave). These tests CALL
// the queue loader with hand-built service rows and assert on what the
// page observes: refusal data for unknown segments and scope denials,
// exact per-segment counts and filtering, the requests/calendar view
// split, and dialog hrefs that keep the view. The seams below stub I/O
// only (feature switches, group tabs, the engine leave reads, the
// departments lookup, translations backed by the REAL en catalog). The
// refusal classes are the real engine errors — the authorization and
// leave-errors modules are deliberately unstubbed so the loader's
// instanceof catches share the class identity — and authz stubbing is
// the sanctioned seam, with permission logic proven by the existing
// scope DB tests, not doubled here.
const hrmCatalog = JSON.parse(
  readFileSync(new URL("../../../../messages/en/hrm.json", import.meta.url), "utf8"),
) as Record<string, unknown>;

(globalThis as Record<string, unknown>).__leaveQueueCatalogs = { hrm: hrmCatalog };

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    const parent = context.parentURL ?? "";
    const owned = parent.endsWith("/web/lib/hrm/leave.ts");
    if (owned && specifier === "next-intl/server") {
      return {
        shortCircuit: true,
        format: "module",
        url:
          "data:text/javascript," +
          encodeURIComponent(
            `export async function getTranslations(ns) {
              const catalogs = globalThis.__leaveQueueCatalogs;
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
    if (owned && specifier.endsWith("components/module-home/group-tabs")) {
      return {
        shortCircuit: true,
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
    if (owned && specifier === "@openbooks/engine/src/hrm/leave-read.ts") {
      return {
        shortCircuit: true,
        format: "module",
        url:
          "data:text/javascript," +
          encodeURIComponent(
            `export async function listOrgLeaveRequests() {
              const s = globalThis.__leaveQueueList;
              if (s && s.error) throw s.error;
              return { requests: (s && s.rows) || [], truncated: false };
            }
            export async function myLeaveRequests() { return []; }
            export async function listLeaveTypes() { return []; }
            export async function payrollBankBalances() { return []; }
            export async function timeBalanceAsOf() { return null; }`,
          ),
      };
    }
    if (owned && specifier === "@openbooks/engine/src/hrm/attendance.ts") {
      return {
        shortCircuit: true,
        format: "module",
        url:
          "data:text/javascript," +
          encodeURIComponent(
            `export async function employmentsOnLeave() {
              return (globalThis.__leaveQueueOnLeave || []);
            }
            export async function absenceCalendarForDepartment() { return []; }`,
          ),
      };
    }
    // The sibling change-request label lookup runs through the same stubbed
    // database client: with no labelled rows it resolves to the
    // not-available fallback, which these tests never assert on.
    if (
      (owned || parent.endsWith("/web/lib/hrm/change-requests.ts")) &&
      specifier === "@openbooks/engine/src/platform/db.ts"
    ) {
      return {
        shortCircuit: true,
        format: "module",
        url: "data:text/javascript,export const db = { execute: async () => ({ rows: [] }) };",
      };
    }
    return nextResolve(specifier, context);
  },
});

const { loadLeaveQueue } = await import("../../../../lib/hrm/leave.ts");
const { HrmAuthorizationError } = await import(
  "@openbooks/engine/src/hrm/authorization.ts"
);
const { LeaveError } = await import("@openbooks/engine/src/hrm/leave-errors.ts");

const gap = globalThis as Record<string, unknown>;

function authzWith(permissions: string[]) {
  return {
    user: { orgId: "org-leave", id: "actor-leave" },
    permissions: new Set(permissions),
    allowedSubsidiaryIds: null,
  } as never;
}

const HR_READER = authzWith(["hrm.leave.read", "hrm.leave.request", "hrm.leave.manage"]);

function stubReads(rows: Array<Record<string, unknown>> | { error: unknown }, onLeave: Array<Record<string, unknown>> = []) {
  gap.__leaveQueueList = Array.isArray(rows) ? { rows } : rows;
  gap.__leaveQueueOnLeave = onLeave;
}

function leaveRow(id: string, status: string, startsOn: string, endsOn: string): Record<string, unknown> {
  return {
    id,
    employmentId: "emp-1",
    workerPartyId: "party-1",
    leaveTypeId: "type-1",
    leaveTypeCode: "VAC",
    startsOn,
    endsOn,
    hours: "8",
    reason: null,
    status,
    decidedBy: null,
    decidedAt: null,
    decisionReason: null,
  };
}

test("an unknown segment refuses naming the segment, never an empty table", async () => {
  stubReads([]);
  const data = await loadLeaveQueue(HR_READER, { segment: "bogus" });
  assert.ok(data.refusal, "the refusal travels as data the page renders");
  assert.equal(data.refusal.title, "Unknown segment", "the refusal carries the catalogued title");
  assert.ok(data.refusal.message.includes("bogus"), "the refusal names the segment the URL asked for");
  assert.equal(data.hasContent, false, "no rows render beside the refusal");
  assert.deepEqual(data.rows, [], "no rows leak through a refused segment");
});

test("the queue counts per segment and filters to the active one", async () => {
  stubReads(
    [
      leaveRow("lr-pending", "submitted", "2026-10-20", "2026-10-21"),
      leaveRow("lr-upcoming", "approved", "2026-10-20", "2026-10-21"),
      leaveRow("lr-history", "approved", "2026-09-01", "2026-09-02"),
    ],
    [{ employmentId: "emp-9" }],
  );
  const all = await loadLeaveQueue(HR_READER, {});
  assert.equal(all.refusal, null, "a known state carries no refusal");
  assert.deepEqual(
    all.counts,
    { pending: 1, upcoming: 1, today: 1, history: 1 },
    "on-leave-today counts absence fact, not request state",
  );
  assert.equal(all.total, 3, "the total counts listed requests");
  assert.equal(all.rows.length, 3, "no segment shows every row");

  const pending = await loadLeaveQueue(HR_READER, { segment: "pending" });
  assert.deepEqual(
    pending.rows.map((row) => row.id),
    ["lr-pending"],
    "the pending segment shows submitted requests only",
  );
  const row = pending.rows[0]!;
  assert.equal(row.rangeLabel, "2026-10-20 → 2026-10-21", "the range renders verbatim, never through Date");
  assert.equal(row.statusVariant, "warning", "the loader resolves the badge variant");
  assert.ok(row.requestHref.includes("request=lr-pending"), "each row opens its own request");
});

test("a subsidiary-scope denial refuses with the remedy, never a partial list", async () => {
  const remedy = "a role restricted to specific subsidiaries cannot read the org-wide leave queue — ask an administrator for access";
  stubReads({ error: new HrmAuthorizationError(remedy) });
  const data = await loadLeaveQueue(HR_READER, {});
  assert.ok(data.refusal, "the denial travels as data");
  assert.equal(data.refusal.message, remedy, "the remedy arrives verbatim");
  assert.deepEqual(data.rows, [], "no partial list pretends to be the whole queue");
  assert.equal(data.hasContent, false, "the table suppresses while refused");
});

test("a leave-domain refusal converts the same way an authorization one does", async () => {
  stubReads({ error: new LeaveError("REFUSED", "this login is not linked to a person record") });
  const data = await loadLeaveQueue(HR_READER, {});
  assert.ok(data.refusal, "the domain refusal travels as data");
  assert.ok(data.refusal.message.includes("not linked"), "the remedy arrives intact");
});

test("requests and the department calendar are alternative views, never stacked", async () => {
  stubReads([]);
  const requests = await loadLeaveQueue(HR_READER, {});
  assert.equal(requests.view, "requests", "the list is the default view");
  assert.equal(requests.onRequests, true, "the requests table renders on its own tab");
  assert.equal(requests.onCalendar, false, "the calendar stays off the requests tab");

  const calendar = await loadLeaveQueue(HR_READER, { view: "calendar" });
  assert.equal(calendar.view, "calendar", "the calendar is its own view");
  assert.equal(calendar.onRequests, false, "the requests table stays off the calendar tab");
  assert.equal(calendar.onCalendar, true, "the calendar renders on its own tab");
  assert.ok(calendar.fileHref.includes("view=calendar"), "filing from the calendar closes back onto it");
  assert.ok(requests.fileHref.includes("file=1"), "filing opens through the file param");
  assert.ok(!requests.fileHref.includes("view="), "the requests view adds no view param");
});

test("an unexpected system failure propagates instead of an empty queue", async () => {
  stubReads({ error: new TypeError("connection terminated") });
  await assert.rejects(
    loadLeaveQueue(HR_READER, {}),
    /connection terminated/,
    "the failure reaches the caller, never a null list",
  );
});
