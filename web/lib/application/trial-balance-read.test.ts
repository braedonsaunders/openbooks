import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import type { ApplicationContext } from "./context";
import { ApplicationError } from "./errors";

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return { shortCircuit: true, url: "data:text/javascript,export {}" };
    return next(specifier, context);
  },
});

const { listApplicationTrialBalance } = await import("./trial-balance-read");

function context(permissions: string[], allowedSubsidiaryIds: Set<string> | null): ApplicationContext {
  return {
    authz: {
      user: { orgId: "trial-balance-unit-test" },
      permissions: new Set(permissions),
      allowedSubsidiaryIds,
    },
    source: "api",
    requestId: "trial-balance-unit-request",
    apiKeyId: null,
  } as unknown as ApplicationContext;
}

test("trial balance refuses callers without reports.read before reading the ledger", async () => {
  await assert.rejects(
    listApplicationTrialBalance(context(["gl.read"], null), { asOf: "2026-07-31" }),
    (error: unknown) => error instanceof ApplicationError
      && error.code === "forbidden"
      && error.status === 403
      && error.details?.permission === "reports.read",
  );
});

test("trial balance refuses an empty subsidiary scope before reading the ledger", async () => {
  await assert.rejects(
    listApplicationTrialBalance(context(["reports.read"], new Set()), { asOf: "2026-07-31" }),
    (error: unknown) => error instanceof ApplicationError
      && error.code === "forbidden"
      && error.details?.permission === "subsidiary.restricted",
  );
});

test("trial balance refuses a malformed as-of date", async () => {
  await assert.rejects(
    listApplicationTrialBalance(context(["reports.read"], null), { asOf: "2026-7-31" }),
    (error: unknown) => error instanceof ApplicationError
      && error.code === "invalid_input"
      && error.status === 422
      && error.message === "asOf must be YYYY-MM-DD",
  );
});
