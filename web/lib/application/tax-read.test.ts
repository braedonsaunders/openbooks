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
  function sqlText(query) {
    const chunks = query?.queryChunks
    if (!Array.isArray(chunks)) return ""
    return chunks.map((chunk) => {
      if (typeof chunk === "string") return chunk
      if (Array.isArray(chunk?.value)) return chunk.value.map(String).join("")
      if (Array.isArray(chunk?.queryChunks)) return sqlText(chunk)
      return ""
    }).join("")
  }
  export const db = {
    execute: async (query) => {
      state.dbCalls += 1
      const text = sqlText(query)
      // The forms list carries the fixture rows; the feature filter behind
      // it reads tax_report_lines, which is empty here so nothing is hidden.
      if (text.includes("tax_return_forms")) return { rows: state.formRows }
      if (text.includes("tax_report_lines")) return { rows: [] }
      throw new Error("unexpected tax-read query: " + text.slice(0, 120))
    },
  }
`;

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "@openbooks/engine/src/platform/db.ts") {
      return { shortCircuit: true, url: "data:text/javascript," + encodeURIComponent(mockDb) };
    }
    // The filing-catalog filter in tax-returns/return.ts reaches the same
    // database through its relative specifier; leaving it real sends the
    // unit test to the live pool and fails closed on the bypass guard.
    if (
      specifier === "../platform/db.ts"
      && (context.parentURL ?? "").endsWith("/tax-returns/return.ts")
    ) {
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

  // Two reads: the forms list, then the input-namespace feature filter that
  // hides forms whose provider namespace is off (empty here, so none hide).
  assert.equal(state.dbCalls, 2);
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
