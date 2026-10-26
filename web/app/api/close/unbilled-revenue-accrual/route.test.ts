import assert from "node:assert/strict";
import test from "node:test";

const state: { preview: unknown } = { preview: null };
Object.assign(globalThis, { __unbilledAccrualRouteState: state });

const { stubModules } = await import("../../../../testing/stub-modules");
stubModules({
  intl: true,
  authz: {
    source:
      `export async function getAuthz(){return { user: { orgId: 'org-1', id: 'user-1' }, permissions: new Set(['*']), allowedSubsidiaryIds: null }}` +
      `export async function guardPermission(){return getAuthz()}` +
      `export function guardUnrestrictedScope(){return null}` +
      `export async function guardRootSubsidiaryScope(){return null}`,
  },
  features: {
    source:
      `export async function isFeatureEnabled(){return true}` +
      `export async function guardFeaturePermission(){return { user: { orgId: 'org-1', id: 'user-1' }, permissions: new Set(['*']), allowedSubsidiaryIds: null }}`,
  },
  extra: {
    "@openbooks/engine/projects/unbilled-accrual":
      `export class UnbilledAccrualError extends Error {}` +
      `export async function previewUnbilledRevenueAccrual(){return globalThis.__unbilledAccrualRouteState.preview}` +
      `export async function runUnbilledRevenueAccrual(){throw new Error('not exercised')}`,
  },
});

const { GET } = await import("./route");

const july = {
  fiscalYear: 2026,
  periodNumber: 7,
  adjustment: false,
  startsOn: "2026-07-01",
  endsOn: "2026-07-31",
};
const august = {
  fiscalYear: 2026,
  periodNumber: 8,
  adjustment: false,
  startsOn: "2026-08-01",
  endsOn: "2026-08-31",
};

function preview(reversal: {
  periodId: string | null;
  periodName: string | null;
  periodRef: typeof august | null;
  date: string | null;
}) {
  return {
    period: {
      id: "period-july",
      name: "P07 FY2026",
      startsOn: "2026-07-01",
      endsOn: "2026-07-31",
      periodRef: july,
    },
    reversal,
    totals: [],
    projectCount: 0,
    lines: [],
    upToDate: true,
    problems: [],
  };
}

async function get(): Promise<{
  status: number;
  body: { period: { name: string }; reversal: { periodName: string | null } };
}> {
  const response = await GET(
    new Request(
      "http://openbooks.test/api/close/unbilled-revenue-accrual?periodId=11111111-1111-4111-8111-111111111111",
    ),
  );
  return { status: response.status, body: await response.json() };
}

test("the accrual and reversal periods reach the panel labelled in the viewer locale", async () => {
  state.preview = preview({
    periodId: "period-august",
    periodName: "P08 FY2026",
    periodRef: august,
    date: "2026-08-01",
  });

  const { status, body } = await get();

  assert.equal(status, 200);
  assert.equal(body.period.name, "P07 FY2026 · Jul 2026");
  assert.equal(body.reversal.periodName, "P08 FY2026 · Aug 2026");
});

test("a missing following period stays unnamed rather than borrowing a label", async () => {
  state.preview = preview({ periodId: null, periodName: null, periodRef: null, date: null });

  const { status, body } = await get();

  assert.equal(status, 200);
  assert.equal(body.period.name, "P07 FY2026 · Jul 2026");
  assert.equal(body.reversal.periodName, null);
});
