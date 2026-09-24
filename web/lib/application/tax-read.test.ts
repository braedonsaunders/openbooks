import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import type { ApplicationContext } from "./context";
import { ApplicationError } from "./errors";

interface TaxReadState {
  dbCalls: number;
  formRows: Array<Record<string, unknown>>;
}

const state: TaxReadState = { dbCalls: 0, formRows: [] };
(globalThis as typeof globalThis & Record<symbol, unknown>)[Symbol.for("openbooks.tax-read-test")] = state;

const dbUrl = new URL("../../../engine/src/platform/db.ts", import.meta.url).href;
const mockDb = `
  export * from ${JSON.stringify(dbUrl)}
  const state = globalThis[Symbol.for('openbooks.tax-read-test')]
  export const db = { execute: async () => { state.dbCalls += 1; return { rows: state.formRows } } }
`;

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return { shortCircuit: true, url: "data:text/javascript,export {}" };
    if (specifier === "@openbooks/engine/src/platform/db.ts") {
      return { shortCircuit: true, url: "data:text/javascript," + encodeURIComponent(mockDb) };
    }
    return next(specifier, context);
  },
});

const { listApplicationTaxReturnForms, getApplicationTaxReturn } = await import("./tax-read");

function context(permissions: string[], allowedSubsidiaryIds: Set<string> | null): ApplicationContext {
  return {
    authz: {
      user: { orgId: "tax-read-unit-test" },
      permissions: new Set(permissions),
      allowedSubsidiaryIds,
    },
    source: "api",
    requestId: "tax-read-unit-request",
    apiKeyId: null,
  } as unknown as ApplicationContext;
}

test("tax form reads map the filing catalog under reports.read", async () => {
  state.dbCalls = 0;
  state.formRows = [{
    code: "CA_GST34",
    name: "GST/HST Return",
    country: "CA",
    submission_channel: "portal",
    is_active: true,
    registrations: 1,
  }];

  const result = await listApplicationTaxReturnForms(context(["reports.read"], null));

  assert.equal(state.dbCalls, 1);
  assert.deepEqual(result, {
    total: 1,
    forms: [{
      code: "CA_GST34",
      name: "GST/HST Return",
      country: "CA",
      submissionChannel: "portal",
      active: true,
      registrations: 1,
    }],
  });
});

test("tax form reads refuse a caller without reports.read before database access", async () => {
  state.dbCalls = 0;
  await assert.rejects(
    listApplicationTaxReturnForms(context(["ap.read"], null)),
    (error: unknown) => error instanceof ApplicationError
      && error.code === "forbidden"
      && error.status === 403
      && error.details?.permission === "reports.read",
  );
  assert.equal(state.dbCalls, 0);
});

test("tax returns refuse org-wide access for a restricted actor", async () => {
  await assert.rejects(
    getApplicationTaxReturn(context(["reports.read"], new Set(["sub-1"])), {
      formCode: "CA_GST34",
      from: "2026-01-01",
      to: "2026-03-31",
    }),
    (error: unknown) => error instanceof ApplicationError
      && error.code === "forbidden"
      && error.status === 403
      && error.details?.permission === "subsidiary.restricted",
  );
});

test("tax returns refuse a subsidiary outside the caller's allowed set", async () => {
  await assert.rejects(
    getApplicationTaxReturn(context(["reports.read"], new Set(["sub-1"])), {
      formCode: "CA_GST34",
      from: "2026-01-01",
      to: "2026-03-31",
      subsidiaryIds: ["sub-9"],
    }),
    (error: unknown) => error instanceof ApplicationError
      && error.code === "forbidden"
      && error.details?.permission === "subsidiary.restricted",
  );
});

test("tax return input refuses malformed windows, forms, and translation policy before database access", async () => {
  const full = context(["reports.read"], null);
  const cases = [
    [{ formCode: "CA_GST34", from: "2026-13-01", to: "" }, /from and to dates/],
    [{ formCode: "  ", from: "2026-01-01", to: "2026-03-31" }, /formCode is required/],
    [{ formCode: "CA_GST34", from: "2026-01-01", to: "2026-03-31", presentationCurrency: "US" }, /ISO 4217/],
    [{ formCode: "CA_GST34", from: "2026-01-01", to: "2026-03-31", rateDate: "yesterday" }, /rateDate must be YYYY-MM-DD/],
  ] as const;

  for (const [input, message] of cases) {
    await assert.rejects(
      getApplicationTaxReturn(full, input),
      (error: unknown) => error instanceof ApplicationError
        && error.code === "invalid_input"
        && error.status === 422
        && message.test(error.message),
    );
  }
});
