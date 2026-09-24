import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";
import { pathToFileURL } from "node:url";

// Behaviour contract for the self-service leave inbox (/hrm/my-leave).
// These tests CALL the my-leave loader with a stubbed engine read and
// assert on what the employee observes: only their own requests, a
// domain refusal as data, filing and dialog hrefs, and — like the org
// queue beside it — an unexpected system failure that propagates instead
// of an empty inbox. Seams stub I/O only (group tabs, the engine reads,
// the departments lookup, translations backed by the REAL en catalog).
// The refusal classes are the real engine errors — the authorization and
// leave-errors modules are deliberately unstubbed so the loader's
// instanceof catches share the class identity.
const hrmCatalog = JSON.parse(
  readFileSync(new URL("../../../../messages/en/hrm.json", import.meta.url), "utf8"),
) as Record<string, unknown>;

(globalThis as Record<string, unknown>).__myLeaveCatalogs = { hrm: hrmCatalog };

// Absolute file URL of the real authorization module, so the stub below
// can re-export its error class instead of splitting the identity.
const engineAuthorizationUrl = pathToFileURL(`${process.cwd()}/engine/src/hrm/authorization.ts`).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    const parent = context.parentURL ?? "";
    const owned =
      parent.endsWith("/web/lib/hrm/leave.ts") ||
      parent.endsWith("/web/lib/hrm/change-requests.ts");
    if (owned && specifier === "next-intl/server") {
      return {
        shortCircuit: true,
        format: "module",
        url:
          "data:text/javascript," +
          encodeURIComponent(
            `export async function getTranslations(ns) {
              const catalogs = globalThis.__myLeaveCatalogs;
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
            `export async function myLeaveRequests(args) {
              const s = globalThis.__myLeaveInbox;
              (globalThis.__myLeaveArgs = globalThis.__myLeaveArgs || []).push(args);
              if (s && s.error) throw s.error;
              return (s && s.rows) || [];
            }
            export async function listOrgLeaveRequests() { return { requests: [], truncated: false }; }
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
            `export async function employmentsOnLeave() { return []; }
            export async function absenceCalendarForDepartment() { return []; }`,
          ),
      };
    }
    // The authorization module keeps the REAL HrmAuthorizationError (the
    // loader's instanceof catch must share the class identity) while the
    // identity lookup itself resolves to no employments: the real lookup
    // would refuse against the stubbed database, which these tests never
    // exercise — identity refusal stays covered by the engine scope tests.
    if (owned && specifier === "@openbooks/engine/src/hrm/authorization.ts") {
      return {
        shortCircuit: true,
        format: "module",
        url:
          "data:text/javascript," +
          encodeURIComponent(
            `export { HrmAuthorizationError } from ${JSON.stringify(engineAuthorizationUrl)};
             export async function loadOwnEmploymentIds() { return []; }`,
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

const { loadMyLeave } = await import("../../../../lib/hrm/leave.ts");
const { LeaveError } = await import("@openbooks/engine/src/hrm/leave-errors.ts");

const gap = globalThis as Record<string, unknown>;

function authzWith() {
  return {
    user: { orgId: "org-mine", id: "actor-mine" },
    permissions: new Set(["hrm.leave.request"]),
    allowedSubsidiaryIds: null,
  } as never;
}

function stubInbox(rows: Array<Record<string, unknown>> | { error: unknown }) {
  gap.__myLeaveInbox = Array.isArray(rows) ? { rows } : rows;
  gap.__myLeaveArgs = [];
}

function leaveRow(id: string, status: string): Record<string, unknown> {
  return {
    id,
    employmentId: "emp-mine",
    workerPartyId: "party-mine",
    leaveTypeId: "type-1",
    leaveTypeCode: "VAC",
    startsOn: "2026-10-20",
    endsOn: "2026-10-21",
    hours: "8",
    reason: null,
    status,
    decidedBy: null,
    decidedAt: null,
    decisionReason: null,
  };
}

test("the inbox lists the caller's own requests through the shared primitives", async () => {
  stubInbox([leaveRow("lr-mine", "submitted")]);
  const data = await loadMyLeave(authzWith(), {});
  const args = (gap.__myLeaveArgs as Array<Record<string, unknown>>) ?? [];
  assert.deepEqual(args, [{ orgId: "org-mine", actorId: "actor-mine" }], "the read scopes to the login, never the org");
  assert.equal(data.refusal, null, "a readable inbox carries no refusal");
  assert.equal(data.hasContent, true, "the inbox renders");
  assert.equal(data.requests.length, 1, "only the caller's requests list");
  const row = data.requests[0]!;
  assert.equal(row.rangeLabel, "2026-10-20 → 2026-10-21", "the range renders verbatim, never through Date");
  assert.equal(row.statusVariant, "warning", "the loader resolves the badge variant");
  assert.ok(row.requestHref.includes("request=lr-mine"), "each row opens its own request");
  assert.equal(row.employeeLabel, "Not available", "unlabelled rows name the fallback, never an id");
});

test("a leave-domain refusal converts to data, never a thrown page", async () => {
  stubInbox({ error: new LeaveError("REFUSED", "this login is not linked to a person record") });
  const data = await loadMyLeave(authzWith(), {});
  assert.ok(data.refusal, "the refusal travels as data");
  assert.ok(data.refusal.message.includes("not linked"), "the remedy arrives intact");
  assert.deepEqual(data.requests, [], "no requests render beside the refusal");
});

test("an unexpected system failure propagates instead of an empty inbox", async () => {
  stubInbox({ error: new TypeError("connection terminated") });
  await assert.rejects(
    loadMyLeave(authzWith(), {}),
    /connection terminated/,
    "the failure reaches the caller, never a null list",
  );
});

test("filing opens through the file param and a request opens its dialog", async () => {
  stubInbox([]);
  const filing = await loadMyLeave(authzWith(), { file: "1" });
  assert.equal(filing.dialogOpen, true, "file=1 opens the filing dialog");
  assert.equal(filing.dialogRequestId, null, "filing opens no request beside it");
  assert.ok(filing.fileHref.includes("file=1"), "the file button targets the file param");

  const viewing = await loadMyLeave(authzWith(), { request: "lr-mine" });
  assert.equal(viewing.dialogOpen, true, "request=<id> opens the request dialog");
  assert.equal(viewing.dialogRequestId, "lr-mine", "the dialog resolves the request it was asked for");
  assert.equal(viewing.dialogCloseHref, "/hrm/my-leave", "the dialog closes back onto the inbox");
});
