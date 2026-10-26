import assert from "node:assert/strict";
import test from "node:test";
import { stubModules } from "../../../../testing/stub-modules";

const state = {
  calls: [] as { kind: string; input: unknown[] }[],
};
(globalThis as Record<symbol, unknown>)[Symbol.for("openbooks.payroll-work-locations-route-test")] =
  state;

stubModules({
  extra: {
    "@/lib/api/route": `export function defineRoute(options){return options.handler}`,
    "../../../../lib/feature-gates": "",
    "@openbooks/engine/payroll/work-location-admin": `const state=globalThis[Symbol.for('openbooks.payroll-work-locations-route-test')];export async function listPayrollWorkLocations(input){state.calls.push({kind:'list',input:[input]});return {kind:'employees',employees:[{employmentId:'10000000-0000-4000-8000-000000000003',employeeName:'Child employee',subsidiaryName:'Child subsidiary'}]}};export async function createPayrollWorkLocation(...input){state.calls.push({kind:'create',input});return {kind:'saved',row:{id:'10000000-0000-4000-8000-000000000004',region:'CA-ON',serviceDays:5,source:'hr_records'}}};export async function updatePayrollWorkLocation(...input){state.calls.push({kind:'update',input});return {kind:'saved',row:{id:'10000000-0000-4000-8000-000000000004',region:'CA-ON',serviceDays:5,source:'hr_records'}}}`,
  },
});

const route = await import("./route");
const rootSubsidiaryId = "10000000-0000-4000-8000-000000000001";
const childSubsidiaryId = "10000000-0000-4000-8000-000000000002";
const employmentId = "10000000-0000-4000-8000-000000000003";
const allocationId = "10000000-0000-4000-8000-000000000004";
const authz = {
  user: { orgId: "org-work-locations", id: "manager-child" },
  allowedSubsidiaryIds: new Set([childSubsidiaryId]),
};
type Handler = (context: { request: Request; authz: typeof authz }) => Promise<Response>;

function handler(value: unknown): Handler {
  return value as Handler;
}

function reset() {
  state.calls = [];
}

function allocationBody() {
  return {
    employmentId,
    periodStart: "2026-01-01",
    periodEnd: "2026-01-07",
    region: "CA-ON",
    serviceDays: 5,
    source: "hr_records",
    changeReason: "Employee works in Ontario",
  };
}

test("child-subsidiary payroll managers can list and save scoped work locations", async () => {
  assert.notEqual(childSubsidiaryId, rootSubsidiaryId);

  reset();
  const listed = await handler(route.GET)({
    request: new Request("http://localhost/api/payroll/work-locations"),
    authz,
  });
  assert.equal(listed.status, 200);
  assert.deepEqual((await listed.json()).employees, [
    { employmentId, employeeName: "Child employee", subsidiaryName: "Child subsidiary" },
  ]);
  assert.equal(state.calls.length, 1);
  assert.equal(state.calls[0]?.kind, "list");

  const savedRow = { id: allocationId, region: "CA-ON", serviceDays: 5, source: "hr_records" };
  reset();
  const saved = await handler(route.POST)({
    request: new Request("http://localhost/api/payroll/work-locations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(allocationBody()),
    }),
    authz,
  });
  assert.equal(saved.status, 201);
  assert.deepEqual((await saved.json()).row, savedRow);
  assert.equal(state.calls.length, 1);
  assert.equal(state.calls[0]?.kind, "create");
});

test("child-subsidiary payroll managers can update their scoped work locations", async () => {
  const savedRow = { id: allocationId, region: "CA-ON", serviceDays: 5, source: "hr_records" };
  reset();
  const updated = await handler(route.PATCH)({
    request: new Request("http://localhost/api/payroll/work-locations", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...allocationBody(), id: allocationId }),
    }),
    authz,
  });
  assert.equal(updated.status, 200);
  assert.deepEqual((await updated.json()).row, savedRow);
  assert.equal(state.calls.length, 1);
  assert.equal(state.calls[0]?.kind, "update");
});
