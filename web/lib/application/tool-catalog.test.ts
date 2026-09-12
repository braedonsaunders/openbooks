import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

// The application tool catalog is server-only, but this wiring test runs with
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

const {
  APPLICATION_TOOLS,
  applicationTool,
  executeApplicationTool,
} = await import("./tool-catalog.ts");
const { applicationContextFromSession } = await import("./context.ts");
type Authz = import("../authz.ts").Authz;
type SessionUser = import("../auth.ts").SessionUser;

function sessionUser(): SessionUser {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    email: "catalog-test@example.com",
    name: "Catalog Test",
    roles: [],
    orgId: "00000000-0000-4000-8000-000000000002",
    envKind: "production",
    productionOrgId: "00000000-0000-4000-8000-000000000002",
    isSuperAdmin: false,
    homeUserId: "00000000-0000-4000-8000-000000000001",
    homeOrgId: "00000000-0000-4000-8000-000000000002",
  };
}

function authzWith(permissions: string[]): Authz {
  return {
    user: sessionUser(),
    permissions: new Set(permissions),
    allowedSubsidiaryIds: null,
  };
}

const EMPTY_AUTHZ = authzWith([]);
const SUPER_ADMIN_AUTHZ = authzWith(["*"]);

test("every registered tool name resolves to its own definition", () => {
  assert.ok(APPLICATION_TOOLS.length > 0, "the catalog must register at least one tool");
  for (const tool of APPLICATION_TOOLS) {
    assert.equal(
      applicationTool(tool.name),
      tool,
      `applicationTool(${JSON.stringify(tool.name)}) must resolve to the registered definition`,
    );
  }
});

test("tool names are unique, non-empty snake_case identifiers", () => {
  const names = APPLICATION_TOOLS.map((tool) => tool.name);
  assert.deepEqual(
    new Set(names).size,
    names.length,
    "duplicate tool names would leave every shadowed entry silently unreachable via applicationTool",
  );
  for (const name of names) {
    assert.match(name, /^[a-z][a-z0-9_]*$/, `tool name ${JSON.stringify(name)} must be snake_case`);
  }
});

test("every tool wires a handler and a parsing input schema", () => {
  for (const tool of APPLICATION_TOOLS) {
    assert.equal(
      typeof tool.execute,
      "function",
      `${tool.name} must wire an execute handler`,
    );
    assert.equal(
      typeof tool.inputSchema?.safeParse,
      "function",
      `${tool.name} must wire a zod input schema (definition() parses input through it before execute)`,
    );
    // The sentinel must either be rejected or stripped: what it must never do
    // is throw (a mistyped schema) or echo back (an unvalidated passthrough).
    const probed = tool.inputSchema.safeParse({ __openbooks_never_a_field__: true });
    assert.equal(
      typeof probed.success,
      "boolean",
      `${tool.name} input schema must answer success/failed without throwing (a mistyped schema would throw here, not at agent time)`,
    );
    if (probed.success) {
      assert.deepEqual(
        probed.data,
        tool.inputSchema.parse({}),
        `${tool.name} input schema must strip unknown fields rather than passing them to the handler`,
      );
    }
  }
});

test("every tool wires a permission gate that answers for any actor", () => {
  for (const tool of APPLICATION_TOOLS) {
    assert.equal(
      typeof tool.visibleTo,
      "function",
      `${tool.name} must wire a visibleTo permission gate`,
    );
    assert.equal(
      typeof tool.visibleTo(EMPTY_AUTHZ),
      "boolean",
      `${tool.name} gate must answer boolean for a permissionless actor, not throw`,
    );
    assert.equal(
      tool.visibleTo(SUPER_ADMIN_AUTHZ),
      true,
      `${tool.name} gate must admit a super-admin; otherwise the tool is dead for every actor`,
    );
  }
});

test("unknown names resolve to nothing, never to a neighboring tool", () => {
  for (const name of ["list_module", "describe_modules", "apply_modul", "", "GET_VITALS"]) {
    assert.equal(
      applicationTool(name),
      undefined,
      `${JSON.stringify(name)} must not resolve — a mistyped agent call fails loudly, not against the wrong handler`,
    );
  }
});

test("execution behind a denied gate fails closed before any handler runs", async () => {
  const gated = APPLICATION_TOOLS.find((tool) => tool.visibleTo(EMPTY_AUTHZ) === false);
  assert.ok(gated, "the catalog must contain at least one permission-gated tool for this check");
  const context = applicationContextFromSession(EMPTY_AUTHZ, "assistant", "catalog-test");
  await assert.rejects(
    executeApplicationTool(gated, context, {}),
    /forbidden/,
    `${gated.name} must refuse execution when its gate denies, before input parsing or handler work`,
  );
});
