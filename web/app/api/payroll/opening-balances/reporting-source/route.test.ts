import assert from "node:assert/strict";
import test from "node:test";
import type { ZodType } from "zod";
import { PayrollError } from "@openbooks/engine/payroll/error";
import { stubModules } from "../../../../../testing/stub-modules";

const state = {
  options: [] as {
    permission: string;
    feature: string;
    invalidBodyStatus?: number;
    body?: ZodType;
  }[],
  reads: [] as Record<string, unknown>[],
  writes: [] as Record<string, unknown>[],
  refusal: null as PayrollError | null,
  errors: [] as { error: unknown; safeStatus?: number }[],
};
(globalThis as Record<symbol, unknown>)[Symbol.for("openbooks.reporting-source-route-test")] =
  state;
stubModules({
  extra: {
    "@/lib/api/route": `const s=globalThis[Symbol.for('openbooks.reporting-source-route-test')];export function defineRoute(o){s.options.push(o);return o.handler}`,
    "@/lib/api/error-response": `const s=globalThis[Symbol.for('openbooks.reporting-source-route-test')];export function apiErrorResponse(error,o){s.errors.push({error,safeStatus:o.safeStatus});return Response.json({error:error.message},{status:o.safeStatus??500})}`,
    "@openbooks/engine/payroll/canada/opening-reporting-authority": `const s=globalThis[Symbol.for('openbooks.reporting-source-route-test')];export async function readCanadianOpeningReportingSourceContext(i){s.reads.push(i);if(s.refusal)throw s.refusal;return {original:{},reporting:null,allocations:[],filingAccounts:[],selectedSource:null}}export async function qualifyCanadianOpeningReportingSource(i){s.writes.push(i);if(s.refusal)throw s.refusal;return {id:'qualified',openingBalanceId:i.openingBalanceId}}`,
  },
});
const route = await import("./route");
const schema = state.options.find((option) => option.permission === "payroll.run")!.body!;
const id = "10000000-0000-4000-8000-000000000001";
const employeePartyId = "10000000-0000-4000-8000-000000000002";
const allocation = {
  sourceOrdinal: 1,
  firstCoveredPayDate: "2026-01-16",
  filingAccountId: id,
  province: "ON",
  annualAmounts: { gross_ytd: "9007199254740993.0001" },
  reportableBases: { ei: "0.0000", cpp: "0", qpip: "0" },
  children: {
    components: [{ component_id: id, ytd_amount: "0" }],
    programBases: [{ program_key: "ei", insurable_ytd: "0.0000" }],
    accountBases: [{ program_key: "ei", filing_account_id: id, region: "ON", insurable_ytd: "0" }],
    suiStates: [],
  },
};
const input = {
  openingBalanceId: id,
  requestId: employeePartyId,
  expectedLevyAuthorityId: id,
  expectedLevyAllocationSha256: "a".repeat(64),
  expectedOpeningSha256: "b".repeat(64),
  expectedOpeningChildrenSha256: "c".repeat(64),
  sourceFileId: id,
  sourceVersionId: employeePartyId,
  sourceSha256: "d".repeat(64),
  sourceReference: "Original register RP/province allocations",
  reason: "Verified source evidence",
  allocations: [allocation],
};
const authz = {
  user: { orgId: "server-org", id: "server-actor" },
  allowedSubsidiaryIds: new Set(["server-employer"]),
};
type Boundary = (context: {
  request: Request;
  authz: typeof authz;
  body?: unknown;
}) => Promise<Response>;
const get = route.GET as unknown as Boundary;
const post = route.POST as unknown as Boundary;

test("reporting source declares native read/run permissions and the payroll feature", () => {
  assert.deepEqual(
    state.options.map(({ permission, feature, invalidBodyStatus }) => ({
      permission,
      feature,
      invalidBodyStatus,
    })),
    [
      { permission: "payroll.read", feature: "payroll", invalidBodyStatus: undefined },
      { permission: "payroll.run", feature: "payroll", invalidBodyStatus: 422 },
    ],
  );
});

test("typed reporting body preserves exact decimal strings and refuses financial number coercion", () => {
  assert.deepEqual(schema.parse(input), input);
  for (const value of [0, 1.1, null, "", " ", "-0.0001", "1,000", "1e3", "0.00001"]) {
    assert.equal(
      schema.safeParse({
        ...input,
        allocations: [{ ...allocation, annualAmounts: { gross_ytd: value } }],
      }).success,
      false,
    );
    assert.equal(
      schema.safeParse({
        ...input,
        allocations: [
          { ...allocation, reportableBases: { ...allocation.reportableBases, ei: value } },
        ],
      }).success,
      false,
    );
    assert.equal(
      schema.safeParse({
        ...input,
        allocations: [
          {
            ...allocation,
            children: {
              ...allocation.children,
              components: [{ component_id: id, ytd_amount: value }],
            },
          },
        ],
      }).success,
      false,
    );
  }
});

test("reporting qualification requires complete source/head identity and typed original allocation evidence", () => {
  for (const key of [
    "requestId",
    "openingBalanceId",
    "expectedLevyAuthorityId",
    "expectedLevyAllocationSha256",
    "expectedOpeningSha256",
    "expectedOpeningChildrenSha256",
    "sourceFileId",
    "sourceVersionId",
    "sourceSha256",
    "sourceReference",
    "reason",
  ]) {
    assert.equal(schema.safeParse({ ...input, [key]: undefined }).success, false, key);
  }
  for (const changes of [
    { allocations: [] },
    { orgId: id },
    { actorId: id },
    { employeePartyId },
    { taxYear: 2026 },
    { sourceSha256: "D".repeat(64) },
    { allocations: [{ ...allocation, sourceOrdinal: "1" }] },
    { allocations: [{ ...allocation, sourceOrdinal: 0 }] },
    { allocations: [{ ...allocation, sourceOrdinal: 2147483648 }] },
    { allocations: [{ ...allocation, firstCoveredPayDate: "2026-02-30" }] },
    { allocations: [{ ...allocation, province: "CA" }] },
    { allocations: [{ ...allocation, reportableBases: { ei: "0", cpp: "0" } }] },
    {
      allocations: [
        { ...allocation, reportableBases: { ...allocation.reportableBases, guessedCap: "0" } },
      ],
    },
    {
      allocations: [{ ...allocation, children: { ...allocation.children, arbitraryHistory: [] } }],
    },
    { allocations: [{ ...allocation, subsidiaryId: id }] },
  ]) {
    assert.equal(schema.safeParse({ ...input, ...changes }).success, false);
  }
});

test("GET forwards selected employee/year/Cabinet file with server-owned tenant and entity authority", async () => {
  state.reads.length = 0;
  const response = await get({
    request: new Request(
      `http://localhost/api/payroll/opening-balances/reporting-source?employeePartyId=${employeePartyId}&taxYear=2026&sourceFileId=${id}`,
    ),
    authz,
  });
  assert.equal(response.status, 200);
  assert.deepEqual(state.reads, [
    {
      employeePartyId,
      taxYear: 2026,
      sourceFileId: id,
      orgId: authz.user.orgId,
      actorId: authz.user.id,
      allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
    },
  ]);
  for (const query of [
    `employeePartyId=${employeePartyId}&taxYear=2026&orgId=${id}`,
    `employeePartyId=${employeePartyId}&taxYear=26`,
    `employeePartyId=${employeePartyId}&taxYear=2026&sourceFileId=external`,
  ]) {
    assert.equal(
      (
        await get({
          request: new Request(
            `http://localhost/api/payroll/opening-balances/reporting-source?${query}`,
          ),
          authz,
        })
      ).status,
      422,
    );
  }
  assert.equal(state.reads.length, 1);
});

test("POST delegates the exact current certificate and allocations with server-owned authority", async () => {
  state.writes.length = 0;
  const response = await post({
    request: new Request("http://localhost/api/payroll/opening-balances/reporting-source"),
    authz,
    body: schema.parse(input),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(state.writes, [
    {
      ...input,
      orgId: authz.user.orgId,
      actorId: authz.user.id,
      allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
    },
  ]);
});

test("native source refusals retain the original cause and supported operator remedy in both routes", async () => {
  const error = new PayrollError(
    "The original source changed. Review Payroll → Opening balances → Reporting source",
  );
  state.refusal = error;
  try {
    for (const invoke of [
      () =>
        get({
          request: new Request(
            `http://localhost/api/payroll/opening-balances/reporting-source?employeePartyId=${employeePartyId}&taxYear=2026`,
          ),
          authz,
        }),
      () =>
        post({
          request: new Request("http://localhost/api/payroll/opening-balances/reporting-source"),
          authz,
          body: schema.parse(input),
        }),
    ]) {
      const response = await invoke();
      assert.equal(response.status, 422);
      assert.equal((await response.json()).error, error.message);
      assert.deepEqual(state.errors.at(-1), { error, safeStatus: 422 });
    }
  } finally {
    state.refusal = null;
  }
});
