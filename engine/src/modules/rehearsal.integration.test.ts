import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, env, withBypass, withOrgContext } from "../db.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
} from "../test-fixtures.ts";
import {
  describeRehearsal,
  discardRehearsal,
  ModuleRehearsalError,
  promoteRehearsal,
  stageModuleRehearsal,
} from "./rehearsal.ts";

const DB = !!env.OPENBOOKS_DB_URL;

/**
 * Live-PG proofs for module rehearsal (engine/src/modules/rehearsal.ts).
 * A sandbox is a linked org (sandboxes.org_id → production_org_id): staging
 * installs the module into the sandbox org and writes the author's preview
 * drafts there, so the REAL route renders the module spec via the same rows
 * the renderer reads (page_specs projection + page_spec_drafts honored on
 * ?layoutPreview=1). Promote installs the staged bytes into production;
 * discard deactivates the sandbox projections and deletes the drafts while
 * the production org stays untouched.
 */

type Fixture = {
  productionOrgId: string;
  sandboxOrgId: string;
  /** Rehearsing author: an active user of the SANDBOX org (drafts are author-scoped there). */
  authorId: string;
  /** Approver in the production org (promote narrows the grant to what they hold). */
  promoterId: string;
};

async function makeFixture(): Promise<Fixture> {
  return await withBypass(async () => {
    const production = await createScratchOrg();
    const sandbox = await createScratchOrg();
    await db.execute(sql`
      insert into sandboxes (org_id, production_org_id, name, status)
      values (${sandbox.orgId}, ${production.orgId}, 'rehearsal sandbox', 'ready')`);
    await db.execute(sql`update orgs set env_kind = 'sandbox', sandbox_of = ${production.orgId} where id = ${sandbox.orgId}`);
    const authorId = await createScratchUser(sandbox.orgId, "Rehearsal Author", "admin");
    const promoterId = await createScratchUser(production.orgId, "Production Requester", "admin");
    await createScratchUser(production.orgId, "Production Approver", "admin");
    await db.execute(sql`update app_roles set permissions = '["*"]'::jsonb where org_id in (${production.orgId}, ${sandbox.orgId}) and key = 'admin'`);
    return {
      productionOrgId: production.orgId,
      sandboxOrgId: sandbox.orgId,
      authorId,
      promoterId,
    };
  });
}

async function dropFixture(fx: Fixture): Promise<void> {
  await dropScratchOrg(fx.sandboxOrgId);
  await dropScratchOrg(fx.productionOrgId);
}

/** A realistic PageSpec document; the installer stores it opaquely as jsonb. */
function specFor(route: string, extra: Record<string, unknown> = {}) {
  return { specVersion: 1, route, layout: "list", header: [], body: [], ...extra };
}

/** A minimal valid module manifest in the shape the installer accepts. */
function manifest(overrides: Record<string, unknown> = {}) {
  return {
    key: "qilish-report",
    name: "Qilish Report",
    version: "1.0.0",
    description: "A reporting module",
    permissions: [],
    contributions: [{ kind: "page", route: "/reports/qilish", spec: specFor("/reports/qilish") }],
    ...overrides,
  };
}

const moduleRows = async (orgId: string) =>
  (
    await withOrgContext(orgId, () =>
      db.execute<{ id: string; key: string; status: string; active_version_id: string | null }>(
        sql`select id, key, status, active_version_id from modules where org_id = ${orgId}`,
      ),
    )
  ).rows;

const activeSpecs = async (orgId: string) =>
  (
    await withOrgContext(orgId, () =>
      db.execute<{ route: string; spec: unknown; module_version_id: string | null }>(
        sql`select route, spec, module_version_id from page_specs
             where org_id = ${orgId} and is_active and user_id is null`,
      ),
    )
  ).rows;

const authorDrafts = async (orgId: string, userId: string) =>
  (
    await withOrgContext(orgId, () =>
      db.execute<{ route: string; spec: unknown }>(
        sql`select route, spec from page_spec_drafts
             where org_id = ${orgId} and user_id = ${userId}
               and created_at >= now() - '30 minutes'::interval`,
      ),
    )
  ).rows;

test(
  "stage installs into the sandbox org and drafts the author's preview: the real route reads both",
  { skip: !DB },
  async () => {
    const fx = await makeFixture();
    try {
      const staged = await withBypass(() =>
        stageModuleRehearsal({
          productionOrgId: fx.productionOrgId,
          sandboxOrgId: fx.sandboxOrgId,
          actorId: fx.authorId,
          manifest: manifest(),
          installerEffectivePermissions: ["records.read"],
          reason: "rehearse qilish report",
        }),
      );
      assert.equal(staged.key, "qilish-report");
      assert.equal(staged.version, "1.0.0");
      assert.deepEqual(staged.previews, [{ route: "/reports/qilish", previewUrl: "/reports/qilish?layoutPreview=1" }]);

      // The REAL route in the sandbox renders the module spec: the projection
      // row is exactly what loadPageSpec reads (org + route + active + org scope).
      const specs = await activeSpecs(fx.sandboxOrgId);
      assert.equal(specs.length, 1);
      assert.equal(specs[0]!.route, "/reports/qilish");
      assert.equal(specs[0]!.module_version_id, staged.versionId);
      assert.deepEqual(specs[0]!.spec, specFor("/reports/qilish"));

      // ?layoutPreview=1 renders the author's draft: same predicates the
      // renderer uses (org + author + route + unexpired window).
      const drafts = await authorDrafts(fx.sandboxOrgId, fx.authorId);
      assert.equal(drafts.length, 1);
      assert.equal(drafts[0]!.route, "/reports/qilish");
      assert.deepEqual(drafts[0]!.spec, specFor("/reports/qilish"));

      // Staging touches nothing live: no module rows, no projections, no drafts.
      assert.deepEqual(await moduleRows(fx.productionOrgId), []);
      assert.deepEqual(await activeSpecs(fx.productionOrgId), []);
      assert.deepEqual(await authorDrafts(fx.productionOrgId, fx.promoterId), []);
    } finally {
      await dropFixture(fx);
    }
  },
);

test(
  "promote installs the staged bytes into production with audit; discard leaves production untouched",
  { skip: !DB },
  async () => {
    const fx = await makeFixture();
    try {
      const staged = await withBypass(() =>
        stageModuleRehearsal({
          productionOrgId: fx.productionOrgId,
          sandboxOrgId: fx.sandboxOrgId,
          actorId: fx.authorId,
          manifest: manifest(),
          installerEffectivePermissions: ["records.read"],
          reason: "rehearse qilish report",
        }),
      );

      const promoted = await withBypass(() =>
        promoteRehearsal({
          productionOrgId: fx.productionOrgId,
          sandboxOrgId: fx.sandboxOrgId,
          actorId: fx.promoterId,
          key: "qilish-report",
          installerEffectivePermissions: ["records.read"],
          reason: "approved rehearsal",
        }),
      );
      assert.equal(promoted.moduleId.length > 0, true);
      assert.equal(promoted.version, "1.0.0");

      const live = await activeSpecs(fx.productionOrgId);
      assert.equal(live.length, 1);
      assert.equal(live[0]!.route, "/reports/qilish");
      assert.equal(live[0]!.module_version_id, promoted.versionId);
      assert.deepEqual(live[0]!.spec, specFor("/reports/qilish"));

      const liveModules = await moduleRows(fx.productionOrgId);
      assert.equal(liveModules.length, 1);
      assert.equal(liveModules[0]!.status, "installed");

      const audit = (
        await withOrgContext(fx.productionOrgId, () =>
          db.execute<{ changes: { reason?: unknown; before?: unknown; after?: unknown }; actor_id: string | null }>(sql`
            select changes, actor_id from audit_log
             where org_id = ${fx.productionOrgId} and table_name = 'modules'
               and row_id = ${liveModules[0]!.id}
             order by at, id`),
        )
      ).rows;
      assert.ok(audit.length > 0, "expected promote audit rows");
      const promotion = audit.find((r) => (r.changes.after as { event?: string } | undefined) !== undefined);
      assert.ok(promotion, "expected an audit row carrying before/after");
      assert.equal(promotion!.actor_id, fx.promoterId);
      assert.equal(typeof promotion!.changes.reason, "string");
      assert.ok("before" in promotion!.changes && "after" in promotion!.changes);

      // The sandbox staging is independent of the live install.
      assert.equal((await moduleRows(fx.sandboxOrgId)).length, 1);
      assert.equal(staged.versionId.length > 0, true);

      // Discard deactivates the sandbox projections and deletes the drafts;
      // production keeps serving the promoted version.
      const discarded = await withBypass(() =>
        discardRehearsal({
          productionOrgId: fx.productionOrgId,
          sandboxOrgId: fx.sandboxOrgId,
          actorId: fx.authorId,
          key: "qilish-report",
          reason: "done rehearsing",
        }),
      );
      assert.equal(discarded.deactivatedProjections, 1);
      assert.deepEqual(await activeSpecs(fx.sandboxOrgId), []);
      assert.deepEqual(await authorDrafts(fx.sandboxOrgId, fx.authorId), []);
      assert.equal((await activeSpecs(fx.productionOrgId)).length, 1);
      assert.equal((await moduleRows(fx.productionOrgId))[0]!.status, "installed");
    } finally {
      await dropFixture(fx);
    }
  },
);

test(
  "describe stages the diff card: added page vs an empty live org, then changed vs the promoted live",
  { skip: !DB },
  async () => {
    const fx = await makeFixture();
    try {
      await withBypass(() =>
        stageModuleRehearsal({
          productionOrgId: fx.productionOrgId,
          sandboxOrgId: fx.sandboxOrgId,
          actorId: fx.authorId,
          manifest: manifest(),
          installerEffectivePermissions: ["records.read"],
          reason: "rehearse qilish report",
        }),
      );

      const fresh = await withBypass(() =>
        describeRehearsal({
          productionOrgId: fx.productionOrgId,
          sandboxOrgId: fx.sandboxOrgId,
          key: "qilish-report",
        }),
      );
      assert.equal(fresh.staged?.version, "1.0.0");
      assert.equal(fresh.live, null);
      assert.deepEqual(fresh.changes, [
        { kind: "page", identity: "/reports/qilish", change: "added", target: "page_specs" },
      ]);
      assert.equal(fresh.unchanged, 0);

      await withBypass(() =>
        promoteRehearsal({
          productionOrgId: fx.productionOrgId,
          sandboxOrgId: fx.sandboxOrgId,
          actorId: fx.promoterId,
          key: "qilish-report",
          installerEffectivePermissions: ["records.read"],
          reason: "approved rehearsal",
        }),
      );
      const promoted = await withBypass(() =>
        describeRehearsal({
          productionOrgId: fx.productionOrgId,
          sandboxOrgId: fx.sandboxOrgId,
          key: "qilish-report",
        }),
      );
      assert.equal(promoted.live?.version, "1.0.0");
      assert.deepEqual(promoted.changes, []);
      assert.equal(promoted.unchanged, 1);

      await withBypass(() =>
        stageModuleRehearsal({
          productionOrgId: fx.productionOrgId,
          sandboxOrgId: fx.sandboxOrgId,
          actorId: fx.authorId,
          manifest: manifest({
            version: "1.1.0",
            contributions: [
              { kind: "page", route: "/reports/qilish", spec: specFor("/reports/qilish", { layout: "detail" }) },
            ],
          }),
          installerEffectivePermissions: ["records.read"],
          reason: "rehearse v1.1.0",
        }),
      );
      const upgraded = await withBypass(() =>
        describeRehearsal({
          productionOrgId: fx.productionOrgId,
          sandboxOrgId: fx.sandboxOrgId,
          key: "qilish-report",
        }),
      );
      assert.equal(upgraded.staged?.version, "1.1.0");
      assert.deepEqual(upgraded.changes, [
        { kind: "page", identity: "/reports/qilish", change: "changed", target: "page_specs" },
      ]);
    } finally {
      await dropFixture(fx);
    }
  },
);

test(
  "staging into a sandbox owned by another production org is refused",
  { skip: !DB },
  async () => {
    const fx = await makeFixture();
    const stranger = await withBypass(async () => {
      const org = await createScratchOrg();
      return org.orgId;
    });
    try {
      await assert.rejects(
        withBypass(() =>
          stageModuleRehearsal({
            productionOrgId: stranger,
            sandboxOrgId: fx.sandboxOrgId,
            actorId: fx.authorId,
            manifest: manifest(),
            installerEffectivePermissions: ["records.read"],
          }),
        ),
        (error: unknown) => error instanceof ModuleRehearsalError && error.status === 403,
        "expected a 403 rehearsal refusal",
      );
      // The refused stage wrote nothing anywhere.
      assert.deepEqual(await moduleRows(fx.sandboxOrgId), []);
      assert.deepEqual(await moduleRows(stranger), []);
    } finally {
      await dropScratchOrg(stranger);
      await dropFixture(fx);
    }
  },
);


test("capability-bearing rehearsal promotion requires another administrator's signed approval", { skip: !DB }, async () => {
  const fx = await makeFixture();
  try {
    await withBypass(() => stageModuleRehearsal({ productionOrgId: fx.productionOrgId, sandboxOrgId: fx.sandboxOrgId,
      actorId: fx.authorId, manifest: manifest({ permissions: ["records.read"] }), installerEffectivePermissions: ["*"] }));
    const promoted = await withBypass(() => promoteRehearsal({ productionOrgId: fx.productionOrgId, sandboxOrgId: fx.sandboxOrgId,
      actorId: fx.promoterId, key: "qilish-report", installerEffectivePermissions: ["*"] }));
    assert.equal(promoted.outcome, "awaiting-approval");
    assert.ok(promoted.gateIds?.length);
    assert.deepEqual(await activeSpecs(fx.productionOrgId), []);
    const gates = await withBypass(() => db.execute<{ signature_required: boolean; status: string }>(sql`
      select signature_required, status from flow_gates where org_id = ${fx.productionOrgId} and subject_id = ${promoted.moduleId}`));
    assert.ok(gates.rows.every(g => g.signature_required && g.status === "pending"));
  } finally { await dropFixture(fx); }
});


test("restaging removed routes clears rehearsal drafts while discard preserves independent draft edits", { skip: !DB }, async () => {
  const fx = await makeFixture();
  try {
    const options = { productionOrgId: fx.productionOrgId, sandboxOrgId: fx.sandboxOrgId, actorId: fx.authorId, installerEffectivePermissions: ["*"] };
    await withBypass(() => stageModuleRehearsal({ ...options, manifest: manifest() }));
    await withBypass(() => stageModuleRehearsal({ ...options, manifest: manifest({ version: "2.0.0", contributions: [
      { kind: "page", route: "/reports/other", spec: specFor("/reports/other") },
    ] }) }));
    assert.deepEqual((await authorDrafts(fx.sandboxOrgId, fx.authorId)).map(d => d.route), ["/reports/other"]);
    const independentlyEdited = specFor("/reports/other", { layout: "detail" });
    await withBypass(() => db.execute(sql`update page_spec_drafts set spec = ${JSON.stringify(independentlyEdited)}::jsonb where org_id = ${fx.sandboxOrgId} and user_id = ${fx.authorId}`));
    await withBypass(() => discardRehearsal({ ...options, key: "qilish-report" }));
    assert.deepEqual((await authorDrafts(fx.sandboxOrgId, fx.authorId))[0]?.spec, independentlyEdited);
    assert.deepEqual(await activeSpecs(fx.productionOrgId), []);
  } finally { await dropFixture(fx); }
});

test("a linked production org and a non-ready sandbox cannot masquerade as a rehearsal target", { skip: !DB }, async () => {
  const fx = await makeFixture();
  try {
    const options = { productionOrgId: fx.productionOrgId, sandboxOrgId: fx.sandboxOrgId, actorId: fx.authorId, manifest: manifest(), installerEffectivePermissions: ["*"] };
    await withBypass(() => db.execute(sql`update orgs set env_kind = 'production' where id = ${fx.sandboxOrgId}`));
    await assert.rejects(withBypass(() => stageModuleRehearsal(options)), (e: unknown) => e instanceof ModuleRehearsalError && e.status === 403);
    await withBypass(() => db.execute(sql`update orgs set env_kind = 'sandbox' where id = ${fx.sandboxOrgId}`));
    await withBypass(() => db.execute(sql`update sandboxes set status = 'refreshing' where org_id = ${fx.sandboxOrgId}`));
    await assert.rejects(withBypass(() => stageModuleRehearsal(options)), (e: unknown) => e instanceof ModuleRehearsalError && e.status === 403);
    assert.deepEqual(await moduleRows(fx.sandboxOrgId), []);
  } finally { await dropFixture(fx); }
});

test("rehearsal diff keeps setting identity stable across edits and reports the actual storage target", { skip: !DB }, async () => {
  const fx = await makeFixture();
  const { decideModuleApproval } = await import("./lifecycle.ts");
  try {
    const options = { productionOrgId: fx.productionOrgId, sandboxOrgId: fx.sandboxOrgId, actorId: fx.authorId, installerEffectivePermissions: ["*"] };
    const setting = { kind: "setting", key: "review_window", label: "Review window", valueType: "string", defaultValue: "Daily" };
    await withBypass(() => stageModuleRehearsal({ ...options, manifest: manifest({ permissions: ["admin.setup.manage"], contributions: [setting] }) }));
    const promoted = await withBypass(() => promoteRehearsal({ ...options, actorId: fx.promoterId, key: "qilish-report" }));
    const gate = await withBypass(() => db.execute<{ assignee_user_id: string }>(sql`select assignee_user_id from flow_gates where org_id = ${fx.productionOrgId} and id = ${promoted.gateIds![0]}`));
    await withBypass(() => decideModuleApproval({ gateId: promoted.gateIds![0]!, userId: gate.rows[0]!.assignee_user_id, decision: "approved", signature: "Production Approver", approverEffectivePermissions: ["*"] }));
    await withBypass(() => stageModuleRehearsal({ ...options, manifest: manifest({ version: "2.0.0", permissions: ["admin.setup.manage"], contributions: [{ ...setting, label: "Posting review window" }] }) }));
    const diff = await withBypass(() => describeRehearsal({ ...options, key: "qilish-report" }));
    assert.deepEqual(diff.changes, [{ kind: "setting", identity: "review_window", change: "changed", target: "orgs.settings" }]);
  } finally { await dropFixture(fx); }
});
