import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
// Refusal paths never reach the database or the commands. Pure featureEnabled is real.
const stateKey = Symbol.for("openbooks.setup-command-route-test");
const routeState = {
  manage: false,
  setup: false,
  equity: false,
  features: {} as Record<string, boolean>,
  calls: [] as { name: string; input: Record<string, unknown> }[],
  equityCalls: [] as Record<string, unknown>[],
};
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;
const realAuthzUrl = import.meta.resolve("@/lib/authz");
const realFeaturesUrl = import.meta.resolve("@/lib/features");
const realPlatformDbUrl = import.meta.resolve("@openbooks/engine/platform/db");
const authzStub = `const s = globalThis[Symbol.for('openbooks.setup-command-route-test')]; const perms = () => new Set([...(s.manage ? ['funds.manage'] : []), ...(s.setup ? ['admin.setup.manage'] : []), ...(s.equity ? ['equity.manage'] : [])]); export async function getAuthz() { return { user: { orgId: 'org-1', id: 'user-1' }, permissions: perms(), allowedSubsidiaryIds: null }; } export async function guardPermission(p) { const a = await getAuthz(); if (!a.permissions.has(p)) return new Response(null, { status: 403 }); return a; } export { can } from ${JSON.stringify(realAuthzUrl)};`;
const featuresStub = `export * from ${JSON.stringify(realFeaturesUrl)}; export async function resolvedFeatureState() { return globalThis[Symbol.for('openbooks.setup-command-route-test')].features; }`;
const dbStub = `export * from ${JSON.stringify(realPlatformDbUrl)}; const fail = () => { throw new Error("no database in this test") }; const bomb = new Proxy({}, { get: fail }); export const db = bomb; export const inDbTransaction = (...a) => fail(); export const withOrgTransaction = (...a) => fail(); export const withOrgContext = (...a) => fail();`;
// The idempotency ledger and the equity command are the database-backed
// boundaries; the route's own body schema runs for real.
const idempotencyStub = `export async function executeIdempotent(input) { return { value: await input.execute(), replayed: false }; }`;
const realEquityUrl = import.meta.resolve("@openbooks/engine/equity");
const equityStub = `export * from ${JSON.stringify(realEquityUrl)}; export async function recordEquityAccountPolicy(input) { globalThis[Symbol.for('openbooks.setup-command-route-test')].equityCalls.push(input); return { id: 'policy-version', status: 'applied', requestId: 'request-1' }; }`;
const nonprofitCommandStub = `const s = globalThis[Symbol.for('openbooks.setup-command-route-test')]; const save = (name, input) => { s.calls.push({ name, input }); return { id: 'saved' }; }; export async function setFramework(input) { return save('setFramework', input); } export async function setFundPair(input) { return save('setFundPair', input); } export async function setFunctionalMapping(input) { return save('setFunctionalMapping', input); }`;
registerHooks({
  resolve(s, c, n) {
    const u =
      s === "@/lib/authz" || s === "../authz" || s === "../../../../../lib/authz"
        ? "mock:cmd-authz"
        : s === "@/lib/features" || s === "../features"
          ? "mock:cmd-features"
          : s === "@openbooks/engine/platform/db"
            ? "mock:cmd-db"
            : s === "@/lib/application/idempotency"
              ? "mock:cmd-idempotency"
              : s === "@openbooks/engine/equity"
                ? "mock:cmd-equity"
                : [
                      "@openbooks/engine/nonprofit/frameworks",
                      "@openbooks/engine/nonprofit/funds",
                      "@openbooks/engine/nonprofit/functional",
                    ].includes(s)
                  ? "mock:nonprofit-command"
                  : null;
    return u ? { shortCircuit: true, format: "module", url: u } : n(s, c);
  },
  load(u, c, n) {
    const s =
      u === "mock:cmd-authz"
        ? authzStub
        : u === "mock:cmd-features"
          ? featuresStub
          : u === "mock:cmd-db"
            ? dbStub
            : u === "mock:cmd-idempotency"
              ? idempotencyStub
              : u === "mock:cmd-equity"
                ? equityStub
                : u === "mock:nonprofit-command"
                  ? nonprofitCommandStub
                  : null;
    return s ? { format: "module", source: s, shortCircuit: true } : n(u, c);
  },
});
const { POST } = await import("./route.ts");
const { commandRefusalResponse, commandOperationName, normalizeChannelLocationBody } =
  await import("./contracts.ts");
const { SETUP_ENTITY_BY_KEY } = await import("@/lib/setup/registry");
const {
  POST: genericPOST,
  PATCH: genericPATCH,
  DELETE: genericDELETE,
} = await import("../route.ts");
const call = (entity: string, body: string) =>
  POST(
    new Request(`http://localhost/api/admin/setup/${entity}/command`, {
      method: "POST",
      headers: { "Idempotency-Key": "11111111-1111-4111-8111-111111111111" },
      body,
    }),
    { params: Promise.resolve({ entity }) },
  );
test("permission and unknown-entity refusals precede body parsing", async () => {
  routeState.manage = false;
  const forbidden = await call("no-such-entity", "{");
  assert.equal(forbidden.status, 403);
  const denial = (await forbidden.json()) as { error?: string };
  assert.match(denial.error ?? "", /funds\.manage.*Admin → Users & Roles/s);
  routeState.manage = true;
  const blind = await call("no-such-entity", "{");
  assert.equal(blind.status, 404);
  assert.deepEqual(await blind.json(), { error: "not_found" });
});
test("computed refusals keep typed status with message, code, remedy, field", () => {
  const bad = (status: number) => Object.assign(new Error("x"), { status });
  assert.deepEqual(
    commandRefusalResponse(Object.assign(bad(422), { code: "c", remedy: "r.", field: "f" })),
    { status: 422, body: { error: "x", code: "c", remedy: "r.", field: "f" } },
  );
  assert.equal(commandRefusalResponse(bad(500)), null);
});
test("channel-location empties normalize to absent in their own branch", () => {
  // The helper is invoked only by the upsertChannelLocation branch; every
  // other command parses its raw body untouched, so a blank portal name
  // still fails its min(1) shape (proven live: POST customer-portal with
  // portalName "" answers 400 invalid).
  assert.deepEqual(
    normalizeChannelLocationBody({ bufferQuantity: "", externalName: "Main", syncInventory: true }),
    { bufferQuantity: undefined, externalName: "Main", syncInventory: true },
  );
});
test("feature-off commands 404 before body parsing", async () => {
  routeState.manage = true;
  routeState.features = {};
  assert.equal((await call("fund-pairs", "{")).status, 404);
  routeState.features = { nonprofit: true, fundAccounting: true };
  assert.equal((await call("fund-pairs", "{")).status, 400);
});
test("nonprofit setup commands accept edit IDs and the drawer's functional mapping payload", async () => {
  routeState.manage = true;
  routeState.features = { nonprofit: true, fundAccounting: true, functionalExpenses: true };
  routeState.calls.length = 0;
  const rowId = "11111111-1111-4111-8111-111111111111";
  const departmentId = "22222222-2222-4222-8222-222222222222";
  const framework = await call(
    "nonprofit-frameworks",
    JSON.stringify({ id: rowId, framework: "us_asc958", reason: "Change reporting basis" }),
  );
  const pair = await call(
    "fund-pairs",
    JSON.stringify({
      id: rowId,
      fromFundId: departmentId,
      toFundId: rowId,
      dueFromAccountId: departmentId,
      dueToAccountId: rowId,
      isActive: true,
      reason: "Correct settlement accounts",
    }),
  );
  const mapping = await call(
    "functional-mappings",
    JSON.stringify({
      id: rowId,
      departmentId,
      projectId: "",
      function: "program",
      programKey: "",
      effectiveFrom: "2026-01-01",
      effectiveTo: "",
      reason: "Classify department expenses",
    }),
  );

  assert.deepEqual([framework.status, pair.status, mapping.status], [200, 200, 200]);
  assert.deepEqual(routeState.calls, [
    {
      name: "setFramework",
      input: {
        orgId: "org-1",
        actorId: "user-1",
        framework: "us_asc958",
        reason: "Change reporting basis",
      },
    },
    {
      name: "setFundPair",
      input: {
        orgId: "org-1",
        actorId: "user-1",
        fromFundId: departmentId,
        toFundId: rowId,
        dueFromAccountId: departmentId,
        dueToAccountId: rowId,
        isActive: true,
        reason: "Correct settlement accounts",
      },
    },
    {
      name: "setFunctionalMapping",
      input: {
        orgId: "org-1",
        actorId: "user-1",
        departmentId,
        projectId: null,
        functionKey: "program",
        programKey: null,
        effectiveFrom: "2026-01-01",
        effectiveTo: null,
        reason: "Classify department expenses",
      },
    },
  ]);
});
test("every registry command maps to a ledger-valid operation name", () => {
  // The idempotency ledger admits lowercase dotted names only; a camelCase
  // operation throws before the command runs, so every setup command write
  // would 500. The route bridges engine-style names to ledger names. The
  // command set derives from the registry, so a newly declared command is
  // covered without touching this test; the explicit examples pin the bridge
  // shape for the newest command.
  const ledgerName = /^[a-z][a-z0-9_.-]{2,99}$/;
  const declared = [...SETUP_ENTITY_BY_KEY.values()]
    .filter((entity) => entity.command)
    .map((entity) => entity.command!.name);
  assert.ok(declared.length > 0);
  for (const name of declared) assert.match(commandOperationName(name), ledgerName);
  assert.equal(commandOperationName("recordChannelAdSpend"), "setup.record_channel_ad_spend");
  assert.equal(commandOperationName("setFramework"), "setup.set_framework");
});
test("generic writes refuse command-owned entities before parsing", async () => {
  routeState.manage = true;
  routeState.setup = true;
  routeState.features = { nonprofit: true, fundAccounting: true, functionalExpenses: true };
  for (const [handler, init] of [
    [
      genericPOST,
      {
        method: "POST",
        headers: { "Idempotency-Key": "11111111-1111-4111-8111-111111111111" },
        body: "{",
      },
    ],
    [genericPATCH, { method: "PATCH", body: "{" }],
    [genericDELETE, { method: "DELETE" }],
  ] as const) {
    const res = await handler(new Request("http://localhost/api/admin/setup/fund-pairs", init), {
      params: Promise.resolve({ entity: "fund-pairs" }),
    });
    assert.deepEqual(
      [res.status, ((await res.json()) as { error?: string }).error],
      [
        405,
        "This configuration changes only through its setup command (POST /api/admin/setup/fund-pairs/command). Open Nonprofit Setup to make this change.",
      ],
    );
  }
});

// Sandbox and sample organizations derive ids as md5(seed:source)::uuid, so
// their version/variant nibbles are arbitrary hex (here "d" and "0").
const derivedId = (n: number) =>
  `435d3903-de4c-da3a-0183-ee5f8be57b${n.toString(16).padStart(2, "0")}`;
test("equity account policy command accepts sandbox-derived ids and refuses non-ids", async () => {
  routeState.manage = false;
  routeState.setup = false;
  routeState.equity = true;
  routeState.features = { equity: true };
  routeState.equityCalls = [];
  const body = {
    id: derivedId(0),
    subsidiaryId: derivedId(1),
    effectiveFrom: "2026-01-01",
    commonStockAccountId: derivedId(2),
    preferredStockAccountId: derivedId(3),
    apicAccountId: derivedId(4),
    apicShareBasedAccountId: derivedId(5),
    compensationExpenseAccountId: derivedId(6),
    treasuryStockAccountId: derivedId(7),
    convertibleInstrumentsAccountId: derivedId(8),
    interestExpenseAccountId: derivedId(9),
    accruedInterestAccountId: "",
    earlyExerciseDepositAccountId: null,
    reason: "Opening equity mapping",
  };
  const accepted = await call("equity-account-policies", JSON.stringify(body));
  assert.equal(accepted.status, 200, JSON.stringify(await accepted.clone().json()));
  assert.deepEqual(await accepted.json(), {
    id: "policy-version",
    status: "applied",
    requestId: "request-1",
  });
  assert.equal(routeState.equityCalls.length, 1);
  assert.deepEqual(
    { ...routeState.equityCalls[0], orgId: undefined, actorId: undefined },
    {
      orgId: undefined,
      actorId: undefined,
      subsidiaryId: derivedId(1),
      effectiveFrom: "2026-01-01",
      commonStockAccountId: derivedId(2),
      preferredStockAccountId: derivedId(3),
      apicAccountId: derivedId(4),
      apicShareBasedAccountId: derivedId(5),
      compensationExpenseAccountId: derivedId(6),
      treasuryStockAccountId: derivedId(7),
      convertibleInstrumentsAccountId: derivedId(8),
      interestExpenseAccountId: derivedId(9),
      accruedInterestAccountId: null,
      earlyExerciseDepositAccountId: null,
      reason: "Opening equity mapping",
    },
  );
  const refused = await call(
    "equity-account-policies",
    JSON.stringify({ ...body, apicAccountId: "account-4" }),
  );
  assert.equal(refused.status, 400);
  assert.equal(routeState.equityCalls.length, 1);
});
