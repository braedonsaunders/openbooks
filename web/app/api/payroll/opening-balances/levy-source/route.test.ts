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
  corrections: [] as Record<string, unknown>[],
  refusal: null as PayrollError | null,
  errors: [] as { error: unknown; safeStatus?: number }[],
};
(globalThis as Record<symbol, unknown>)[Symbol.for("openbooks.levy-source-route-test")] = state;
// The allocation requirement is pure country-pack policy, so the double serves the real rule.
const levySourceAuthorityUrl = new URL(
  "../../../../../../engine/src/payroll/opening-levy-source-authority.ts",
  import.meta.url,
).href;
stubModules({
  extra: {
    "@/lib/api/route": `const s=globalThis[Symbol.for('openbooks.levy-source-route-test')];export function defineRoute(o){s.options.push(o);return o.handler}`,
    "@/lib/api/error-response": `const s=globalThis[Symbol.for('openbooks.levy-source-route-test')];export function apiErrorResponse(error,o){s.errors.push({error,safeStatus:o.safeStatus});return Response.json({error:error.message},{status:o.safeStatus??500})}`,
    "@openbooks/engine/payroll/opening-levy-source-correction": `const s=globalThis[Symbol.for('openbooks.levy-source-route-test')];export async function correctOpeningLevySourceAuthority(i){s.corrections.push(i);if(s.refusal)throw s.refusal;return {id:'corrected',openingBalanceId:i.openingBalanceId}}`,
    "@openbooks/engine/payroll/opening-levy-source-authority": `export { openingLevySourceRequiresAllocations } from '${levySourceAuthorityUrl}';const s=globalThis[Symbol.for('openbooks.levy-source-route-test')];export async function readOpeningLevySourceContext(i){s.reads.push(i);return {record:null,allocations:[],eins:[],suiAccounts:[],openingSuiStates:[],openingSuiAccountIds:[]}}export async function qualifyOpeningLevySourceAuthority(i){s.writes.push(i);if(s.refusal)throw s.refusal;return {id:'qualified',openingBalanceId:i.openingBalanceId}}`,
  },
});
const route = await import("./route");
const schema = state.options.find((option) => option.permission === "payroll.run")!.body!;
const openingBalanceId = "10000000-0000-4000-8000-000000000001";
const employeePartyId = "10000000-0000-4000-8000-000000000002";
const filingAccountId = "10000000-0000-4000-8000-000000000003";
const input = {
  sourceFileId: openingBalanceId,
  sourceVersionId: employeePartyId,
  sourceSha256: "b".repeat(64),
  sourceReference: "Original report, statutory coverage",
  originalCountry: "US",
  originalCurrency: "USD",
  coverageStart: "2026-01-01",
  coverageEnd: "2026-05-30",
  coverageComplete: true,
  openingBalanceId,
  expectedOpeningSha256: "a".repeat(64),
  expectedOpeningChildrenSha256: "c".repeat(64),
  allocations: [
    {
      programKey: "us_futa",
      region: "US",
      filingAccountId,
      federalAccountId: filingAccountId,
      amount: "0",
    },
  ],
  reason: "Verified original report",
};
const authz = {
  user: { orgId: "org-scope", id: "actor-scope" },
  allowedSubsidiaryIds: new Set(["employer-scope"]),
};
type Boundary = (context: {
  request: Request;
  authz: typeof authz;
  body?: unknown;
}) => Promise<Response>;
const get = route.GET as unknown as Boundary;
const post = route.POST as unknown as Boundary;
const patch = route.PATCH as unknown as Boundary;
const correctionSchema = state.options.find(
  (option) => option.permission === "payroll.manage",
)!.body!;

test("levy source routes declare native read/run/manage permissions and payroll feature requirements", () => {
  assert.deepEqual(
    state.options.map(({ permission, feature, invalidBodyStatus }) => ({
      permission,
      feature,
      invalidBodyStatus,
    })),
    [
      { permission: "payroll.read", feature: "payroll", invalidBodyStatus: undefined },
      { permission: "payroll.run", feature: "payroll", invalidBodyStatus: 422 },
      { permission: "payroll.manage", feature: "payroll", invalidBodyStatus: 422 },
    ],
  );
});

test("strict source body preserves exact decimal text and explicit zero without coercion", () => {
  for (const amount of ["0", "0.0000", "9007199254740993.0001"]) {
    const parsed = schema.parse({
      ...input,
      allocations: [{ ...input.allocations[0], amount }],
    }) as typeof input;
    assert.equal(parsed.allocations[0]!.amount, amount);
  }
  for (const amount of [0, 1.1, null, "", "   "]) {
    assert.equal(
      schema.safeParse({ ...input, allocations: [{ ...input.allocations[0], amount }] }).success,
      false,
    );
  }
});

test("source body refuses missing identity, fingerprint, reason and empty allocations", () => {
  for (const changes of [
    { openingBalanceId: undefined },
    { openingBalanceId: "external-id" },
    { expectedOpeningChildrenSha256: undefined },
    { expectedOpeningChildrenSha256: "f".repeat(63) },
    { expectedOpeningSha256: undefined },
    { expectedOpeningSha256: "a".repeat(63) },
    { expectedOpeningSha256: "A".repeat(64) },
    { reason: " " },
    { reason: "r".repeat(2001) },
    { allocations: [] },
    { originalCountry: undefined },
    { originalCurrency: undefined },
    { coverageStart: undefined },
    { coverageEnd: undefined },
    { coverageComplete: false },
    { coverageComplete: undefined },
    { sourceFileId: undefined },
    { sourceSha256: undefined },
    { allocations: [{ ...input.allocations[0], federalAccountId: undefined }] },
  ])
    assert.equal(schema.safeParse({ ...input, ...changes }).success, false);
});

test("strict body cannot override tenant, original source, employee, year or allocation contract", () => {
  for (const changes of [
    { orgId: "other-org" },
    { subsidiaryId: "other-employer" },
    { employeePartyId },
    { taxYear: 2025 },
    { sourceFileId: "external-file" },
    { sourceVersionId: "external-version" },
    { country: "CA" },
    { allocations: [{ ...input.allocations[0], programKey: "unknown" }] },
    { allocations: [{ ...input.allocations[0], country: "US" }] },
    { allocations: [{ ...input.allocations[0], filingAccountId: "external-account" }] },
  ])
    assert.equal(schema.safeParse({ ...input, ...changes }).success, false);
});

test("GET supplies the selected native employee/year and server-owned tenant authority", async () => {
  state.reads.length = 0;
  const response = await get({
    request: new Request(
      `http://localhost/api/payroll/opening-balances/levy-source?employeePartyId=${employeePartyId}&taxYear=2026`,
    ),
    authz,
  });
  assert.equal(response.status, 200);
  assert.deepEqual(state.reads, [
    {
      employeePartyId,
      taxYear: 2026,
      orgId: authz.user.orgId,
      actorId: authz.user.id,
      allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
    },
  ]);
  for (const query of [
    `employeePartyId=${employeePartyId}&taxYear=2026&orgId=other-org`,
    `employeePartyId=external-id&taxYear=2026`,
    `employeePartyId=${employeePartyId}&taxYear=26`,
  ]) {
    const rejected = await get({
      request: new Request(`http://localhost/api/payroll/opening-balances/levy-source?${query}`),
      authz,
    });
    assert.equal(rejected.status, 422);
  }
  assert.equal(state.reads.length, 1);
});

test("POST delegates original allocation qualification with server-owned tenant and employer scope", async () => {
  state.writes.length = 0;
  const response = await post({
    request: new Request("http://localhost/api/payroll/opening-balances/levy-source"),
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

test("POST preserves a named native source refusal for the shared error boundary", async () => {
  const error = new PayrollError(
    "The source-qualified opening changed; reload its retained amounts before allocating statutory history",
  );
  state.refusal = error;
  try {
    const response = await post({
      request: new Request("http://localhost/api/payroll/opening-balances/levy-source"),
      authz,
      body: schema.parse(input),
    });
    assert.equal(response.status, 422);
    assert.deepEqual(state.errors.at(-1), { error, safeStatus: 422 });
    assert.match((await response.json()).error, /reload its retained amounts/);
  } finally {
    state.refusal = null;
  }
});

test("typed generic opening source accepts an empty levy set while keeping explicit original currency and fiscal coverage", () => {
  const parsed = schema.parse({
    ...input,
    originalCountry: "GB",
    originalCurrency: "GBP",
    coverageStart: "2026-04-06",
    coverageEnd: "2027-04-05",
    allocations: [],
  }) as typeof input;
  assert.equal(parsed.originalCountry, "GB");
  assert.equal(parsed.originalCurrency, "GBP");
  assert.deepEqual(parsed.allocations, []);
  for (const change of [
    { coverageStart: "2026-02-30" },
    { coverageEnd: "2026-04-31" },
    { originalCountry: "gb" },
    { originalCurrency: "gbp" },
  ]) {
    assert.equal(schema.safeParse({ ...input, ...change }).success, false);
  }
});

test("PATCH requires the reviewed head, allocation digest and native request identity while retaining tenant authority", async () => {
  const correction = {
    ...input,
    requestId: employeePartyId,
    expectedAuthorityId: openingBalanceId,
    expectedAllocationSha256: "d".repeat(64),
  };
  for (const change of [
    { requestId: undefined },
    { expectedAuthorityId: undefined },
    { expectedAllocationSha256: undefined },
    { expectedAuthorityId: "unknown" },
    { expectedAllocationSha256: "D".repeat(64) },
    { orgId: "other-org" },
  ]) {
    assert.equal(correctionSchema.safeParse({ ...correction, ...change }).success, false);
  }
  state.corrections.length = 0;
  const response = await patch({
    request: new Request("http://localhost/api/payroll/opening-balances/levy-source", {
      method: "PATCH",
    }),
    authz,
    body: correctionSchema.parse(correction),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(state.corrections, [
    {
      ...correction,
      orgId: authz.user.orgId,
      actorId: authz.user.id,
      allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
    },
  ]);
});

test("PATCH preserves the native issued-year refusal without suggesting an unsupported replacement", async () => {
  state.refusal = new PayrollError(
    "Source certificate replacement for an issued year is unavailable",
  );
  try {
    const response = await patch({
      request: new Request("http://localhost/api/payroll/opening-balances/levy-source", {
        method: "PATCH",
      }),
      authz,
      body: correctionSchema.parse({
        ...input,
        requestId: employeePartyId,
        expectedAuthorityId: openingBalanceId,
        expectedAllocationSha256: "d".repeat(64),
      }),
    });
    assert.equal(response.status, 422);
    assert.match((await response.json()).error, /issued year is unavailable/);
  } finally {
    state.refusal = null;
  }
});
