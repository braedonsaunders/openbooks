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

const { listSetupRecords } = await import("./setup-read");

test("unknown setup entities return the catalog remedy without querying records", async () => {
  const context = {
    authz: { user: { orgId: "setup-read-unit-test" }, permissions: new Set(["admin.setup.manage"]) },
    source: "api",
    requestId: "setup-read-unit-request",
    apiKeyId: null,
  } as unknown as ApplicationContext;

  await assert.rejects(
    listSetupRecords(context, { entityKey: "not-a-setup-entity" }),
    (error: unknown) => error instanceof ApplicationError
      && error.code === "not_found"
      && error.status === 404
      && error.message === "setup entity not found; list enabled entities from GET /api/v1/setup",
  );
});
