import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";

/**
 * Dunning policy writes must take isActive as a real boolean. POST coerced
 * with `!== false` and PATCH with `Boolean()`, so isActive: "false" (or 0)
 * silently ACTIVATED the policy with a 2xx — an admin who switched a
 * collections ladder off keeps chasing debtors. Same boolean-flag class as
 * the project-types/close fixes (w13): refuse non-booleans, default
 * omission to active.
 */
const root = pathToFileURL(process.cwd() + "/").href;
const state = { user: { orgId: "", id: "" } };
Object.assign(globalThis, { __dunningActiveFlagUser: state });
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return { shortCircuit: true, url: "data:text/javascript,export {}" };
    if (specifier.endsWith("/lib/authz") && context.parentURL?.includes("/api/dunning/")) {
      return {
        shortCircuit: true,
        url:
          "data:text/javascript," +
          encodeURIComponent(
            "export async function guardPermission(){return {user:globalThis.__dunningActiveFlagUser.user,permissions:new Set(['documents.manage']),allowedSubsidiaryIds:null}}",
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

async function activeFlag(orgId: string, id: string): Promise<boolean | undefined> {
  const r = await withBypassContext(() =>
    db.execute<{ is_active: boolean }>(
      sql`select is_active from dunning_policies where id = ${id} and org_id = ${orgId}`,
    ),
  );
  return r.rows[0]?.is_active;
}

async function stageCount(orgId: string, id: string): Promise<number> {
  const r = await withBypassContext(() =>
    db.execute<{ n: number }>(
      sql`select count(*)::int as n from dunning_stages where policy_id = ${id} and org_id = ${orgId}`,
    ),
  );
  return r.rows[0]!.n;
}

const ladderStage = () => ({
  sequence: 1,
  name: "Nudge",
  offsetDays: 7,
  subjectTemplate: "s",
  bodyTemplate: "b",
});

test("dunning writes refuse a non-boolean isActive without writing", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    state.user = { orgId: org.orgId, id: (await withBypassContext(() => seedFlowActors(org.orgId))).adminId };

    // A string "false" must not create an ACTIVE policy with a 201.
    for (const isActive of ["false", 0, 1, "yes"]) {
      const refused = await create(json("POST", { name: "Chase", isActive, stages: [] }));
      assert.equal(refused.status, 400, `POST isActive ${JSON.stringify(isActive)}: ${await refused.clone().text()}`);
    }
    const count = await withBypassContext(() =>
      db.execute<{ n: number }>(sql`select count(*)::int as n from dunning_policies where org_id = ${org.orgId}`),
    );
    assert.equal(count.rows[0]!.n, 0, "a refused policy must not be created");

    const created = await create(json("POST", { name: "Collections", isActive: false, stages: [] }));
    assert.equal(created.status, 201, JSON.stringify(await created.clone().json()));
    const { id } = (await created.json()) as { id: string };
    assert.equal(await activeFlag(org.orgId, id), false);

    // PATCH enforces the same contract: a non-boolean must not flip the flag.
    for (const isActive of ["false", 0, 1, "yes"]) {
      const refused = await patch(json("PATCH", { isActive }), params(id));
      assert.equal(refused.status, 400, `PATCH isActive ${JSON.stringify(isActive)}: ${await refused.clone().text()}`);
    }
    assert.equal(await activeFlag(org.orgId, id), false, "refused PATCH writes nothing");

    // A-S19: activating a stage-less ladder is refused on both paths — the
    // runner could never fire it, so storing it live only parks a no-op.
    // (Contract change per the finding: activation now requires a ladder.)
    const activateEmpty = await patch(json("PATCH", { isActive: true }), params(id));
    assert.equal(activateEmpty.status, 422, JSON.stringify(await activateEmpty.clone().json()));
    assert.deepEqual(await activateEmpty.json(), { error: "cannot activate a policy with no stages — add at least one stage or deactivate it first" });
    assert.equal(await activeFlag(org.orgId, id), false, "refused activation writes nothing");

    const createEmpty = await create(json("POST", { name: "Default-on", stages: [] }));
    assert.equal(createEmpty.status, 422, JSON.stringify(await createEmpty.clone().json()));
    assert.deepEqual(await createEmpty.json(), { error: "cannot activate a policy with no stages — add at least one stage or create it inactive" });
    const countAfter = await withBypassContext(() =>
      db.execute<{ n: number }>(sql`select count(*)::int as n from dunning_policies where org_id = ${org.orgId}`),
    );
    assert.equal(countAfter.rows[0]!.n, 1, "a refused create stores nothing (only the inactive policy exists)");

    // Controls: real booleans still write; omission stays active when a
    // ladder is supplied; pruning the ladder off a live policy is refused.
    const staged = await patch(json("PATCH", { stages: [ladderStage()] }), params(id));
    assert.equal(staged.status, 200, JSON.stringify(await staged.clone().json()));
    const activated = await patch(json("PATCH", { isActive: true }), params(id));
    assert.equal(activated.status, 200, JSON.stringify(await activated.clone().json()));
    assert.equal(await activeFlag(org.orgId, id), true);
    const pruned = await patch(json("PATCH", { stages: [] }), params(id));
    assert.equal(pruned.status, 422, JSON.stringify(await pruned.clone().json()));
    assert.equal(await stageCount(org.orgId, id), 1, "refused prune keeps the ladder");
    const omitted = await create(json("POST", { name: "Default-on", stages: [ladderStage()] }));
    assert.equal(omitted.status, 201, JSON.stringify(await omitted.clone().json()));
    assert.equal(await activeFlag(org.orgId, (await omitted.json()).id as string), true);
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});
