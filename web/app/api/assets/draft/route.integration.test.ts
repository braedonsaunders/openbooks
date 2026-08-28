import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";
import { NextRequest } from "next/server";

// Live-Postgres regression for fnd_mtcb42ht_vieu7b: draft creation used to
// read max(FA-####)+1 and insert in separate autocommit statements. The two
// requests below are forced to overlap at the insert trigger; both must still
// commit distinct asset identities, and first-use category creation must leave
// exactly one default category.
const stateKey = Symbol.for("openbooks.asset-draft-route-test");
interface RouteState {
  authz: {
    user: { orgId: string; id: string };
    permissions: Set<string>;
    allowedSubsidiaryIds: null;
  } | null;
}
const routeState: RouteState = { authz: null };
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] =
  routeState;

const mockFeatureGates = `
  const state = globalThis[Symbol.for('openbooks.asset-draft-route-test')]
  export async function guardFeaturePermission(_permission, _featureKey) {
    if (!state.authz) return new Response(null, { status: 403 })
    return state.authz
  }
`;

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return {
        shortCircuit: true,
        format: "module",
        url: "data:text/javascript,export {}",
      };
    }
    if (
      specifier === "../../../../lib/feature-gates" &&
      context.parentURL?.includes("/api/assets/draft/")
    ) {
      return { url: "mock:asset-draft-feature-gates", shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "mock:asset-draft-feature-gates") {
      return { format: "module", source: mockFeatureGates, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const routeUrl = "./route.ts?asset-draft-concurrency-test";
const { POST } = (await import(routeUrl)) as typeof import("./route.ts");
hooks.deregister();

const { db, withBypassContext, withOrgContext } =
  await import("@openbooks/engine/src/db.ts");
const { createScratchOrg, dropScratchOrg, seedFlowActors } =
  await import("@openbooks/engine/src/test-fixtures.ts");
const DB = !!process.env.OPENBOOKS_DB_URL;

interface Fixture {
  orgId: string;
  actorId: string;
  triggerFunction: string;
  triggerName: string;
}

async function installInsertPause(): Promise<
  Pick<Fixture, "triggerFunction" | "triggerName">
> {
  const suffix = randomUUID().replaceAll("-", "");
  const triggerFunction = `asset_draft_pause_${suffix}`;
  const triggerName = `asset_draft_pause_trigger_${suffix}`;
  await withBypassContext(() =>
    db.execute(
      sql.raw(`
        create function public."${triggerFunction}"() returns trigger
        language plpgsql as $$
        begin
          perform pg_sleep(0.15);
          return new;
        end;
        $$;
        create trigger "${triggerName}"
          before insert on public.fixed_assets
          for each row execute function public."${triggerFunction}"();
      `),
    ),
  );
  return { triggerFunction, triggerName };
}

async function removeInsertPause(
  triggerFunction: string,
  triggerName: string,
): Promise<void> {
  await withBypassContext(() =>
    db.execute(
      sql.raw(`
        drop trigger if exists "${triggerName}" on public.fixed_assets;
        drop function if exists public."${triggerFunction}"();
      `),
    ),
  );
}

async function seed(): Promise<Fixture> {
  const org = await createScratchOrg();
  const actorId = (await seedFlowActors(org.orgId)).adminId;
  const pause = await installInsertPause();
  routeState.authz = {
    user: { orgId: org.orgId, id: actorId },
    permissions: new Set(["*"]),
    allowedSubsidiaryIds: null,
  };
  return { orgId: org.orgId, actorId, ...pause };
}

function post(fixture: Fixture): Promise<Response> {
  return withOrgContext(fixture.orgId, () =>
    POST(new NextRequest("http://openbooks.test/api/assets/draft", { method: "POST" })),
  );
}

test(
  "concurrent asset drafts receive distinct numbers and one default category",
  { skip: !DB },
  async () => {
    const fixture = await seed();
    try {
      const responses = await Promise.all([post(fixture), post(fixture)]);
      assert.deepEqual(
        responses
          .map((response) => response.status)
          .sort((left, right) => left - right),
        [200, 200],
        "both concurrent drafts must commit instead of colliding on an asset number",
      );
      const ids = (
        await Promise.all(
          responses.map(
            async (response) => (await response.json()) as { id: string },
          ),
        )
      ).map((body) => body.id);

      const state = await withOrgContext(fixture.orgId, async () =>
        db.execute<{ asset_number: string; category_count: number }>(sql`
          select fa.asset_number,
                 (select count(*)::int from asset_categories
                   where org_id = ${fixture.orgId} and name = 'Uncategorised') as category_count
            from fixed_assets fa
           where fa.org_id = ${fixture.orgId}
             and fa.id in (${sql.join(
               ids.map((id) => sql`${id}`),
               sql`, `,
             )})
           order by fa.asset_number`),
      );
      assert.deepEqual(
        state.rows.map((row) => row.asset_number),
        ["FA-0001", "FA-0002"],
        "the org-wide allocator must serialize max()+1 and preserve both identities",
      );
      assert.equal(
        state.rows[0]?.category_count,
        1,
        "first-use category creation must be idempotent",
      );
    } finally {
      routeState.authz = null;
      await removeInsertPause(fixture.triggerFunction, fixture.triggerName);
      await dropScratchOrg(fixture.orgId);
    }
  },
);
