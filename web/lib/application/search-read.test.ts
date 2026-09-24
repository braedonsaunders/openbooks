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

const { searchApplication } = await import("./search-read");

test("search rejects a blank query without contacting the search backend", async () => {
  const context = {
    authz: { user: { orgId: "search-read-unit-test" }, permissions: new Set(), allowedSubsidiaryIds: null },
    source: "api",
    requestId: "search-read-unit-request",
    apiKeyId: null,
  } as unknown as ApplicationContext;

  await assert.rejects(
    searchApplication(context, { q: "   " }),
    (error: unknown) => error instanceof ApplicationError
      && error.code === "invalid_input"
      && error.status === 422
      && error.message === "q is required",
  );
});
