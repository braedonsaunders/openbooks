import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";

const SOURCE = readFileSync(new URL("./tax-read.ts", import.meta.url), "utf8");

test("tax reads reuse the filing-screen engine and keep money exact", () => {
  // Same readers as the /tax filing screen, its export route, and the
  // `tax_return` / `list_tax_return_forms` tools — never a parallel engine.
  assert.match(SOURCE, /computeTaxReturn/);
  assert.match(SOURCE, /from "@openbooks\/engine\/src\/tax-returns\/return\.ts"/);
  assert.match(SOURCE, /from tax_return_forms/);
  // Money as exact decimal strings: engine values canonicalized through the
  // shared money helper, never floats.
  assert.match(SOURCE, /normalizeMoneyValue\(String\(box\.value\)\)/);
  assert.doesNotMatch(SOURCE, /\bnum\(/);
  // Same gate as the filing screen: reports.read.
  assert.match(SOURCE, /assertApplicationPermission\(context, "reports\.read"\)/);
  // Boundary refusals name the remedy.
  assert.match(SOURCE, /from and to dates \(YYYY-MM-DD\) are required/);
  assert.match(SOURCE, /TaxReturnError/);
});

// Tax has no key in the feature registry (the filing screen itself gates only
// on reports.read), so the wrapper must not invent one: `featureEnabled`
// resolves unknown keys to false, which would turn every read into a
// permanent 404 whose "enable it" remedy can never work.
test("tax reads gate on reports.read, not on an invented feature key", () => {
  assert.doesNotMatch(SOURCE, /isFeatureEnabled/);
});

const stateKey = Symbol.for("openbooks.tax-read-test");
interface TaxReadState {
  dbCalls: number;
  formRows: Array<Record<string, unknown>>;
  computeCalls: Array<{
    orgId: string;
    formCode: string;
    from: string;
    to: string;
    adjustments: unknown;
    opts: unknown;
  }>;
  // The mock module that reads this is an untyped JavaScript string, so a
  // precise type here would constrain nothing. `unknown` accepts every
  // fixture the tests assign and keeps the explicit-any ceiling at zero.
  computeResult: unknown;
  computeError: unknown;
  errorCtor: (new (message: string) => Error) | null;
}
const taxState: TaxReadState = {
  dbCalls: 0,
  formRows: [],
  computeCalls: [],
  computeResult: null,
  computeError: null,
  errorCtor: null,
};
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = taxState;

const REAL_DB_URL = new URL(
  "../../../engine/src/platform/db.ts",
  import.meta.url,
).href;

const mockSources = new Map<string, string>([
  [
    "mock:tax-db",
    // Re-export the real platform module so every other module in the
    // import graph keeps its named bindings; only `db` is doubled (the
    // database boundary, which is exactly what unit tests may double).
    // The explicit `db` below shadows the star export.
    `
      export * from ${JSON.stringify(REAL_DB_URL)}
      const state = globalThis[Symbol.for('openbooks.tax-read-test')]
      export const db = {
        execute: async () => {
          state.dbCalls += 1
          return { rows: state.formRows }
        },
      }
    `,
  ],
  [
    "mock:tax-return",
    `
      const state = globalThis[Symbol.for('openbooks.tax-read-test')]
      export class TaxReturnError extends Error {}
      state.errorCtor = TaxReturnError
      export async function computeTaxReturn(orgId, formCode, from, to, adjustments, opts) {
        state.computeCalls.push({ orgId, formCode, from, to, adjustments, opts })
        if (state.computeError) throw state.computeError
        return state.computeResult
      }
    `,
  ],
]);

const mockUrls = new Map<string, string>([
  ["@openbooks/engine/src/platform/db.ts", "mock:tax-db"],
  ["@openbooks/engine/src/tax-returns/return.ts", "mock:tax-return"],
]);

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    const mocked = mockUrls.get(specifier);
    if (mocked) return { url: mocked, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    const source = mockSources.get(url);
    if (source !== undefined) return { format: "module", source, shortCircuit: true };
    return nextLoad(url, context);
  },
});

const { listApplicationTaxReturnForms, getApplicationTaxReturn } =
  (await import("./tax-read.ts")) as typeof import("./tax-read.ts");
hooks.deregister();

type Context = Parameters<typeof listApplicationTaxReturnForms>[0];
function contextWith(
  permissions: string[],
  allowedSubsidiaryIds: Set<string> | null,
): Context {
  return {
    authz: {
      user: { orgId: "org-1" },
      permissions: new Set(permissions),
      allowedSubsidiaryIds,
    },
    source: "api",
    requestId: "req-1",
    apiKeyId: "key-1",
  } as unknown as Context;
}
const FULL = () => contextWith(["reports.read"], null);
const RESTRICTED = (ids: string[]) =>
  contextWith(["reports.read"], new Set(ids));

function reset(): void {
  taxState.dbCalls = 0;
  taxState.formRows = [];
  taxState.computeCalls = [];
  taxState.computeResult = null;
  taxState.computeError = null;
}

function engineReturn() {
  return {
    formCode: "CA_GST34",
    formName: "GST/HST Return",
    from: "2026-01-01",
    to: "2026-03-31",
    submissionChannel: "portal",
    watermark: null,
    registrationNumber: "123456789RT0001",
    functionalCurrency: "CAD",
    subsidiaryIds: ["sub-1"],
    registrationId: null,
    boxes: [
      {
        lineCode: "101",
        label: "Sales",
        value: "10.5",
        computed: false,
        editable: false,
        pdfField: null,
      },
    ],
    translation: null,
  };
}

test("forms list maps the filing screen's form rows", async () => {
  reset();
  taxState.formRows = [
    {
      code: "CA_GST34",
      name: "GST/HST Return",
      country: "CA",
      submission_channel: "portal",
      is_active: true,
      registrations: 1,
    },
  ];
  const result = await listApplicationTaxReturnForms(FULL());
  assert.equal(taxState.dbCalls, 1);
  assert.equal(result.total, 1);
  assert.deepEqual(result.forms, [
    {
      code: "CA_GST34",
      name: "GST/HST Return",
      country: "CA",
      submissionChannel: "portal",
      active: true,
      registrations: 1,
    },
  ]);
});

test("forms list refuses callers without reports.read", async () => {
  reset();
  await assert.rejects(
    listApplicationTaxReturnForms(contextWith(["ap.read"], null)),
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      (error as { code?: string }).code === "forbidden",
  );
  assert.equal(taxState.dbCalls, 0);
});

test("return keeps box values as exact decimal strings", async () => {
  reset();
  taxState.computeResult = engineReturn();
  const result = await getApplicationTaxReturn(FULL(), {
    formCode: "CA_GST34",
    from: "2026-01-01",
    to: "2026-03-31",
  });
  assert.equal(taxState.computeCalls.length, 1);
  assert.equal(taxState.computeCalls[0]?.formCode, "CA_GST34");
  assert.equal(result.currency, "CAD");
  assert.equal(result.boxes[0]?.value, "10.5000");
  assert.equal(typeof result.boxes[0]?.value, "string");
});

test("return passes a scoped filing entity through to the engine", async () => {
  reset();
  taxState.computeResult = engineReturn();
  await getApplicationTaxReturn(RESTRICTED(["sub-1"]), {
    formCode: "CA_GST34",
    from: "2026-01-01",
    to: "2026-03-31",
    subsidiaryIds: ["sub-1"],
  });
  const opts = taxState.computeCalls[0]?.opts as {
    filingEntity?: { subsidiaryIds: string[] };
  };
  assert.deepEqual(opts.filingEntity, { subsidiaryIds: ["sub-1"] });
});

test("return fails closed when a restricted caller reads org-wide", async () => {
  reset();
  taxState.computeResult = engineReturn();
  await assert.rejects(
    getApplicationTaxReturn(RESTRICTED(["sub-1"]), {
      formCode: "CA_GST34",
      from: "2026-01-01",
      to: "2026-03-31",
    }),
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      (error as { code?: string }).code === "forbidden",
  );
  assert.equal(taxState.computeCalls.length, 0);
});

test("return fails closed on a subsidiary outside the caller's set", async () => {
  reset();
  taxState.computeResult = engineReturn();
  await assert.rejects(
    getApplicationTaxReturn(RESTRICTED(["sub-1"]), {
      formCode: "CA_GST34",
      from: "2026-01-01",
      to: "2026-03-31",
      subsidiaryIds: ["sub-9"],
    }),
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      (error as { code?: string }).code === "forbidden",
  );
  assert.equal(taxState.computeCalls.length, 0);
});

test("return passes translation evidence through with exact decimals", async () => {
  reset();
  taxState.computeResult = {
    ...engineReturn(),
    translation: {
      presentationCurrency: "USD",
      rateType: "spot",
      rateDate: "2026-03-31",
      entities: [
        {
          subsidiaryId: "sub-1",
          name: "Main",
          currency: "CAD",
          fxRate: "1.234567",
          rateAsOf: "2026-03-30",
          boxes: [
            {
              lineCode: "101",
              label: "Sales",
              value: "2.5",
              computed: false,
              editable: false,
              pdfField: null,
            },
          ],
        },
      ],
    },
  };
  const result = await getApplicationTaxReturn(FULL(), {
    formCode: "CA_GST34",
    from: "2026-01-01",
    to: "2026-03-31",
    presentationCurrency: "usd",
  });
  assert.equal(result.translation?.presentationCurrency, "USD");
  // A policy rate is not money: exact engine string, untouched by ledger
  // precision — normalizing it would refuse legitimate rate precision.
  assert.equal(result.translation?.entities[0]?.fxRate, "1.234567");
  assert.equal(result.translation?.entities[0]?.boxes[0]?.value, "2.5000");
});

test("return refuses bad dates before touching the engine", async () => {
  reset();
  taxState.computeResult = engineReturn();
  await assert.rejects(
    getApplicationTaxReturn(FULL(), {
      formCode: "CA_GST34",
      from: "2026-13-01",
      to: "",
    }),
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      (error as { code?: string }).code === "invalid_input" &&
      /YYYY-MM-DD/.test((error as Error).message),
  );
  assert.equal(taxState.computeCalls.length, 0);
});

test("return refuses a blank form code before touching the engine", async () => {
  reset();
  taxState.computeResult = engineReturn();
  await assert.rejects(
    getApplicationTaxReturn(FULL(), { formCode: "  ", from: "2026-01-01", to: "2026-03-31" }),
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      (error as { code?: string }).code === "invalid_input",
  );
  assert.equal(taxState.computeCalls.length, 0);
});

test("return surfaces the engine's refusal with its message intact", async () => {
  reset();
  assert.ok(taxState.errorCtor, "mocked TaxReturnError must be registered");
  taxState.computeError = new taxState.errorCtor("unknown return form UNKNOWN_X");
  await assert.rejects(
    getApplicationTaxReturn(FULL(), {
      formCode: "UNKNOWN_X",
      from: "2026-01-01",
      to: "2026-03-31",
    }),
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      (error as { code?: string }).code === "invalid_input" &&
      (error as { status?: number }).status === 422 &&
      /unknown return form UNKNOWN_X/.test((error as Error).message),
  );
});
