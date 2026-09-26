import assert from "node:assert/strict";
import test from "node:test";
import type { ApplicationContext } from "./context.ts";
import { ApplicationError } from "./errors.ts";

const { listApplicationOpenItems } = await import("./open-items.ts");

const context = {
  authz: {
    user: { orgId: "open-items-unit-test" },
    permissions: new Set(["ar.read"]),
    allowedSubsidiaryIds: null,
  },
  source: "api",
  requestId: "open-items-unit-request",
  apiKeyId: null,
} as unknown as ApplicationContext;

test("open items reject unsupported sides before querying", async () => {
  await assert.rejects(
    listApplicationOpenItems(context, { side: "cash" }),
    (error: unknown) => error instanceof ApplicationError
      && error.code === "invalid_input"
      && error.status === 422
      && error.message === "side is required; use ar or ap",
  );
});
