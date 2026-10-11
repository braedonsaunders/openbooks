import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";

// A duplicate account number must refuse with the holding account named:
// the 422 carries details { existingAccountId, existingAccountName,
// existingAccountNumber } so the drawer can link the account instead of
// leaving the operator guessing. Only the session gate is stubbed.
const stateKey = Symbol.for("openbooks.account-duplicate-test");
const routeState: { authz: { user: { orgId: string; id: string }; permissions: Set<string>; allowedSubsidiaryIds: Set<string> | null } | null } = { authz: null };
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

const module_ = (source: string) => ({
  shortCircuit: true as const,
  format: "module" as const,
  url: `data:text/javascript,${encodeURIComponent(source)}`,
});

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier === "@/lib/authz" ||
      specifier === "../../../lib/authz" ||
      specifier === "../../../../lib/authz"
    ) {
      const real = nextResolve(specifier, context).url;
      const nextServer = nextResolve("next/server", context).url;
      return module_(`
        export * from ${JSON.stringify(real)};
        const state = globalThis[Symbol.for('openbooks.account-duplicate-test')];
        const { NextResponse } = await import(${JSON.stringify(nextServer)});
        export async function guardPermission(_permission) {
          if (!state.authz) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
          return { permissions: new Set(), allowedSubsidiaryIds: null, ...state.authz };
        }
      `);
    }
    return nextResolve(specifier, context);
  },
});

const { POST } = await import("./route.ts?account-duplicate-post");
const { PATCH } = await import("./[id]/route.ts?account-duplicate-patch");
const { withBypassContext, db } = await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import("@openbooks/engine/src/testing/fixtures.ts");

function postRequest(key: string, body: unknown): Request {
  return new Request("http://localhost/api/accounts", {
    method: "POST",
    headers: { "content-type": "application/json", "Idempotency-Key": key },
    body: JSON.stringify(body),
  });
}

test("a duplicate account number names the holding account", async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const { adminId } = await withBypassContext(() => seedFlowActors(org.orgId));
    routeState.authz = { user: { orgId: org.orgId, id: adminId }, permissions: new Set(), allowedSubsidiaryIds: null };

    const first = await POST(postRequest(randomUUID(), { name: "Cash Over and Short", type: "expense", number: "6820" }));
    assert.equal(first.status, 201, JSON.stringify(await first.clone().json()));
    const created = (await first.json()) as { account: { id: string } };

    const second = await POST(postRequest(randomUUID(), { name: "Cash Over and Short", type: "expense", number: "6820" }));
    assert.equal(second.status, 422);
    assert.deepEqual(await second.json(), {
      error: "number_in_use",
      field: "number",
      details: {
        existingAccountId: created.account.id,
        existingAccountName: "Cash Over and Short",
        existingAccountNumber: "6820",
      },
    });
  } finally {
    routeState.authz = null;
    await dropScratchOrg(org.orgId);
  }
});

test("renumbering onto another account names the holding account", async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const { adminId } = await withBypassContext(() => seedFlowActors(org.orgId));
    routeState.authz = { user: { orgId: org.orgId, id: adminId }, permissions: new Set(), allowedSubsidiaryIds: null };

    const holder = await POST(postRequest(randomUUID(), { name: "Cash Over and Short", type: "expense", number: "6820" }));
    assert.equal(holder.status, 201);
    const other = await POST(postRequest(randomUUID(), { name: "Spare change", type: "expense", number: "6821" }));
    assert.equal(other.status, 201);
    const otherId = ((await other.json()) as { account: { id: string } }).account.id;

    const clash = await PATCH(
      new Request(`http://localhost/api/accounts/${otherId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ number: "6820" }),
      }),
      { params: Promise.resolve({ id: otherId }) },
    );
    assert.equal(clash.status, 422);
    const body = (await clash.json()) as { error: string; field: string; details: { existingAccountId: string; existingAccountName: string; existingAccountNumber: string } };
    assert.equal(body.error, "number_in_use");
    assert.equal(body.field, "number");
    assert.equal(body.details.existingAccountName, "Cash Over and Short");
    assert.equal(body.details.existingAccountNumber, "6820");
    assert.match(body.details.existingAccountId, /^[0-9a-f-]{36}$/);
  } finally {
    routeState.authz = null;
    await dropScratchOrg(org.orgId);
  }
});
