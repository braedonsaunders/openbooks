import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";

// The application context is server-only, but this contract test runs with
// Node's plain test runner. Keep the module graph identical to the other
// application tests by shimming only the marker package.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return {
        shortCircuit: true,
        format: "module",
        url: "data:text/javascript,export {}",
      };
    }
    return nextResolve(specifier, context);
  },
});

const { assertSubsidiaryAccess } = await import("./context.ts");
const { ApplicationError } = await import("./errors.ts");
type ApplicationContext = import("./context.ts").ApplicationContext;

const ALLOWED_SUBSIDIARY = "00000000-0000-4000-8000-000000000001";
const OUT_OF_SCOPE_SUBSIDIARY = "00000000-0000-4000-8000-000000000002";

function context(allowedSubsidiaryIds: Set<string> | null): ApplicationContext {
  return {
    authz: {
      user: {
        id: "user-1",
        orgId: "org-1",
      } as ApplicationContext["authz"]["user"],
      permissions: new Set(["*"]),
      allowedSubsidiaryIds,
    },
    source: "api",
    requestId: "request-1",
    apiKeyId: null,
  };
}

function authorizationShape(error: unknown): unknown {
  assert.ok(error instanceof ApplicationError);
  return {
    code: error.code,
    message: error.message,
    status: error.status,
    details: error.details,
  };
}

test("restricted application contexts fail closed for missing and unknown subsidiaries", () => {
  const restricted = context(new Set([ALLOWED_SUBSIDIARY]));

  assert.doesNotThrow(() =>
    assertSubsidiaryAccess(restricted, ALLOWED_SUBSIDIARY),
  );

  const denied = [null, undefined, "", OUT_OF_SCOPE_SUBSIDIARY].map(
    (subsidiaryId) => {
      let error: unknown;
      try {
        assertSubsidiaryAccess(restricted, subsidiaryId);
      } catch (caught) {
        error = caught;
      }
      return authorizationShape(error);
    },
  );

  // A missing/null row must not disclose whether a record exists or whether
  // its subsidiary was outside the caller's scope: every denial is the same
  // transport-neutral forbidden error.
  for (const error of denied.slice(1)) assert.deepEqual(error, denied[0]);
  assert.deepEqual(denied[0], {
    code: "forbidden",
    message: "forbidden",
    status: 403,
    details: { permission: "subsidiary.restricted" },
  });
});

test("an explicitly unrestricted application context keeps legacy access", () => {
  const unrestricted = context(null);
  for (const subsidiaryId of [
    null,
    undefined,
    "",
    ALLOWED_SUBSIDIARY,
    OUT_OF_SCOPE_SUBSIDIARY,
  ]) {
    assert.doesNotThrow(() =>
      assertSubsidiaryAccess(unrestricted, subsidiaryId),
    );
  }
});

function source(file: string): string {
  return readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
}

function callCount(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

test("all application financial boundaries use the centralized subsidiary guard", () => {
  const boundaries: ReadonlyArray<{ file: string; calls: number }> = [
    { file: "documents.ts", calls: 1 },
    { file: "payments.ts", calls: 2 },
    { file: "records.ts", calls: 3 },
    { file: "close.ts", calls: 2 },
  ];

  for (const boundary of boundaries) {
    const src = source(boundary.file);
    assert.ok(
      callCount(src, "assertSubsidiaryAccess(context,") >= boundary.calls,
      `${boundary.file} must gate every subsidiary-sensitive application path`,
    );
    // Keep the existing organization pinning alongside the subsidiary gate;
    // scope checks must never turn an adapter query into a cross-tenant read.
    assert.match(src, /context\.authz\.user\.orgId/);
  }
});
