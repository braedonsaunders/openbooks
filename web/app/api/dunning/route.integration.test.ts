import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";

/**
 * Dunning policy routes: a malformed policy id must be a clean 404 (never a
 * Postgres uuid cast error surfacing as a 500), and `appliesToKind` may only
 * name a dunnable receivable kind — the runner selects documents by that kind
 * and mails the counterparty, so a payable kind would dun vendors.
 */
const state = { user: { orgId: "", id: "" } };
Object.assign(globalThis, { __dunningRouteUser: state });
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.endsWith("/lib/authz") && (context.parentURL?.includes("/api/dunning/") ||
        (specifier === "@/lib/authz" && context.parentURL?.includes("/lib/api/route")))) {
      return {
        shortCircuit: true,
        url:
          "data:text/javascript," +
          encodeURIComponent(
            "export async function guardPermission(){return {user:globalThis.__dunningRouteUser.user,permissions:new Set(['documents.manage']),allowedSubsidiaryIds:null}}export function guardUnrestrictedScope(authz){if(authz.allowedSubsidiaryIds!==null&&authz.allowedSubsidiaryIds!==undefined)return Response.json({error:'requires unrestricted subsidiary access'},{status:403});return null}",
          ),
      };
    }
    return next(specifier, context);
  },
});
const { db, withBypassContext } = await import("@openbooks/engine/src/platform/db.ts");
const { sql } = await import("drizzle-orm");
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import("@openbooks/engine/src/testing/fixtures.ts");
const { POST: create, GET: read } = await import("./route");
const { PATCH: patch, DELETE: remove } = await import("./[id]/route");

const json = (method: string, body?: unknown) =>
  new Request("http://audit.local/api/dunning", { method, body: body === undefined ? undefined : JSON.stringify(body) });
const params = (id: string) => ({ params: Promise.resolve({ id }) });

async function policyKind(orgId: string, id: string): Promise<string | undefined> {
  const r = await withBypassContext(() =>
    db.execute<{ kind: string }>(sql`select applies_to_kind as kind from dunning_policies where id = ${id} and org_id = ${orgId}`),
  );
  return r.rows[0]?.kind;
}

const ladderStage = () => ({
  sequence: 1,
  name: "Nudge",
  offsetDays: 7,
  subjectTemplate: "s",
  bodyTemplate: "b",
});

test("dunning [id] routes return 404 for a malformed policy id", async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    state.user = { orgId: org.orgId, id: (await withBypassContext(() => seedFlowActors(org.orgId))).adminId };
    for (const id of ["not-a-uuid", "new", "00000000-0000-0000-0000-00000000000"]) {
      const patched = await patch(json("PATCH", { name: "Renamed" }), params(id));
      assert.equal(patched.status, 404, `PATCH ${id}`);
      assert.deepEqual(await patched.json(), { error: "not_found" });
      const deleted = await remove(json("DELETE"), params(id));
      assert.equal(deleted.status, 404, `DELETE ${id}`);
      assert.deepEqual(await deleted.json(), { error: "not_found" });
    }
    // A well-formed id that names nothing keeps the sibling's not-found shape.
    const missing = await patch(json("PATCH", { name: "Renamed" }), params(randomUUID()));
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: "not_found" });
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("dunning policies only apply to dunnable receivable kinds", async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    state.user = { orgId: org.orgId, id: (await withBypassContext(() => seedFlowActors(org.orgId))).adminId };
    for (const appliesToKind of ["vendor_bill", "customer_credit", "journal_entry", "", 7, null]) {
      const refused = await create(json("POST", { name: "Chase", appliesToKind, stages: [] }));
      assert.equal(refused.status, 422, `POST appliesToKind ${JSON.stringify(appliesToKind)}`);
    }
    const count = await withBypassContext(() =>
      db.execute<{ n: number }>(sql`select count(*)::int as n from dunning_policies where org_id = ${org.orgId}`),
    );
    assert.equal(count.rows[0]!.n, 0, "a refused policy must not be created");

    // Omitted defaults to the receivable kind; explicit receivable kinds pass.
    // (A ladder is supplied: activating a stage-less policy is refused.)
    const created = await create(json("POST", { name: "Collections", stages: [ladderStage()] }));
    assert.equal(created.status, 201, JSON.stringify(await created.clone().json()));
    const { id } = (await created.json()) as { id: string };
    assert.equal(await policyKind(org.orgId, id), "customer_invoice");

    for (const appliesToKind of ["vendor_bill", "customer_credit", 7, null]) {
      const refused = await patch(json("PATCH", { appliesToKind }), params(id));
      assert.equal(refused.status, 422, `PATCH appliesToKind ${JSON.stringify(appliesToKind)}`);
    }
    assert.equal(await policyKind(org.orgId, id), "customer_invoice", "a refused patch must not change the policy");
    const accepted = await patch(json("PATCH", { appliesToKind: "customer_invoice", name: "Collections (AR)" }), params(id));
    assert.equal(accepted.status, 200);
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test('retrying policy creation replays once and refuses changed details', async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    state.user = { orgId: org.orgId, id: (await withBypassContext(() => seedFlowActors(org.orgId))).adminId }
    const key = randomUUID()
    const request = (name: string) => new Request('http://audit.local/api/dunning', { method: 'POST', headers: { 'Idempotency-Key': key }, body: JSON.stringify({ name, stages: [ladderStage()] }) })
    const first = await create(request('Standard'))
    assert.equal(first.status, 201)
    const retry = await create(request('Standard'))
    assert.equal(retry.status, 201)
    assert.deepEqual(await retry.json(), await first.json())
    const changed = await create(request('Different policy'))
    assert.equal(changed.status, 409)
    assert.match((await changed.json()).error, /different details.*Close and reopen/)
    const counts = await withBypassContext(() => db.execute<{ policies: number; stages: number; audits: number }>(sql`
      select (select count(*)::int from dunning_policies where org_id=${org.orgId}) as policies,
        (select count(*)::int from dunning_stages where org_id=${org.orgId}) as stages,
        (select count(*)::int from audit_log where org_id=${org.orgId} and table_name='dunning_policies' and action='insert') as audits`))
    assert.deepEqual(counts.rows[0], { policies: 1, stages: 1, audits: 1 })
  } finally { await withBypassContext(() => dropScratchOrg(org.orgId)) }
})

test('policy editing retains reminder identity and refuses stale or foreign stages atomically', async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    state.user = { orgId: org.orgId, id: (await withBypassContext(() => seedFlowActors(org.orgId))).adminId }
    const created = await create(json('POST', { name: 'Standard', stages: [ladderStage()] }))
    const { id } = await created.json()
    const readStages = () => withBypassContext(() => db.execute<{ id: string; created_at: Date; created_by: string; subject_template: string }>(sql`select id, created_at, created_by, subject_template from dunning_stages where org_id=${org.orgId} and policy_id=${id}`))
    const before = (await readStages()).rows[0]!
    const listed = await read(json('GET'))
    const revision = (await listed.json()).policies.find((policy: { id: string }) => policy.id === id).updatedAt
    assert.match(revision, /\.\d{6}Z$/, 'the conflict token must retain database precision')
    const empty = await patch(json('PATCH', { expectedUpdatedAt: revision }), params(id))
    assert.equal(empty.status, 400, 'a conflict token alone is not an edit')
    assert.match(JSON.stringify(await empty.json()), /At least one field must be provided/)
    const edited = await patch(json('PATCH', { name: 'Revised', expectedUpdatedAt: revision, stages: [{ ...ladderStage(), id: before.id, subjectTemplate: 'Revised subject' }] }), params(id))
    assert.equal(edited.status, 200)
    const after = (await readStages()).rows[0]!
    assert.equal(after.id, before.id, 'editing must not reset delivery deduplication')
    assert.deepEqual(after.created_at, before.created_at)
    assert.equal(after.created_by, before.created_by)
    assert.equal(after.subject_template, 'Revised subject')
    const stale = await patch(json('PATCH', { name: 'Stale overwrite', expectedUpdatedAt: revision }), params(id))
    assert.equal(stale.status, 409)
    assert.match((await stale.json()).error, /changed.*refresh Policies.*reopen/)
    const foreign = await patch(json('PATCH', { name: 'Must roll back', stages: [{ ...ladderStage(), id: randomUUID() }] }), params(id))
    assert.equal(foreign.status, 409)
    assert.match((await foreign.json()).error, /belongs to this policy.*Refresh Policies/)
    const policy = await withBypassContext(() => db.execute<{ name: string }>(sql`select name from dunning_policies where id=${id} and org_id=${org.orgId}`))
    assert.equal(policy.rows[0]!.name, 'Revised', 'the refused edit cannot partially rename the policy')
    assert.deepEqual((await readStages()).rows[0], after, 'a refusal preserves the entire reminder')
  } finally { await withBypassContext(() => dropScratchOrg(org.orgId)) }
})
