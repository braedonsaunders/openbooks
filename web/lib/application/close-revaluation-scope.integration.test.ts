import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";

// The application-layer revaluation entry must fail closed on an empty caller
// subsidiary scope before the idempotent execution is recorded: no journal
// entries and no idempotency-key row. Only server-only is stubbed; the
// application function and the engine run for real.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    if (specifier.startsWith("@/")) {
      return nextResolve(new URL(`../../${specifier.slice(2)}`, import.meta.url).href, context);
    }
    return nextResolve(specifier, context);
  },
});

const { sql } = await import("drizzle-orm");
const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import("@openbooks/engine/src/testing/fixtures.ts");
const { runPeriodRevaluation } = await import("./close.ts");
const { ApplicationError } = await import("./errors.ts");
type ApplicationContext = import("./context.ts").ApplicationContext;

const DB = !!process.env.OPENBOOKS_DB_URL;

async function fixture() {
  const org = await withBypassContext(() => createScratchOrg());
  const actor = await withBypassContext(() => createScratchUser(org.orgId, "Revaluation caller", "revaluation_caller"));
  const unrealizedId = (await withBypassContext(() => db.execute<{ id: string }>(sql`
    insert into accounts (id, org_id, number, name, type, is_summary, is_active, eliminate, reconcilable, required_dimensions, custom, subsidiary_include_children)
    values (${randomUUID()}, ${org.orgId}, '7990', 'Unrealized FX', 'expense_other', false, true, false, false, '{}'::jsonb, '{}'::jsonb, true)
    returning id`))).rows[0]!.id;
  await withBypassContext(() => db.execute(sql`
    update orgs set settings = jsonb_set(settings, '{features}',
      coalesce(settings->'features','{}'::jsonb) || '{"multiCurrency": true}'::jsonb)
     where id = ${org.orgId}`));
  await withBypassContext(() => db.execute(sql`
    update orgs set settings = jsonb_set(settings, '{controlAccounts}',
      coalesce(settings->'controlAccounts','{}'::jsonb) || ${JSON.stringify({ fxUnrealizedGainLoss: unrealizedId })}::jsonb)
     where id = ${org.orgId}`));
  return { org, actor };
}

function contextFor(orgId: string, actor: string, allowed: Set<string> | null): ApplicationContext {
  return {
    authz: {
      user: { id: actor, orgId, name: "Revaluation caller", email: "r@scratch.test", roles: [], isSuperAdmin: false, envKind: "production", productionOrgId: orgId, homeOrgId: orgId, homeUserId: actor },
      permissions: new Set(["close.run"]),
      allowedSubsidiaryIds: allowed,
    },
    source: "api",
    requestId: randomUUID(),
    apiKeyId: null,
  };
}

async function fxEntryCount(orgId: string): Promise<number> {
  const rows = (await withOrgContext(orgId, () => db.execute<{ n: number }>(sql`
    select count(*)::int as n from journal_entries
     where org_id = ${orgId} and origin = 'fx_revaluation'`))).rows;
  return rows[0]!.n;
}

async function idempotencyCount(orgId: string, key: string): Promise<number> {
  const rows = (await withOrgContext(orgId, () => db.execute<{ n: number }>(sql`
    select count(*)::int as n from application_idempotency_keys
     where org_id = ${orgId} and operation = 'close.revaluation.run' and idempotency_key = ${key}`))).rows;
  return rows[0]!.n;
}

test("runPeriodRevaluation refuses an empty caller scope with no side effects", { skip: !DB }, async () => {
  const { org, actor } = await fixture();
  const key = randomUUID();
  try {
    let error: unknown;
    await withOrgContext(org.orgId, async () => {
      try {
        await runPeriodRevaluation(contextFor(org.orgId, actor, new Set()), {
          periodId: org.periodId,
          idempotencyKey: key,
        });
      } catch (caught) {
        error = caught;
      }
      assert.ok(error instanceof ApplicationError, "empty scope must be refused");
      assert.equal(error.code, "forbidden");
      assert.equal(error.status, 403);
      assert.match(error.message, /no subsidiaries are in the caller's close scope/);
      assert.match(error.message, /administrator/);
    });
    // Refused before the idempotent execution was recorded: no journals, no key row.
    assert.equal(await fxEntryCount(org.orgId), 0);
    assert.equal(await idempotencyCount(org.orgId, key), 0);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("runPeriodRevaluation still runs organization-wide for an unrestricted caller", { skip: !DB }, async () => {
  const { org, actor } = await fixture();
  try {
    const outcome = await withOrgContext(org.orgId, () => runPeriodRevaluation(contextFor(org.orgId, actor, null), {
      periodId: org.periodId,
      idempotencyKey: randomUUID(),
    }));
    assert.equal(outcome.replayed, false);
    assert.ok(Array.isArray((outcome.result as { posted?: unknown }).posted));
    assert.ok(Array.isArray((outcome.result as { skipped?: unknown }).skipped));
    assert.equal(await fxEntryCount(org.orgId), 0);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
