import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";
import { isUuid } from "@openbooks/engine/platform/identifiers";

// A duplicate account number must refuse with the holding account named:
// the 422 carries details { existingAccountId, existingAccountName,
// existingAccountNumber } so the drawer can link the account instead of
// leaving the operator guessing. Only the session gate is stubbed.
const stateKey = Symbol.for("openbooks.account-duplicate-test");
const routeState: {
  authz: {
    user: { orgId: string; id: string; roles: Array<{ key: string }> };
    permissions: Set<string>;
    allowedSubsidiaryIds: Set<string> | null;
  } | null;
} = { authz: null };
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

const { POST } = (await import(
  new URL("./route.ts?account-duplicate-post", import.meta.url).href
)) as typeof import("./route.ts");
const { PATCH } = (await import(
  new URL("./[id]/route.ts?account-duplicate-patch", import.meta.url).href
)) as typeof import("./[id]/route.ts");
const { withBypassContext, db } = await import("@openbooks/engine/platform/db");
const { createScratchOrg, dropScratchOrg, seedFlowActors } =
  await import("@openbooks/engine/testing/fixtures");

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
    routeState.authz = {
      user: { orgId: org.orgId, id: adminId, roles: [{ key: "admin" }] },
      permissions: new Set(),
      allowedSubsidiaryIds: null,
    };

    const first = await POST(
      postRequest(randomUUID(), { name: "Cash Over and Short", type: "expense", number: "6820" }),
    );
    assert.equal(first.status, 201, JSON.stringify(await first.clone().json()));
    const created = (await first.json()) as { account: { id: string } };

    const second = await POST(
      postRequest(randomUUID(), { name: "Cash Variance", type: "expense", number: "6820" }),
    );
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
    routeState.authz = {
      user: { orgId: org.orgId, id: adminId, roles: [{ key: "admin" }] },
      permissions: new Set(),
      allowedSubsidiaryIds: null,
    };

    const holder = await POST(
      postRequest(randomUUID(), { name: "Cash Over and Short", type: "expense", number: "6820" }),
    );
    assert.equal(holder.status, 201);
    const other = await POST(
      postRequest(randomUUID(), { name: "Spare change", type: "expense", number: "6821" }),
    );
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
    const body = (await clash.json()) as {
      error: string;
      field: string;
      details: {
        existingAccountId: string;
        existingAccountName: string;
        existingAccountNumber: string;
      };
    };
    assert.equal(body.error, "number_in_use");
    assert.equal(body.field, "number");
    assert.equal(body.details.existingAccountName, "Cash Over and Short");
    assert.equal(body.details.existingAccountNumber, "6820");
    assert.ok(
      isUuid(body.details.existingAccountId),
      "the refusal names the existing account by id",
    );
  } finally {
    routeState.authz = null;
    await dropScratchOrg(org.orgId);
  }
});

test("a same-name account is refused until the duplicate is acknowledged", async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const { adminId } = await withBypassContext(() => seedFlowActors(org.orgId));
    routeState.authz = {
      user: { orgId: org.orgId, id: adminId, roles: [{ key: "admin" }] },
      permissions: new Set(),
      allowedSubsidiaryIds: null,
    };

    const holder = await POST(
      postRequest(randomUUID(), {
        name: "Interest Expense",
        type: "expense_other",
        number: "7000",
      }),
    );
    assert.equal(holder.status, 201);
    const holderId = ((await holder.json()) as { account: { id: string } }).account.id;

    const refused = await POST(
      postRequest(randomUUID(), {
        name: "  interest   EXPENSE ",
        type: "expense_other",
        number: "8100",
      }),
    );
    assert.equal(refused.status, 409);
    assert.deepEqual(await refused.json(), {
      error: "duplicate_account_name",
      field: "name",
      remedy:
        "Open the existing account, or resend the request with acknowledgeDuplicateName set to true to create it anyway.",
      details: {
        existingAccountId: holderId,
        existingAccountName: "Interest Expense",
        existingAccountNumber: "7000",
      },
    });
    const unchanged = await withBypassContext(() =>
      db.execute(
        sql`select count(*)::int as n from accounts where org_id = ${org.orgId} and number = '8100'`,
        "objects",
      ),
    );
    assert.equal((unchanged[0] as { n: number }).n, 0, "a refused create writes no account row");

    const acknowledgedKey = randomUUID();
    const acknowledged = await POST(
      postRequest(acknowledgedKey, {
        name: "  interest   EXPENSE ",
        type: "expense_other",
        number: "8100",
        acknowledgeDuplicateName: true,
      }),
    );
    assert.equal(acknowledged.status, 201, JSON.stringify(await acknowledged.clone().json()));
    const payload = (await acknowledged.json()) as {
      warnings: { code: string; existingAccountId: string }[];
    };
    assert.deepEqual(
      payload.warnings.map((w) => [w.code, w.existingAccountId]),
      [["duplicate_account_name", holderId]],
    );

    const replay = await POST(
      postRequest(acknowledgedKey, {
        name: "  interest   EXPENSE ",
        type: "expense_other",
        number: "8100",
        acknowledgeDuplicateName: true,
      }),
    );
    assert.equal(
      replay.status,
      200,
      "a retry of an acknowledged create replays the stored account instead of refusing itself",
    );
  } finally {
    routeState.authz = null;
    await dropScratchOrg(org.orgId);
  }
});

test("renaming onto an active account's name is refused until acknowledged", async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const { adminId } = await withBypassContext(() => seedFlowActors(org.orgId));
    routeState.authz = {
      user: { orgId: org.orgId, id: adminId, roles: [{ key: "admin" }] },
      permissions: new Set(),
      allowedSubsidiaryIds: null,
    };

    const holder = await POST(
      postRequest(randomUUID(), {
        name: "Interest Expense",
        type: "expense_other",
        number: "7000",
      }),
    );
    assert.equal(holder.status, 201);
    const other = await POST(
      postRequest(randomUUID(), { name: "Bank charges", type: "expense_other", number: "7100" }),
    );
    assert.equal(other.status, 201);
    const otherId = ((await other.json()) as { account: { id: string } }).account.id;
    const patch = (body: unknown) =>
      PATCH(
        new Request(`http://localhost/api/accounts/${otherId}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
        { params: Promise.resolve({ id: otherId }) },
      );

    const refused = await patch({ name: "Interest Expense" });
    assert.equal(refused.status, 409);
    assert.equal(((await refused.json()) as { error: string }).error, "duplicate_account_name");

    const acknowledged = await patch({ name: "Interest Expense", acknowledgeDuplicateName: true });
    assert.equal(acknowledged.status, 200, JSON.stringify(await acknowledged.clone().json()));
    const saved = (await acknowledged.json()) as {
      account: { name: string };
      warnings: { code: string }[];
    };
    assert.equal(saved.account.name, "Interest Expense");
    assert.deepEqual(
      saved.warnings.map((w) => w.code),
      ["duplicate_account_name"],
    );
  } finally {
    routeState.authz = null;
    await dropScratchOrg(org.orgId);
  }
});
