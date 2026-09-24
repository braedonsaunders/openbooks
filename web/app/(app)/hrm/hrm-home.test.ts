import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";
import { pathToFileURL } from "node:url";

// Behaviour contract for the HRM cockpit (/hrm). The pure civil-date
// heart is tested with hand-computed month ends; the spec builder is
// tested with hand-built data asserting panel order, activity gating,
// the vitals strip, and refusal delivery in its OUTPUT; and the loader
// is called with stubbed reads asserting headline figures bind and every
// raw-SQL leg carries the org predicate. Seams stub I/O only (feature
// switches, group tabs, the engine reads, translations backed by the
// REAL hrm/nav catalogs, a capturing database client). The clock is the
// real injectable engine clock pinned to 2026-09-22, so businessToday runs
// its real zone lookup against a UTC org row. The refusal
// classes are the real engine errors — authorization and leave-errors
// are never stubbed — and the sibling panel loaders run REAL against
// the stubbed engine reads; they short-circuit to null here because the
// session holds no subordinate grant, which is itself asserted.
const hrmCatalog = JSON.parse(
  readFileSync(new URL("../../../messages/en/hrm.json", import.meta.url), "utf8"),
) as Record<string, unknown>;
const navCatalog = JSON.parse(
  readFileSync(new URL("../../../messages/en/nav.json", import.meta.url), "utf8"),
) as Record<string, unknown>;

(globalThis as Record<string, unknown>).__homeCatalogs = { hrm: hrmCatalog, nav: navCatalog };

const engineSubsidiariesUrl = pathToFileURL(`${process.cwd()}/web/lib/subsidiaries.ts`).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    const parent = context.parentURL ?? "";
    const owned =
      parent.endsWith("/web/lib/hrm/home.ts") ||
      parent.endsWith("/web/lib/hrm/leave.ts") ||
      parent.endsWith("/web/lib/hrm/benefits.ts") ||
      parent.endsWith("/web/lib/hrm/qualifications.ts") ||
      parent.endsWith("/web/lib/hrm/change-requests.ts") ||
      parent.endsWith("/web/app/(app)/hrm/view.ts");
    if (owned && specifier === "next-intl/server") {
      return {
        shortCircuit: true,
        format: "module",
        url:
          "data:text/javascript," +
          encodeURIComponent(
            `export async function getLocale() { return 'en'; }
             export async function getTranslations(ns) {
              const catalogs = globalThis.__homeCatalogs;
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
    // Feature switches stub globally: the loader, the subsidiaries helper,
    // and the workspace tabs all resolve switches through this seam.
    if (specifier === "../features" || specifier.endsWith("/lib/features")) {
      return {
        shortCircuit: true,
        format: "module",
        url:
          "data:text/javascript," +
          encodeURIComponent(
            `export async function isFeatureEnabled(orgId, key) {
              const flags = globalThis.__homeFeatures;
              if (flags && key in flags) return flags[key];
              return true;
            }
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
    if (owned && specifier === "@openbooks/engine/src/hrm/employment-read.ts") {
      return {
        shortCircuit: true,
        format: "module",
        url:
          "data:text/javascript," +
          encodeURIComponent(
            `export async function getHeadcountAsOf() {
              return {
                orgId: 'org-home',
                effectiveDate: '2026-09-22',
                knownAt: '2026-09-22T00:00:00.000Z',
                total: 41,
                groups: [
                  {
                    employerSubsidiaryId: 'sub-1',
                    employerSubsidiaryName: 'Main',
                    departmentId: null,
                    departmentName: null,
                    headcount: 41,
                  },
                ],
              };
            }
            export async function getHeadcountTotalsAsOf({ effectiveDates }) {
              return { points: effectiveDates.map((d) => ({ effectiveDate: d, total: 40 })) };
            }`,
          ),
      };
    }
    if (owned && specifier === "@openbooks/engine/src/hrm/change-requests.ts") {
      return {
        shortCircuit: true,
        format: "module",
        url:
          "data:text/javascript," +
          encodeURIComponent(
            `export class HrmChangeRequestError extends Error {}
             export async function listChangeRequests() {
              return (globalThis.__homeQueue || []).map((row, i) => ({
                id: row.id,
                employmentId: row.employmentId,
                payload: row.payload,
                status: row.status,
                submittedBy: null,
                createdBy: 'actor-home',
                submittedAt: null,
                createdAt: new Date('2026-08-20T10:00:00.000Z'),
                appliedEmploymentChangeId: null,
              }));
            }`,
          ),
      };
    }
    if (owned && specifier === "@openbooks/engine/src/hrm/positions-read.ts") {
      return {
        shortCircuit: true,
        format: "module",
        url: "data:text/javascript,export async function getVacancyAsOf() { return null; }",
      };
    }
    if (owned && specifier === "@openbooks/engine/src/hrm/recruiting/recruiting-read.ts") {
      return {
        shortCircuit: true,
        format: "module",
        url: "data:text/javascript,export async function loadRecruitingOverview() { return null; }",
      };
    }
    if (owned && specifier === "@openbooks/engine/src/hrm/processes-read.ts") {
      return {
        shortCircuit: true,
        format: "module",
        url: "data:text/javascript,export async function getOnboardingOverview() { return null; }",
      };
    }
    if (owned && specifier === "@openbooks/engine/src/hrm/leave-read.ts") {
      return {
        shortCircuit: true,
        format: "module",
        url:
          "data:text/javascript," +
          encodeURIComponent(
            `export async function listOrgLeaveRequests() { return { requests: [], truncated: false }; }
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
            `export async function employmentsOnLeave() { return []; }
             export async function absenceCalendarForDepartment() { return []; }`,
          ),
      };
    }
    if (owned && (specifier === "../subsidiaries" || specifier.endsWith("/lib/subsidiaries"))) {
      return {
        shortCircuit: true,
        format: "module",
        url:
          "data:text/javascript," +
          encodeURIComponent(
            `export { subsidiaryVisibleFilter } from ${JSON.stringify(engineSubsidiariesUrl)};
             export async function isMultiSubsidiary() { return false; }`,
          ),
      };
    }
    if (
      (owned && specifier === "@openbooks/engine/src/platform/db.ts") ||
      (parent.endsWith("/engine/src/platform/business-date.ts") &&
        (specifier === "./db.ts" || specifier.endsWith("/platform/db.ts")))
    ) {
      return {
        shortCircuit: true,
        format: "module",
        url:
          "data:text/javascript," +
          encodeURIComponent(
            `export const db = { execute: async (query) => {
              const chunks = (query && query.queryChunks) || [];
              const part = (c) => {
                if (typeof c === 'string') return c;
                if (!c || typeof c !== 'object') return '';
                if (Array.isArray(c.queryChunks)) return c.queryChunks.map(part).join(' ');
                const v = c.value;
                if (typeof v === 'string') return v;
                if (Array.isArray(v)) return v.map(part).join(' ');
                return part(v);
              };
              const text = chunks.map(part).join(' ');
              if (/time[_-]?zone/i.test(text)) return { rows: [{ time_zone: 'UTC' }] };
              (globalThis.__homeQueries = globalThis.__homeQueries || []).push(text);
              return { rows: [] };
            } };`,
          ),
      };
    }
    return nextResolve(specifier, context);
  },
});

const { loadHrmHome, monthEndsBefore } = await import("../../../lib/hrm/home.ts");
const { hrmSpec } = await import("./view.ts");
const { withSimClock } = await import("@openbooks/engine/src/platform/clock.ts");

const gap = globalThis as Record<string, unknown>;

function authzWith(permissions: string[], allowedSubsidiaryIds: string[] | null = null) {
  return {
    user: { orgId: "org-home", id: "actor-home" },
    permissions: new Set(permissions),
    allowedSubsidiaryIds,
  } as never;
}

test("month ends step back through month boundaries, leap days included", () => {
  assert.deepEqual(monthEndsBefore("2026-09-22", 3), ["2026-06-30", "2026-07-31", "2026-08-31"]);
  assert.deepEqual(monthEndsBefore("2026-03-15", 2), ["2026-01-31", "2026-02-28"]);
  assert.deepEqual(monthEndsBefore("2024-03-15", 1), ["2024-02-29"]);
  assert.deepEqual(monthEndsBefore("2026-01-05", 1), ["2025-12-31"]);
  assert.deepEqual(monthEndsBefore("2026-09-22", 0), []);
});

function baseHomeData(): Record<string, unknown> {
  return {
    tabs: [],
    pending: [
      {
        id: "cr-1",
        employeeName: "Ada",
        partyId: null,
        kindLabel: "Hire",
        statusLabel: "Pending approval",
        effectiveLabel: "2026-10-01 → Present",
      },
    ],
    pendingRefusal: null,
    pendingEmpty: "No pending requests",
    pendingQueueHref: "/hrm/change-requests?status=submitted",
    pendingViewAll: "View all",
    pendingAccent: "amber",
    queueNotAvailable: "Not available",
    onboarding: {
      panelTitle: "Onboarding",
      openCount: 2,
      overdue: [],
      upcoming: [],
      openLabel: "Open",
      overdueLabel: "Overdue",
      upcomingLabel: "Due soon",
      empty: "Nothing onboarding",
      noDueSoon: "No checklist steps due in the next 7 days.",
      viewAll: "View all",
      viewAllHref: "/hrm/processes",
    },
    leavePanel: {
      title: "Leave",
      onLeaveToday: [],
      onLeaveEmpty: "Nobody out",
      pendingCount: 0,
      pendingLabel: "Pending",
      queueHref: "/hrm/leave?segment=pending",
    },
    benefitsPanel: {
      title: "Benefits",
      openWindows: [],
      openLabel: "Open",
      openEmpty: "No windows",
      pendingCount: 0,
      pendingLabel: "Pending",
      missingCount: 0,
      missingLabel: "Missing",
      queueHref: "/hrm/benefits",
    },
    recruiting: {
      panelTitle: "Recruiting",
      openLabel: "Open",
      openValue: "3",
      awaitingLabel: "Awaiting",
      awaitingValue: "1",
      interviewsLabel: "Interviews",
      interviewsValue: "0",
      viewAll: "View all",
      viewAllHref: "/hrm/recruiting",
    },
    canCreateEmployee: false,
    canProposeChange: false,
    canCreateProcess: false,
    newEmployee: { label: "New employee" },
    newProcessLabel: "New process",
    actions: [],
    positions: null,
    onLeaveLabel: "On leave",
    onLeaveValue: "0",
    onLeaveSub: "Nobody out today",
    headcountLabel: "Headcount",
    headcountValue: "41",
    headcountSub: "as of 2026-09-22",
    startingLabel: "Starting soon",
    startingValue: "0",
    startingSub: "0 ending",
    recentTitle: "Recent",
    trendTitle: "Trend",
    trendHint: "Twelve months",
    trendSeriesName: "Headcount",
    trendLabels: ["Oct"],
    trendData: [41],
    attentionTitle: "Attention",
    attentionAllClear: "All clear",
    attention: [],
    groupsTitle: "Groups",
    employerColumn: "Employer",
    departmentColumn: "Department",
    headcountColumn: "Headcount",
    groupsEmpty: "No groups",
    totalLabel: "Total",
    groups: [],
    multiSubsidiary: false,
    total: 41,
    directoryTitle: "Directory",
    directory: [],
    pendingTitle: "Pending",
    upcomingTitle: "Upcoming",
    upcomingHint: "Next 30 days",
    startsTitle: "Starts",
    startsEmpty: "No starts",
    endsTitle: "Ends",
    endsEmpty: "No ends",
    upcomingTruncated: false,
    starts: [],
    ends: [],
    recentEmpty: "No changes",
    recent: [],
    actionsTitle: "Actions",
    leavePanelTitle: "Leave",
  } as unknown as Record<string, unknown>;
}

function specJson(data: Record<string, unknown>): string {
  return JSON.stringify(hrmSpec(data as never));
}

test("the pending queue leads the hero and quiet modules collapse behind activity flags", () => {
  const json = specJson(baseHomeData());
  const order = [
    "hrm-pending-requests",
    "hrm-onboarding-panel",
    "hrm-leave-panel",
    "hrm-benefits-panel",
    "hrm-recruiting-panel",
  ].map((widget) => json.indexOf(`"${widget}"`));
  for (const [i, widget] of ["hrm-pending-requests", "hrm-onboarding-panel", "hrm-leave-panel", "hrm-benefits-panel", "hrm-recruiting-panel"].entries()) {
    assert.ok(order[i]! >= 0, `${widget} renders in the hero column`);
  }
  assert.ok(
    order[0]! < order[1]! && order[1]! < order[2]! && order[2]! < order[3]! && order[3]! < order[4]!,
    "work queues lead the hero in review order: pending, onboarding, leave, benefits, recruiting",
  );
  for (const flag of ["onboardingHasActivity", "leaveHasActivity", "benefitsHasActivity", "recruitingHasActivity"]) {
    assert.ok(json.includes(`"${flag}"`), `the subordinate panel collapses behind its ${flag} resolver`);
  }
  for (const icon of ['"iconKey":"users"', '"iconKey":"timer"', '"iconKey":"clipboard-check"', '"iconKey":"calendar-clock"']) {
    assert.ok(json.includes(icon), `the vitals strip keeps its ${icon} tile`);
  }
});

test("a refused queue reaches the pending widget as data", () => {
  const data = baseHomeData();
  data.pending = [];
  data.pendingRefusal = "Queue refused — ask an administrator for the queue grant";
  const json = specJson(data);
  assert.ok(json.includes('"hrm-pending-requests"'), "the pending widget still renders while refused");
  assert.ok(json.includes("Queue refused — ask an administrator for the queue grant"), "the refusal reaches the widget");
});

test("the cockpit binds loader figures and scopes every display leg to the org", async () => {
  gap.__homeFeatures = { hrmOrgChart: false };
  gap.__homeQueries = [];
  gap.__homeQueue = [
    { id: "cr-1", employmentId: "emp-1", payload: { kind: "hire", effectiveFrom: "2026-10-01" }, status: "pending_approval" },
    { id: "cr-2", employmentId: "emp-2", payload: { kind: "transfer", effectiveFrom: "2026-11-01" }, status: "pending_approval" },
    { id: "cr-3", employmentId: "emp-1", payload: { kind: "hire", effectiveFrom: "2026-10-01" }, status: "draft" },
  ];
  const data = await withSimClock("2026-09-22", () =>
    loadHrmHome(authzWith(["hrm.employment.read"], ["sub-1"])),
  );

  assert.equal(data.headcountValue, "41", "the vitals bind the canonical headcount total");
  assert.equal(data.pendingValue, "2", "only pending approvals count toward the queue figure");
  assert.equal(data.pendingAccent, "amber", "a nonzero queue warns");
  assert.equal(data.groups.length, 1, "the census binds the grouped hero");
  assert.equal(data.groups[0]!.id, "Main / ", "unassigned departments read through the unassigned fallback");
  assert.equal(data.trendData.length, 12, "the series keeps twelve month ends ending today");
  assert.equal(data.trendData[11], 41, "today's point is the live total, never a stale zero");
  assert.ok(data.trendData.slice(0, 11).every((point) => point === 40), "history comes from the shared census read");
  assert.deepEqual(
    data.directory.map((entry) => entry.href),
    ["/hrm/performance"],
    "without subordinate grants or features the directory keeps only the ungated surface",
  );
  assert.deepEqual(
    data.actions.map((action) => action.href),
    ["/admin/setup/departments"],
    "without manage or report grants the rail keeps only the setup surface",
  );
  assert.deepEqual(
    data.attention.map((item) => item.href),
    ["/hrm/change-requests?status=submitted"],
    "attention lists the pending queue and nothing else — no grants, no other figures",
  );
  assert.equal(data.leavePanel, null, "no leave panel without the leave grant — never a gated link");
  assert.equal(data.recruiting, null, "no recruiting panel without the recruiting grant");
  assert.equal(data.benefitsPanel, null, "no benefits panel without the benefits grant");
  assert.equal(data.positions, null, "no positions section without the position grant");

  const queries = (gap.__homeQueries as string[]) ?? [];
  assert.ok(queries.length >= 3, `the display legs query the database (saw ${queries.length})`);
  for (const text of queries) {
    assert.match(text, /org_id/, "every display leg carries the org predicate");
  }
  assert.ok(
    queries.some((text) => /employer_subsidiary_id|subsidiary_id/.test(text)),
    "the scoped session filters display legs to its visible subsidiaries",
  );
});
