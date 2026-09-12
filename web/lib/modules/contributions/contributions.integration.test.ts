import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypass, withOrgContext } from "@openbooks/engine/src/db.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
} from "@openbooks/engine/src/test-fixtures.ts";
import type { OrgNavConfig } from "../../nav/registry";
import { PERMISSION_CATALOGUE } from "../../permissions";
import {
  NAV_PROJECTION_TARGET,
  parseNavContribution,
  planNavProjection,
  planNavWithdrawal,
} from "./nav";
import {
  SETTING_PROJECTION_TARGET,
  parseSettingContribution,
  planSettingProjection,
  planSettingWithdrawal,
  type OrgSettings,
} from "./settings";
import {
  PERMISSION_PROJECTION_TARGET,
  parsePermissionContribution,
  planPermissionProjection,
  planPermissionWithdrawal,
  resolveGrantablePermissions,
} from "./permissions";

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * Live-Postgres proof for the Phase 4a contribution projectors
 * (web/lib/modules/contributions/{nav,settings,permissions}.ts).
 *
 * The module installer (engine/src/modules/installer.ts) is page-only in v1:
 * an install carrying a nav/setting/permission contribution is refused at
 * the boundary until the installer wires the kind. So this test drives the
 * exact plans the installer will consume — plan against live scratch-org
 * state, then execute every projection plus its audit row in ONE
 * transaction, mirroring the installer's execution contract (upsert
 * org_nav_configs, update orgs.settings, one audit_log row per projection
 * with actor + before/after + reason). When the installer wires the kinds,
 * its own integration test takes over the end-to-end path; these proofs
 * stay valid because the plans are the same pure functions.
 */

const MODULE_KEY = "qilish-report";
const VERSION = "1.0.0";
const REASON = "test: phase-4a contributions rehearsal";

const NAV_HREF = "/reports/qilish";
const SETTING_KEY = "qilish_report_enabled";
const PERMISSION_KEY = "qilish.reports.view";

const navRaw = {
  kind: "nav",
  label: "Qilish Report",
  href: NAV_HREF,
  group: "insights",
  iconKey: "chart",
  requiredPermission: PERMISSION_KEY,
  sortOrder: 5,
};

const settingRaw = {
  kind: "setting",
  key: SETTING_KEY,
  label: "Qilish report enabled",
  description: "Show the Qilish reporting pages",
  valueType: "boolean",
  defaultValue: true,
};

const permissionRaw = {
  kind: "permission",
  key: PERMISSION_KEY,
  label: "View Qilish reports",
  description: "Open the Qilish reporting pages",
};

type Fixture = { orgId: string; actorId: string };

async function makeFixture(): Promise<Fixture> {
  return await withBypass(async () => {
    const org = await createScratchOrg();
    const actorId = await createScratchUser(org.orgId, "Module Admin", "admin");
    return { orgId: org.orgId, actorId };
  });
}

type AuditRow = {
  table_name: string;
  row_id: string;
  action: string;
  changes: { event?: unknown; reason?: unknown; before?: unknown; after?: unknown };
  actor_id: string | null;
};

async function auditFor(orgId: string, table: string): Promise<AuditRow[]> {
  return (
    await withOrgContext(orgId, () =>
      db.execute<AuditRow>(sql`
        select table_name, row_id, action, changes, actor_id
          from audit_log
         where org_id = ${orgId} and table_name = ${table}
         order by at, id`),
    )
  ).rows;
}

/** Every audit row names its actor and carries the approval reason plus before/after. */
function assertAudited(rows: AuditRow[], actorId: string, table: string) {
  assert.ok(rows.length > 0, `expected at least one audit row for ${table}`);
  for (const row of rows) {
    assert.equal(row.actor_id, actorId, `audit row for ${table} names its actor`);
    assert.equal(
      row.changes.reason,
      REASON,
      `audit row for ${table} carries the approval reason`,
    );
    assert.ok("before" in (row.changes as object), `audit row for ${table} carries before`);
    assert.ok("after" in (row.changes as object), `audit row for ${table} carries after`);
  }
}

async function savedNavConfig(orgId: string): Promise<{
  id: string;
  config: OrgNavConfig;
} | null> {
  const rows = (
    await withOrgContext(orgId, () =>
      db.execute<{ id: string; config: OrgNavConfig }>(sql`
        select id, config from org_nav_configs where org_id = ${orgId} limit 1`),
    )
  ).rows;
  return rows[0] ?? null;
}

async function orgSettings(orgId: string): Promise<OrgSettings> {
  const rows = (
    await withOrgContext(orgId, () =>
      db.execute<{ settings: OrgSettings }>(sql`select settings from orgs where id = ${orgId}`),
    )
  ).rows;
  return (rows[0]!.settings ?? {}) as OrgSettings;
}

/** The installer's audit envelope: one row per projection, actor + before/after + reason. */
async function writeProjectionAudit(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  args: {
    orgId: string;
    table: string;
    rowId: string;
    action: string;
    event: string;
    reason: string;
    before: unknown;
    after: unknown;
    actorId: string;
  },
): Promise<void> {
  await tx.execute(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${args.orgId}, ${args.table}, ${args.rowId}, ${args.action},
            ${JSON.stringify({ event: args.event, reason: args.reason, before: args.before, after: args.after })}::jsonb,
            ${args.actorId})`);
}

test(
  "4a contributions project on a scratch org: nav entry, setup entry, grantable key, all audited",
  { skip: !DB },
  async () => {
    const fx = await makeFixture();
    try {
      // The contributions parse against the canonical manifest shapes, never mirrors.
      const navParsed = parseNavContribution(navRaw);
      if (!navParsed.ok) assert.fail(`nav contribution rejected: ${navParsed.errors.join("; ")}`);
      const settingParsed = parseSettingContribution(settingRaw);
      if (!settingParsed.ok)
        assert.fail(`setting contribution rejected: ${settingParsed.errors.join("; ")}`);
      const permissionParsed = parsePermissionContribution(permissionRaw);
      if (!permissionParsed.ok)
        assert.fail(`permission contribution rejected: ${permissionParsed.errors.join("; ")}`);

      const seedNav = await savedNavConfig(fx.orgId);
      assert.equal(seedNav, null, "a fresh scratch org has no saved navigation config");
      const seedSettings = await orgSettings(fx.orgId);
      assert.equal(
        seedSettings[SETTING_KEY],
        undefined,
        "a fresh scratch org does not set the module key",
      );

      const ctx = {
        orgId: fx.orgId,
        actorId: fx.actorId,
        moduleKey: MODULE_KEY,
        version: VERSION,
        reason: REASON,
      };
      const navPlanned = planNavProjection({
        contribution: navParsed.contribution,
        savedConfig: null,
        ...ctx,
      });
      if (!navPlanned.ok) assert.fail(`nav plan failed: ${navPlanned.errors.join("; ")}`);
      assert.equal(navPlanned.plan.outcome, "projected");
      assert.equal(navPlanned.plan.target, NAV_PROJECTION_TARGET);

      const settingPlanned = planSettingProjection({
        contribution: settingParsed.contribution,
        settings: seedSettings,
        ...ctx,
      });
      if (!settingPlanned.ok) assert.fail(`setting plan failed: ${settingPlanned.errors.join("; ")}`);
      assert.equal(settingPlanned.plan.outcome, "projected");
      assert.equal(settingPlanned.plan.target, SETTING_PROJECTION_TARGET);

      const permissionPlanned = planPermissionProjection({
        contribution: permissionParsed.contribution,
        ...ctx,
      });
      if (!permissionPlanned.ok)
        assert.fail(`permission plan failed: ${permissionPlanned.errors.join("; ")}`);
      assert.equal(permissionPlanned.plan.outcome, "projected");
      assert.equal(permissionPlanned.plan.target, PERMISSION_PROJECTION_TARGET);

      // Execute every projection plus its audit row in ONE transaction — the
      // installer's execution contract for the day it wires these kinds.
      await withBypass(() =>
        db.transaction(async (tx) => {
          const navSaved = (
            await tx.execute<{ id: string }>(sql`
              insert into org_nav_configs (org_id, config, created_by, updated_by)
              values (${fx.orgId}, ${JSON.stringify(navPlanned.plan.after)}, ${fx.actorId}, ${fx.actorId})
              on conflict (org_id) do update set
                config = excluded.config,
                updated_at = now(),
                updated_by = ${fx.actorId}
              returning id`)
          ).rows[0]!.id;
          await writeProjectionAudit(tx, {
            orgId: fx.orgId,
            table: navPlanned.plan.audit.table,
            rowId: navSaved,
            action: seedNav ? "update" : "insert",
            event: navPlanned.plan.audit.event,
            reason: navPlanned.plan.audit.reason,
            before: navPlanned.plan.audit.before,
            after: navPlanned.plan.audit.after,
            actorId: fx.actorId,
          });

          await tx.execute(sql`
            update orgs set settings = ${JSON.stringify(settingPlanned.plan.after)}::jsonb
             where id = ${fx.orgId}`);
          await writeProjectionAudit(tx, {
            orgId: fx.orgId,
            table: settingPlanned.plan.audit.table,
            rowId: fx.orgId,
            action: "update",
            event: settingPlanned.plan.audit.event,
            reason: settingPlanned.plan.audit.reason,
            before: settingPlanned.plan.audit.before,
            after: settingPlanned.plan.audit.after,
            actorId: fx.actorId,
          });

          // The declaration lives in the version manifest (no role row is
          // touched — install never widens access). Until the installer
          // wires the kind there is no modules row to anchor to, so the
          // audit row anchors to the org the declaration is scoped to.
          await writeProjectionAudit(tx, {
            orgId: fx.orgId,
            table: permissionPlanned.plan.audit.table,
            rowId: fx.orgId,
            action: "insert",
            event: permissionPlanned.plan.audit.event,
            reason: permissionPlanned.plan.audit.reason,
            before: permissionPlanned.plan.audit.before,
            after: permissionPlanned.plan.audit.after,
            actorId: fx.actorId,
          });
        }),
      );

      // The nav entry appears in the org's stored navigation config.
      const storedNav = await savedNavConfig(fx.orgId);
      assert.ok(storedNav, "org_nav_configs row exists after projection");
      const group = storedNav.config.groups.find((g) => g.id === "insights");
      assert.ok(group, "the insights group survives projection");
      const entry = group.items.find(
        (item) => item.kind === "link" && (item as { href?: string }).href === NAV_HREF,
      );
      assert.ok(entry, `nav entry for ${NAV_HREF} appears in the stored config`);
      assert.equal(entry.kind === "link" && entry.label, "Qilish Report");
      assert.equal(
        (entry as unknown as { moduleKey?: unknown }).moduleKey,
        MODULE_KEY,
        "the projected entry carries module provenance",
      );
      assert.equal(
        (entry as unknown as { requiredPermission?: unknown }).requiredPermission,
        PERMISSION_KEY,
        "the projected entry carries its permission guard",
      );
      assert.equal(entry.kind === "link" && (entry.hidden ?? false), false);

      // The setup entry appears in orgs.settings.
      const storedSettings = await orgSettings(fx.orgId);
      assert.equal(
        storedSettings[SETTING_KEY],
        true,
        "the module's default lands on the org settings key",
      );

      // The permission key becomes grantable through the read path the
      // roles UI and API consume — catalogue order first, module keys after.
      const grantable = resolveGrantablePermissions({
        modulePermissions: [{ key: PERMISSION_KEY, moduleKey: MODULE_KEY }],
      });
      assert.deepEqual(grantable, [...PERMISSION_CATALOGUE, PERMISSION_KEY]);
      assert.deepEqual(
        permissionPlanned.plan.grantable,
        grantable,
        "the plan's grantable set agrees with the read path",
      );

      // Every projection is audited to the installing actor with before/after/reason.
      assertAudited(await auditFor(fx.orgId, NAV_PROJECTION_TARGET), fx.actorId, NAV_PROJECTION_TARGET);
      assertAudited(
        await auditFor(fx.orgId, SETTING_PROJECTION_TARGET),
        fx.actorId,
        SETTING_PROJECTION_TARGET,
      );
      assertAudited(
        await auditFor(fx.orgId, PERMISSION_PROJECTION_TARGET),
        fx.actorId,
        PERMISSION_PROJECTION_TARGET,
      );

      // Re-projection converges: byte-identical installs plan already-projected, never duplicate.
      const navAgain = planNavProjection({
        contribution: navParsed.contribution,
        savedConfig: storedNav.config,
        ...ctx,
      });
      if (!navAgain.ok) assert.fail(`nav re-plan failed: ${navAgain.errors.join("; ")}`);
      assert.equal(navAgain.plan.outcome, "already-projected");
      const settingAgain = planSettingProjection({
        contribution: settingParsed.contribution,
        settings: storedSettings,
        ...ctx,
      });
      if (!settingAgain.ok) assert.fail(`setting re-plan failed: ${settingAgain.errors.join("; ")}`);
      assert.equal(settingAgain.plan.outcome, "already-projected");
      const permissionAgain = planPermissionProjection({
        contribution: permissionParsed.contribution,
        grantableModuleKeys: [{ key: PERMISSION_KEY, moduleKey: MODULE_KEY }],
        ...ctx,
      });
      if (!permissionAgain.ok)
        assert.fail(`permission re-plan failed: ${permissionAgain.errors.join("; ")}`);
      assert.equal(permissionAgain.plan.outcome, "already-projected");
    } finally {
      await dropScratchOrg(fx.orgId);
    }
  },
);

test(
  "4a withdrawals deactivate without deleting: nav hides, setting lifts, grants preserved, all audited",
  { skip: !DB },
  async () => {
    const fx = await makeFixture();
    try {
      const navParsed = parseNavContribution(navRaw);
      if (!navParsed.ok) assert.fail(`nav contribution rejected: ${navParsed.errors.join("; ")}`);
      const settingParsed = parseSettingContribution(settingRaw);
      if (!settingParsed.ok)
        assert.fail(`setting contribution rejected: ${settingParsed.errors.join("; ")}`);
      const permissionParsed = parsePermissionContribution(permissionRaw);
      if (!permissionParsed.ok)
        assert.fail(`permission contribution rejected: ${permissionParsed.errors.join("; ")}`);

      const ctx = {
        orgId: fx.orgId,
        actorId: fx.actorId,
        moduleKey: MODULE_KEY,
        version: VERSION,
        reason: REASON,
      };
      const seedSettings = await orgSettings(fx.orgId);

      // Project first so withdrawal has live state to deactivate.
      const navPlanned = planNavProjection({ contribution: navParsed.contribution, savedConfig: null, ...ctx });
      if (!navPlanned.ok) assert.fail(`nav plan failed: ${navPlanned.errors.join("; ")}`);
      const settingPlanned = planSettingProjection({
        contribution: settingParsed.contribution,
        settings: seedSettings,
        ...ctx,
      });
      if (!settingPlanned.ok) assert.fail(`setting plan failed: ${settingPlanned.errors.join("; ")}`);

      await withBypass(() =>
        db.transaction(async (tx) => {
          await tx.execute(sql`
            insert into org_nav_configs (org_id, config, created_by, updated_by)
            values (${fx.orgId}, ${JSON.stringify(navPlanned.plan.after)}, ${fx.actorId}, ${fx.actorId})
            on conflict (org_id) do update set
              config = excluded.config,
              updated_at = now(),
              updated_by = ${fx.actorId}`);
          await tx.execute(sql`
            update orgs set settings = ${JSON.stringify(settingPlanned.plan.after)}::jsonb
             where id = ${fx.orgId}`);
        }),
      );

      // A stored grant holding the module key must survive withdrawal:
      // uninstalling narrows nothing, not even indirectly.
      await withBypass(() =>
        db.execute(sql`
          update app_roles set permissions = (
            select coalesce(jsonb_agg(distinct value), '[]'::jsonb)
              from (
                select value from jsonb_array_elements_text(permissions)
                union all select ${PERMISSION_KEY} as value
              ) s
          ) where org_id = ${fx.orgId} and key = 'admin'`),
      );
      const roleGrants = (
        await withOrgContext(fx.orgId, () =>
          db.execute<{ permissions: string[] }>(sql`
            select permissions from app_roles where org_id = ${fx.orgId}`),
        )
      ).rows.flatMap((r) => r.permissions ?? []);
      assert.ok(
        roleGrants.includes(PERMISSION_KEY),
        "the fixture grant is stored before withdrawal",
      );

      const liveNav = (await savedNavConfig(fx.orgId))!.config;
      const liveSettings = await orgSettings(fx.orgId);
      const navWithdrawn = planNavWithdrawal({
        savedConfig: liveNav,
        declaredHrefs: [NAV_HREF],
        ...ctx,
      });
      if (!navWithdrawn.ok) assert.fail(`nav withdrawal failed: ${navWithdrawn.errors.join("; ")}`);
      assert.equal(navWithdrawn.plan.outcome, "withdrawn");
      assert.deepEqual(navWithdrawn.plan.withdrawnHrefs, [NAV_HREF]);

      const settingWithdrawn = planSettingWithdrawal({
        contribution: settingParsed.contribution,
        settings: liveSettings,
        knownDefaults: [true],
        ...ctx,
      });
      if (!settingWithdrawn.ok)
        assert.fail(`setting withdrawal failed: ${settingWithdrawn.errors.join("; ")}`);
      assert.equal(settingWithdrawn.plan.outcome, "withdrawn");

      const permissionWithdrawn = planPermissionWithdrawal({
        contribution: permissionParsed.contribution,
        roleGrants,
        remainingModuleKeys: [],
        ...ctx,
      });
      if (!permissionWithdrawn.ok)
        assert.fail(`permission withdrawal failed: ${permissionWithdrawn.errors.join("; ")}`);
      assert.deepEqual(
        permissionWithdrawn.plan.grantsAfter,
        roleGrants,
        "withdrawal never strips stored grants",
      );
      assert.ok(
        !permissionWithdrawn.plan.grantable.includes(PERMISSION_KEY),
        "the key leaves the grantable set",
      );

      await withBypass(() =>
        db.transaction(async (tx) => {
          const navSaved = (
            await tx.execute<{ id: string }>(sql`
              update org_nav_configs set config = ${JSON.stringify(navWithdrawn.plan.after)}::jsonb,
                updated_at = now(), updated_by = ${fx.actorId}
               where org_id = ${fx.orgId} returning id`)
          ).rows[0]!.id;
          await writeProjectionAudit(tx, {
            orgId: fx.orgId,
            table: navWithdrawn.plan.audit.table,
            rowId: navSaved,
            action: "update",
            event: navWithdrawn.plan.audit.event,
            reason: navWithdrawn.plan.audit.reason,
            before: navWithdrawn.plan.audit.before,
            after: navWithdrawn.plan.audit.after,
            actorId: fx.actorId,
          });
          await tx.execute(sql`
            update orgs set settings = ${JSON.stringify(settingWithdrawn.plan.after)}::jsonb
             where id = ${fx.orgId}`);
          await writeProjectionAudit(tx, {
            orgId: fx.orgId,
            table: settingWithdrawn.plan.audit.table,
            rowId: fx.orgId,
            action: "update",
            event: settingWithdrawn.plan.audit.event,
            reason: settingWithdrawn.plan.audit.reason,
            before: settingWithdrawn.plan.audit.before,
            after: settingWithdrawn.plan.audit.after,
            actorId: fx.actorId,
          });
          await writeProjectionAudit(tx, {
            orgId: fx.orgId,
            table: permissionWithdrawn.plan.audit.table,
            rowId: fx.orgId,
            action: "update",
            event: permissionWithdrawn.plan.audit.event,
            reason: permissionWithdrawn.plan.audit.reason,
            before: permissionWithdrawn.plan.audit.before,
            after: permissionWithdrawn.plan.audit.after,
            actorId: fx.actorId,
          });
        }),
      );

      // Deactivate, never delete: the nav row survives with the entry hidden.
      const afterNav = await savedNavConfig(fx.orgId);
      assert.ok(afterNav, "the org_nav_configs row survives withdrawal");
      const hidden = afterNav.config.groups
        .flatMap((g) => g.items)
        .find((item) => item.kind === "link" && (item as { href?: string }).href === NAV_HREF);
      assert.ok(hidden, "the withdrawn entry is hidden in place, not removed");
      assert.equal(hidden.kind === "link" && hidden.hidden, true);

      // The setting key lifts while the tenant's other settings are untouched.
      const afterSettings = await orgSettings(fx.orgId);
      assert.equal(afterSettings[SETTING_KEY], undefined, "the module key is removed");
      for (const [k, v] of Object.entries(seedSettings)) {
        assert.deepEqual(afterSettings[k], v, `tenant setting ${k} survives withdrawal`);
      }

      // Stored grants keep their bytes after withdrawal.
      const grantsAfter = (
        await withOrgContext(fx.orgId, () =>
          db.execute<{ permissions: string[] }>(sql`
            select permissions from app_roles where org_id = ${fx.orgId} and key = 'admin'`),
        )
      ).rows[0]!.permissions;
      assert.ok(
        grantsAfter.includes(PERMISSION_KEY),
        "the stored grant survives withdrawal",
      );

      assertAudited(await auditFor(fx.orgId, NAV_PROJECTION_TARGET), fx.actorId, NAV_PROJECTION_TARGET);
      assertAudited(
        await auditFor(fx.orgId, SETTING_PROJECTION_TARGET),
        fx.actorId,
        SETTING_PROJECTION_TARGET,
      );
      assertAudited(
        await auditFor(fx.orgId, PERMISSION_PROJECTION_TARGET),
        fx.actorId,
        PERMISSION_PROJECTION_TARGET,
      );
    } finally {
      await dropScratchOrg(fx.orgId);
    }
  },
);
