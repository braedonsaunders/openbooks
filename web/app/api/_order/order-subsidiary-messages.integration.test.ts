import { documentRevisionCounterSql } from "@openbooks/engine/records/revision";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import type { SessionUser } from "../../../lib/auth";
import { sql } from "drizzle-orm";

// Live-Postgres regression: the shared order PATCH refused four distinct
// subsidiary failures with one sentence — 'Subsidiary is not available' —
// whether the body carried a non-string, the target sat outside the caller's
// scope, the row was missing/inactive/elimination, or a restricted caller
// cleared the field. Each refusal must name which predicate failed.

// The real route resolves the caller from the session exactly as in
// production: the test supplies only the signed-in identity, and the user's
// roles grant its permissions and subsidiary scope.
const session: { user: SessionUser | null } = { user: null };
Object.assign(globalThis, { __orderSubsidiaryMessagesSession: session });
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "./auth" && context.parentURL?.endsWith("/web/lib/authz.ts")) {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export async function currentUser(){return globalThis.__orderSubsidiaryMessagesSession.user}",
      };
    }
    return nextResolve(specifier, context);
  },
});

function signIn(orgId: string, userId: string): void {
  session.user = {
    id: userId,
    orgId,
    name: "Order editor",
    email: "order-editor@scratch.test",
    roles: [],
    isSuperAdmin: false,
    envKind: "production",
    productionOrgId: orgId,
    homeOrgId: orgId,
    homeUserId: userId,
  };
}

const { PATCH } = await import("../estimates/[id]/route.ts");

const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/platform/db");
const { createScratchOrg, createScratchUser, dropScratchOrg, seedFlowActors } =
  await import("@openbooks/engine/testing/fixtures");

interface Fixture {
  orgId: string;
  actorId: string;
  scopedActorId: string;
  orderId: string;
  rootSubsidiaryId: string;
  otherSubsidiaryId: string;
}

async function seedDraftQuote(tag: string): Promise<Fixture> {
  return withBypassContext(async () => {
    const org = await createScratchOrg();
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    // An estimator whose role confines it to the root subsidiary.
    const scopedActorId = await createScratchUser(
      org.orgId,
      "Scoped estimator",
      "scoped_estimator",
    );
    const scoped = await db.execute(
      sql`
      update app_roles
         set permissions = '["estimates.read","estimates.create"]'::jsonb,
             subsidiary_restriction = ${JSON.stringify({ mode: "list", subsidiaryIds: [org.subsidiaryId] })}::jsonb
       where org_id = ${org.orgId} and key = 'scoped_estimator'
       returning key`,
      "objects",
    );
    assert.equal(scoped.length, 1);
    const otherSubsidiaryId = randomUUID();
    await db.execute(sql`
      insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
      values (${otherSubsidiaryId}, ${org.orgId}, ${org.subsidiaryId}, 'Other Co', 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb)`);
    // Pin the subsidiaries feature on: its default counts active
    // non-elimination subsidiaries, so deactivating the second one below
    // would otherwise switch the surface under test off mid-fixture.
    await db.execute(sql`
      update orgs set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features}',
        coalesce(settings->'features','{}'::jsonb) || '{"multiSubsidiary": true}'::jsonb)
       where id = ${org.orgId}`);
    const orderId = randomUUID();
    await db.execute(sql`
      insert into documents(
        id, org_id, kind, document_number, document_date, party_id, subsidiary_id,
        currency, status, subtotal, tax_total, total, memo
      ) values (
        ${orderId}, ${org.orgId}, 'quote', ${tag}, ${org.date}, ${org.customerId},
        ${org.subsidiaryId}, 'CAD', 'draft', 0, 0, 0, 'Subsidiary-message terms'
      )
    `);
    return {
      orgId: org.orgId,
      actorId,
      scopedActorId,
      orderId,
      rootSubsidiaryId: org.subsidiaryId,
      otherSubsidiaryId,
    };
  });
}

/** Unrestricted callers see every subsidiary; restricted ones only the root. */
type Scope = "unrestricted" | "restricted";

async function patchRequest(
  fixture: Fixture,
  body: Record<string, unknown>,
  scope: Scope,
): Promise<Request> {
  signIn(fixture.orgId, scope === "restricted" ? fixture.scopedActorId : fixture.actorId);
  const revision = await withOrgContext(
    fixture.orgId,
    async () =>
      (
        await db.execute<{ revision: string }>(
          sql`
      select ${documentRevisionCounterSql(sql`revision_seq`)} as revision
        from documents where id = ${fixture.orderId}`,
          "objects",
        )
      )[0]!.revision,
  );
  return new Request(`http://openbooks.test/api/quotes/${fixture.orderId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ expectedUpdatedAt: revision, ...body }),
  });
}

async function patchError(
  fixture: Fixture,
  body: Record<string, unknown>,
  scope: Scope,
): Promise<{ status: number; error: string }> {
  const response = await withOrgContext(fixture.orgId, async () =>
    PATCH(await patchRequest(fixture, body, scope), {
      params: Promise.resolve({ id: fixture.orderId }),
    }),
  );
  return {
    status: response.status,
    error: ((await response.json()) as { error?: string }).error ?? "",
  };
}

test("order PATCH names a non-string subsidiary as a shape error", async () => {
  const fixture = await seedDraftQuote("Q-SUB-1");
  try {
    const { status, error } = await patchError(fixture, { subsidiaryId: 12345 }, "unrestricted");
    assert.equal(status, 422);
    assert.match(error, /order subsidiary must be a subsidiary id string/);
    assert.match(error, /received number/);
  } finally {
    session.user = null;
    await withBypassContext(() => dropScratchOrg(fixture.orgId));
  }
});

test("order PATCH names a subsidiary outside the caller's scope", async () => {
  const fixture = await seedDraftQuote("Q-SUB-2");
  try {
    const { status, error } = await patchError(
      fixture,
      { subsidiaryId: fixture.otherSubsidiaryId },
      "restricted",
    );
    assert.equal(status, 422);
    assert.match(
      error,
      new RegExp(`subsidiary "${fixture.otherSubsidiaryId}" is outside your visible subsidiaries`),
    );
  } finally {
    session.user = null;
    await withBypassContext(() => dropScratchOrg(fixture.orgId));
  }
});

test("order PATCH names a subsidiary id that matches no row", async () => {
  const fixture = await seedDraftQuote("Q-SUB-3");
  try {
    const missing = randomUUID();
    const { status, error } = await patchError(fixture, { subsidiaryId: missing }, "unrestricted");
    assert.equal(status, 422);
    assert.match(error, new RegExp(`no subsidiary "${missing}" in this organization`));
  } finally {
    session.user = null;
    await withBypassContext(() => dropScratchOrg(fixture.orgId));
  }
});

test("order PATCH names an inactive and an elimination subsidiary", async () => {
  const fixture = await seedDraftQuote("Q-SUB-4");
  try {
    await withBypassContext(async () => {
      await db.execute(
        sql`update subsidiaries set is_active = false where id = ${fixture.otherSubsidiaryId}`,
      );
    });
    const dormant = await patchError(
      fixture,
      { subsidiaryId: fixture.otherSubsidiaryId },
      "unrestricted",
    );
    assert.equal(dormant.status, 422);
    assert.match(dormant.error, /is inactive/);
    await withBypassContext(async () => {
      await db.execute(
        sql`update subsidiaries set is_active = true, is_elimination = true where id = ${fixture.otherSubsidiaryId}`,
      );
    });
    const wash = await patchError(
      fixture,
      { subsidiaryId: fixture.otherSubsidiaryId },
      "unrestricted",
    );
    assert.equal(wash.status, 422);
    assert.match(wash.error, /is an elimination entity/);
  } finally {
    session.user = null;
    await withBypassContext(() => dropScratchOrg(fixture.orgId));
  }
});

test("order PATCH names clearing the subsidiary under restricted scope", async () => {
  const fixture = await seedDraftQuote("Q-SUB-5");
  try {
    const { status, error } = await patchError(fixture, { subsidiaryId: null }, "restricted");
    assert.equal(status, 422);
    assert.match(
      error,
      /clearing the order subsidiary is not available with restricted subsidiary scope/,
    );
  } finally {
    session.user = null;
    await withBypassContext(() => dropScratchOrg(fixture.orgId));
  }
});
