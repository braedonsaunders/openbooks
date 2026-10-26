import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";
import type { Authz } from "@/lib/authz";
import { resolveAppModule } from "../../../lib/test-module-hooks";

const root = pathToFileURL(process.cwd() + "/").href;
const reads: string[][] = [];
Object.assign(globalThis, { __projectionReads: reads });
delete process.env.OPENBOOKS_REDIS_URL;
registerHooks({
  resolve(s, c, next) {
    if (s === "next-intl/server")
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export async function getLocale(){return "en"}export async function getTranslations(){return (key)=>key}',
      };
    if (
      s === "@openbooks/engine/platform/business-date/module" &&
      c.parentURL?.endsWith("/_projection.ts")
    ) {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export async function businessToday(){return "2026-10-26"}',
      };
    }
    if (s === "./_metrics" && c.parentURL?.endsWith("/_projection.ts")) {
      return {
        shortCircuit: true,
        url:
          "data:text/javascript," +
          encodeURIComponent(
            `export * from ${JSON.stringify(root + "web/app/(app)/dashboard/_metrics.ts")};export async function loadDashboardMetrics(authz,ids){globalThis.__projectionReads.push([...ids]);return {journalLineCount:7}}`,
          ),
      };
    }
    return resolveAppModule(s, c, next, root) ?? next(s, c);
  },
});

const { refreshDashboardGroups, dashboardGroupProjection } = await import("./_projection.ts");

function viewer(id: string, permissions: string[]): Authz {
  return {
    user: {
      id,
      orgId: "org-1",
      name: "Viewer",
      email: `${id}@example.com`,
      roles: [],
      envKind: "production",
    },
    permissions: new Set(permissions),
    allowedSubsidiaryIds: null,
  } as unknown as Authz;
}

test("a rebuild reads only the widgets the viewer may see and skips groups left empty", async () => {
  reads.length = 0;
  const rebuilt = await refreshDashboardGroups(
    viewer("user-1", ["gl.read"]),
    [["kpi-journal-lines", "not-a-widget"], ["resourcing-pulse"]],
    new Set(["kpi-journal-lines"]),
    "en",
  );
  assert.equal(rebuilt, 1);
  assert.deepEqual(reads, [["kpi-journal-lines"]]);
});

test("each viewer reads their own projection of the same tiles", async () => {
  reads.length = 0;
  const first = await dashboardGroupProjection(
    viewer("user-a", ["gl.read"]),
    ["kpi-journal-lines"],
    "en",
  );
  const again = await dashboardGroupProjection(
    viewer("user-a", ["gl.read"]),
    ["kpi-journal-lines"],
    "en",
  );
  const other = await dashboardGroupProjection(
    viewer("user-b", ["gl.read"]),
    ["kpi-journal-lines"],
    "en",
  );
  assert.equal(first.refreshing, false);
  assert.equal(again.refreshing, false);
  assert.equal(other.refreshing, false);
  assert.deepEqual(
    reads,
    [["kpi-journal-lines"], ["kpi-journal-lines"]],
    "the repeat visit is answered from the kept projection; another viewer builds their own",
  );
  assert.equal(first.data.journalLineCount, 7);
});

test("tiles over the viewer's own work queue are read on every visit and never kept", async () => {
  reads.length = 0;
  const authz = viewer("user-c", ["gl.read"]);
  await dashboardGroupProjection(authz, ["kpi-pending-approvals"], "en");
  await dashboardGroupProjection(authz, ["kpi-pending-approvals"], "en");
  assert.deepEqual(reads, [["kpi-pending-approvals"], ["kpi-pending-approvals"]]);
  const rebuilt = await refreshDashboardGroups(
    authz,
    [["kpi-pending-approvals"]],
    new Set(["kpi-pending-approvals"]),
    "en",
  );
  assert.equal(rebuilt, 0, "a live group keeps no projection to rebuild");
});
