import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";

/**
 * Dunning policy writes must validate what they store. POST required a
 * non-empty name but stored any gracePeriodDays — a non-numeric value only
 * failed later as an unhandled storage error (500), and a negative or
 * fractional value was stored. PATCH skipped even the name check, so an empty
 * name silently replaced the policy ladder's title.
 */
const root = pathToFileURL(process.cwd() + "/").href;
const state = { user: { orgId: "", id: "" } };
Object.assign(globalThis, { __dunningValidationUser: state });
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return { shortCircuit: true, url: "data:text/javascript,export {}" };
    if (specifier.endsWith("/lib/authz") && context.parentURL?.includes("/api/dunning/")) {
      return {
        shortCircuit: true,
        url:
          "data:text/javascript," +
          encodeURIComponent(
            "export async function guardPermission(){return {user:globalThis.__dunningValidationUser.user,permissions:new Set(['documents.manage']),allowedSubsidiaryIds:null}}export function guardUnrestrictedScope(authz){if(authz.allowedSubsidiaryIds!==null&&authz.allowedSubsidiaryIds!==undefined)return Response.json({error:'requires unrestricted subsidiary access'},{status:403});return null}",
          ),
      };
    }
    if (specifier.startsWith("@/")) return next(root + "web/" + specifier.slice(2) + ".ts", context);
    return next(specifier, context);
  },
});
const { db, withBypassContext } = await import("@openbooks/engine/src/platform/db.ts");
const { sql } = await import("drizzle-orm");
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import("@openbooks/engine/src/testing/fixtures.ts");
const { POST: create } = await import("./route");
const { PATCH: patch } = await import("./[id]/route");

const json = (method: string, body?: unknown) =>
  new Request("http://audit.local/api/dunning", { method, body: body === undefined ? undefined : JSON.stringify(body) });
const params = (id: string) => ({ params: Promise.resolve({ id }) });

async function policyRow(orgId: string, id: string): Promise<{ name: string; grace: number } | undefined> {
  const r = await withBypassContext(() =>
    db.execute<{ name: string; grace: number }>(
      sql`select name, grace_period_days as grace from dunning_policies where id = ${id} and org_id = ${orgId}`,
    ),
  );
  return r.rows[0];
}

const ladderStage = () => ({
  sequence: 1,
  name: "Nudge",
  offsetDays: 7,
  subjectTemplate: "s",
  bodyTemplate: "b",
});

async function stageCount(orgId: string, id: string): Promise<number> {
  const r = await withBypassContext(() =>
    db.execute<{ n: number }>(
      sql`select count(*)::int as n from dunning_stages where policy_id = ${id} and org_id = ${orgId}`,
    ),
  );
  return r.rows[0]!.n;
}

test("dunning writes reject an invalid grace period or an empty name", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    state.user = { orgId: org.orgId, id: (await withBypassContext(() => seedFlowActors(org.orgId))).adminId };

    // gracePeriodDays is stored into an integer column: non-numeric input must
    // be a 4xx, never an unhandled storage error, and negative or fractional
    // values must not be stored.
    for (const gracePeriodDays of ["abc", true, 1.5, -5]) {
      const refused = await create(json("POST", { name: "Chase", gracePeriodDays, stages: [] }));
      assert.equal(refused.status, 400, `POST gracePeriodDays ${JSON.stringify(gracePeriodDays)}`);
    }
    const count = await withBypassContext(() =>
      db.execute<{ n: number }>(sql`select count(*)::int as n from dunning_policies where org_id = ${org.orgId}`),
    );
    assert.equal(count.rows[0]!.n, 0, "a refused policy must not be created");

    const created = await create(json("POST", { name: "Collections", gracePeriodDays: 3, stages: [ladderStage()] }));
    assert.equal(created.status, 201, JSON.stringify(await created.clone().json()));
    const { id } = (await created.json()) as { id: string };

    // PATCH enforces the same contracts: the name POST requires, and a
    // storable grace period.
    for (const gracePeriodDays of ["abc", 2.5, -1]) {
      const refused = await patch(json("PATCH", { gracePeriodDays }), params(id));
      assert.equal(refused.status, 400, `PATCH gracePeriodDays ${JSON.stringify(gracePeriodDays)}`);
    }
    for (const name of ["", "   ", 7]) {
      const refused = await patch(json("PATCH", { name }), params(id));
      assert.equal(refused.status, 400, `PATCH name ${JSON.stringify(name)}`);
    }
    assert.deepEqual(await policyRow(org.orgId, id), { name: "Collections", grace: 3 });

    // Controls: valid values still write on both paths.
    const renamed = await patch(json("PATCH", { name: "Collections (AR)", gracePeriodDays: 0 }), params(id));
    assert.equal(renamed.status, 200, JSON.stringify(await renamed.clone().json()));
    assert.deepEqual(await policyRow(org.orgId, id), { name: "Collections (AR)", grace: 0 });
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("dunning writes refuse blank stage templates with the fix named", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  // A-S20: a blank template renders an empty letter. The boundary refuses
  // it with a named remedy instead of the generic shape error, and stores
  // nothing; non-blank templates still store on both paths.
  const org = await withBypassContext(() => createScratchOrg());
  try {
    state.user = { orgId: org.orgId, id: (await withBypassContext(() => seedFlowActors(org.orgId))).adminId };
    const blank = (field: string) => ({
      sequence: 1,
      name: "Nudge",
      offsetDays: 7,
      subjectTemplate: "s",
      bodyTemplate: "b",
      [field]: "   ",
    });
    for (const field of ["subjectTemplate", "bodyTemplate"]) {
      const refused = await create(json("POST", { name: "Chase", stages: [blank(field)] }));
      assert.equal(refused.status, 400, `POST blank ${field}`);
      assert.deepEqual(await refused.json(), { error: "stage subject and body templates must not be blank" });
    }
    const count = await withBypassContext(() =>
      db.execute<{ n: number }>(sql`select count(*)::int as n from dunning_policies where org_id = ${org.orgId}`),
    );
    assert.equal(count.rows[0]!.n, 0, "a refused policy must not be created");

    const created = await create(json("POST", { name: "Collections", stages: [ladderStage()] }));
    assert.equal(created.status, 201, JSON.stringify(await created.clone().json()));
    const { id } = (await created.json()) as { id: string };
    const refusedPatch = await patch(json("PATCH", { stages: [blank("bodyTemplate")] }), params(id));
    assert.equal(refusedPatch.status, 400);
    assert.deepEqual(await refusedPatch.json(), { error: "stage subject and body templates must not be blank" });
    assert.equal(await stageCount(org.orgId, id), 1, "refused restage keeps the ladder");
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("dunning writes reject an invalid reply-to and store a valid one", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    state.user = { orgId: org.orgId, id: (await withBypassContext(() => seedFlowActors(org.orgId))).adminId };
    const replyOf = async (id: string) =>
      (await withBypassContext(() =>
        db.execute<{ replyTo: string | null }>(
          sql`select reply_to as "replyTo" from dunning_policies where id = ${id} and org_id = ${org.orgId}`,
        ),
      )).rows[0]?.replyTo;

    // POST: malformed reply-to values are 400s and create nothing.
    for (const replyTo of ["not-an-email", "", 7]) {
      const refused = await create(json("POST", { name: "Chase", gracePeriodDays: 3, stages: [], replyTo }));
      assert.equal(refused.status, 400, `POST replyTo ${JSON.stringify(replyTo)}`);
    }
    const count = await withBypassContext(() =>
      db.execute<{ n: number }>(sql`select count(*)::int as n from dunning_policies where org_id = ${org.orgId}`),
    );
    assert.equal(count.rows[0]!.n, 0, "a refused policy must not be created");

    // POST: a valid reply-to stores; omission stores null (org default applies).
    const stored = await create(
      json("POST", { name: "Collections", gracePeriodDays: 3, stages: [ladderStage()], replyTo: "ar@example.com" }),
    );
    assert.equal(stored.status, 201, JSON.stringify(await stored.clone().json()));
    const { id } = (await stored.json()) as { id: string };
    assert.equal(await replyOf(id), "ar@example.com");

    // PATCH enforces the same contract, and null clears back to the default.
    for (const replyTo of ["also-bad", 9]) {
      const refused = await patch(json("PATCH", { replyTo }), params(id));
      assert.equal(refused.status, 400, `PATCH replyTo ${JSON.stringify(replyTo)}`);
    }
    assert.equal(await replyOf(id), "ar@example.com", "a refused patch must not change the row");
    const cleared = await patch(json("PATCH", { replyTo: null }), params(id));
    assert.equal(cleared.status, 200, JSON.stringify(await cleared.clone().json()));
    assert.equal(await replyOf(id), null);
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});
