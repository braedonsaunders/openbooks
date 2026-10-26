import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test, { after } from "node:test";
import { resolveEngineSpecifier } from "../../../../testing/engine-resolve-hooks.ts";
import type { ApplicationContext } from "../../../../lib/application/context";

// Uppercase spellings of a granted scope must canonicalize before the
// application scope check, at both the route and application boundaries:
// the same entity reads fine in either case, while an unknown period or a
// foreign entity is still refused. Only the session gate is stubbed; query
// parsing, the application wrapper and the engine run for real.
const state: { orgId: string; actorId: string; subsidiaryId: string } = {
  orgId: "",
  actorId: "",
  subsidiaryId: "",
};
Object.assign(globalThis, { __periodLockRouteState: state });
const virtual = (source: string) => ({
  shortCircuit: true as const,
  url: "data:text/javascript," + encodeURIComponent(source),
});
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    // The route factory resolves its permission gate by @/ alias at request
    // time; serve the intended session only for that factory import, never
    // for the application layer's own authorization code.
    if (specifier === "@/lib/authz" && context.parentURL?.includes("/lib/api/route")) {
      return virtual(`
        export async function guardPermission() {
          const s = globalThis.__periodLockRouteState;
          return {
            user: { orgId: s.orgId, id: s.actorId },
            permissions: new Set(["close.read"]),
            allowedSubsidiaryIds: new Set([s.subsidiaryId]),
          };
        }
      `);
    }
    const engineUrl = resolveEngineSpecifier(specifier);
    if (engineUrl) return nextResolve(engineUrl, context);
    return nextResolve(specifier, context);
  },
});
after(() => hooks.deregister());

const { GET } = (await import("./route.ts")) as typeof import("./route.ts");
const { readApplicationPeriodLocks } = await import("../../../../lib/application/close");
const { ApplicationError } = await import("../../../../lib/application/errors");
const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/platform/db");
const { sql } = await import("drizzle-orm");
const { createScratchOrg, createScratchUser, dropScratchOrg, grantScratchPermissions } =
  await import("@openbooks/engine/testing/fixtures");

const DB = !!process.env.OPENBOOKS_DB_URL;

async function fixture() {
  const org = await withBypassContext(() => createScratchOrg());
  const roleKey = `lock_reader_${randomUUID().slice(0, 8)}`;
  const actorId = await withBypassContext(() =>
    createScratchUser(org.orgId, "Lock Reader", roleKey),
  );
  const otherId = randomUUID();
  await withBypassContext(async () => {
    await db.execute(sql`
      update app_roles
         set subsidiary_restriction = ${JSON.stringify({ mode: "list", subsidiaryIds: [org.subsidiaryId] })}::jsonb
       where org_id = ${org.orgId} and key = ${roleKey}`);
    await db.execute(sql`
      insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
      values (${otherId}, ${org.orgId}, ${org.subsidiaryId}, 'Other Entity', 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb)`);
    await db.execute(sql`
      insert into period_locks (org_id, period_id, book_id, subsidiary_id, module, state, reason, created_by, updated_by)
      values (${org.orgId}, ${org.periodId}, ${org.bookId}, ${org.subsidiaryId}, 'gl', 'closed',
              'period-lock route fixture', ${actorId}, ${actorId})`);
  });
  await grantScratchPermissions(org.orgId, actorId, ["close.read"]);
  state.orgId = org.orgId;
  state.actorId = actorId;
  state.subsidiaryId = org.subsidiaryId;
  return { org, actorId, otherId };
}

function contextFor(orgId: string, actorId: string, subsidiaryId: string): ApplicationContext {
  return {
    authz: {
      user: {
        id: actorId,
        orgId,
        name: "Lock Reader",
        email: "lock@scratch.test",
        roles: [],
        isSuperAdmin: false,
        envKind: "production",
        productionOrgId: orgId,
        homeOrgId: orgId,
        homeUserId: actorId,
      },
      permissions: new Set(["close.read"]),
      allowedSubsidiaryIds: new Set([subsidiaryId]),
    },
    source: "api",
    requestId: randomUUID(),
    apiKeyId: null,
  };
}

const upper = (value: string) => value.toUpperCase();

test(
  "route canonicalizes an uppercase exact scope for a scoped reader, and still refuses unknown and foreign scopes",
  { skip: !DB },
  async () => {
    const { org, otherId } = await fixture();
    try {
      const get = (query: string) =>
        withOrgContext(org.orgId, () =>
          GET(new Request(`http://close.test/api/close/locks?${query}`)),
        );

      const own = await get(
        `periodId=${upper(org.periodId)}&bookId=${upper(org.bookId)}&subsidiaryId=${upper(org.subsidiaryId)}`,
      );
      assert.equal(own.status, 200);
      const body = (await own.json()) as {
        locks: {
          periodId: string;
          subsidiaryId: string;
          modules: { module: string; state: string }[];
        };
      };
      assert.equal(body.locks.periodId, org.periodId);
      assert.equal(body.locks.subsidiaryId, org.subsidiaryId);
      assert.equal(body.locks.modules.find((entry) => entry.module === "gl")?.state, "closed");

      const foreign = await get(
        `periodId=${upper(org.periodId)}&bookId=${upper(org.bookId)}&subsidiaryId=${upper(otherId)}`,
      );
      assert.equal(foreign.status, 403);

      const unknown = await get(
        `periodId=${upper(randomUUID())}&bookId=${upper(org.bookId)}&subsidiaryId=${upper(org.subsidiaryId)}`,
      );
      assert.equal(unknown.status, 422);

      const malformed = await get(
        `periodId=not-a-uuid&bookId=${org.bookId}&subsidiaryId=${org.subsidiaryId}`,
      );
      assert.equal(malformed.status, 400);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "application canonicalizes an uppercase exact scope before its scope check, and still refuses unknown and foreign scopes",
  { skip: !DB },
  async () => {
    const { org, actorId, otherId } = await fixture();
    try {
      const context = contextFor(org.orgId, actorId, org.subsidiaryId);
      const result = await withOrgContext(org.orgId, () =>
        readApplicationPeriodLocks(context, {
          periodId: upper(org.periodId),
          bookId: upper(org.bookId),
          subsidiaryId: upper(org.subsidiaryId),
        }),
      );
      assert.equal(result.periodId, org.periodId);
      assert.equal(result.subsidiaryId, org.subsidiaryId);

      await assert.rejects(
        withOrgContext(org.orgId, () =>
          readApplicationPeriodLocks(context, {
            periodId: upper(org.periodId),
            bookId: upper(org.bookId),
            subsidiaryId: upper(otherId),
          }),
        ),
        (error: unknown) => error instanceof ApplicationError && error.status === 403,
      );
      await assert.rejects(
        withOrgContext(org.orgId, () =>
          readApplicationPeriodLocks(context, {
            periodId: upper(randomUUID()),
            bookId: upper(org.bookId),
            subsidiaryId: upper(org.subsidiaryId),
          }),
        ),
        (error: unknown) => error instanceof ApplicationError && error.status === 422,
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);
