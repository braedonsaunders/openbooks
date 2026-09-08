import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import test from "node:test";
import type { SessionUser } from "./auth";
import { promotionNextStep } from "./sandbox-promotion";
const root = pathToFileURL(process.cwd() + "/").href;
const state: { user: SessionUser | null } = { user: null };
Object.assign(globalThis, { __sandboxWorkflowUser: state });
registerHooks({ resolve(specifier, context, next) {
  if (specifier === "server-only") return { shortCircuit: true, url: "data:text/javascript,export {}" };
  if (specifier === "next/cache") return { shortCircuit: true, url: "data:text/javascript,export function revalidatePath(){}" };
  if (specifier === "./auth" && context.parentURL?.includes("/web/lib/authz")) return {
    shortCircuit: true, url: "data:text/javascript,export async function currentUser(){return globalThis.__sandboxWorkflowUser.user;}" };
  return next(specifier, context);
} });
const { db } = await import(root + "engine/src/db.ts");
const { sql } = await import(root + "node_modules/drizzle-orm/index.js");
const { createScratchOrg, createScratchUser, dropScratchOrgReporting } = await import(root + "engine/src/test-fixtures.ts");
const { createSandbox, deleteSandbox } = await import(root + "engine/src/sandbox/lifecycle.ts");
const { loadChangeSetDetail } = await import(root + "web/lib/sandbox-change-sets.ts");
const { entityListSource } = await import(root + "web/lib/list/entity-sources.ts");
const { defaultListView } = await import(root + "packages/customization/src/index.ts");
const { promoteSandboxAction, transitionChangeSetAction } = await import(root + "web/app/(app)/admin/sandboxes/actions.ts");

for (const scenario of ["complete workflow", "stale production", "tenant isolation", "missing authority"] as const) {
  test(`sandbox promotion UI contract: ${scenario}`, { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
    const org = await createScratchOrg();
    let sandbox: Awaited<ReturnType<typeof createSandbox>> | undefined;
    try {
      const actors: string[] = [];
      for (const name of ["Creator", "Reviewer", "Approver", "Applier"]) actors.push(await createScratchUser(org.orgId, name, "admin"));
      await db.execute(sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='admin'`);
      await db.execute(sql`insert into app_roles(org_id,key,name) values(${org.orgId},'ui_target','Original configuration')`);
      sandbox = await createSandbox({ productionOrgId: org.orgId, name: "Promotion UI", tier: "full", masked: false });
      await db.execute(sql`update app_roles set name='Reviewed configuration' where org_id=${sandbox.sandboxOrgId} and key='ui_target'`);
      const asActor = (id: string, orgId = org.orgId) => { state.user = { id, name: "Workflow actor", email: "workflow@example.invalid", roles: [], orgId, productionOrgId: orgId, envKind: "production", isSuperAdmin: false, homeUserId: id, homeOrgId: orgId }; };
      asActor(actors[0]!);
      const captured = await promoteSandboxAction(sandbox.sandboxId, "Persisted review");
      const read = async () => { const detail = await loadChangeSetDetail(org.orgId, captured.changeSetId); assert.ok(detail); return detail; };
      const detail = await read();
      assert.equal(detail.status, "draft");
      assert.equal(detail.items[0]!.expectedBefore!.name, "Original configuration");
      assert.equal(detail.items[0]!.payload!.name, "Reviewed configuration");
      assert.equal(promotionNextStep(detail, actors[0]!).transition, null);
      assert.equal(promotionNextStep(detail, actors[1]!).transition, "review");
      assert.match((await transitionChangeSetAction(captured.changeSetId, "apply")).error!, /not approved/);
      if (scenario === "tenant isolation") {
        assert.equal(await loadChangeSetDetail(sandbox.sandboxOrgId, captured.changeSetId), null);
        assert.equal(await loadChangeSetDetail(org.orgId, "invalid"), null);
        asActor(actors[1]!, sandbox.sandboxOrgId);
        assert.ok((await transitionChangeSetAction(captured.changeSetId, "review")).error);
        const source = entityListSource("change_set")!;
        const visible = await db.execute(sql`select cs.id from change_sets cs where ${source.where(defaultListView("change_set"), {}, sandbox.sandboxOrgId)}`);
        assert.equal(visible.rows.length, 0);
        return;
      }
      if (scenario === "missing authority") {
        await db.execute(sql`update app_roles set permissions='[]'::jsonb where org_id=${org.orgId} and key='admin'`);
        asActor(actors[1]!);
        assert.equal((await transitionChangeSetAction(captured.changeSetId, "review")).error, "forbidden");
        assert.equal((await read()).status, "draft");
        return;
      }
      asActor(actors[1]!);
      assert.equal((await transitionChangeSetAction(captured.changeSetId, "review")).error, null);
      assert.equal(promotionNextStep(await read(), actors[1]!).transition, null);
      assert.equal(promotionNextStep(await read(), actors[2]!).transition, "approve");
      asActor(actors[2]!);
      assert.equal((await transitionChangeSetAction(captured.changeSetId, "approve")).error, null);
      assert.equal(promotionNextStep(await read(), actors[3]!).transition, "apply");
      if (scenario === "stale production") await db.execute(sql`update app_roles set name='Later production decision' where org_id=${org.orgId} and key='ui_target'`);
      asActor(actors[3]!);
      const result = await transitionChangeSetAction(captured.changeSetId, "apply");
      if (scenario === "stale production") {
        assert.match(result.error!, /changed since capture; recapture and review/);
        assert.equal((await read()).status, "approved");
      } else {
        assert.equal(result.error, null);
        const applied = await read();
        assert.equal(applied.status, "applied");
        assert.equal(applied.reviewedName, "Reviewer");
        assert.equal(applied.approvedName, "Approver");
        assert.equal(applied.appliedName, "Applier");
        assert.equal(promotionNextStep(applied, actors[3]!).transition, null);
      }
    } finally {
      state.user = null;
      if (sandbox) await deleteSandbox(sandbox.sandboxId);
      await dropScratchOrgReporting(org.orgId);
    }
  });
}
