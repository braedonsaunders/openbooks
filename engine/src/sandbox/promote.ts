import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, schema, withMaintenanceTransaction } from "../db.ts";
import { assertUuid } from "./catalog.ts";
import { remapRoleRestriction, sandboxSubsidiaryMap } from "./json-references.ts";
import { lockAndCheckOrgFeature } from "../org-feature-lock.ts";
import { computeScheduledScriptNextRunAt } from "../scripting.ts";
import { validateScriptConfiguration } from "../script-config.ts";
import { isCataloguePermission, PERMISSION_CATALOGUE, permissionSetCovers, permissionsOutsideCeiling, resolveEffectivePermissions } from "../permissions.ts";

/**
 * Promotion — config flows UP (sandbox → production) as a reviewable change set;
 * business/ledger data never does. A change set diffs the sandbox's
 * customization layer against production and, on approval, applies it to
 * production in one transaction. This is openbooks' native, versioned
 * config-promotion artifact.
 *
 * Scope: self-contained customization tables whose content is jsonb/text (not
 * cross-environment FKs) — scripts, custom fields, forms, saved reports/views,
 * roles, account groups. Identity-bound tables (users, role_assignments) are
 * intentionally excluded.
 */
/** The ordinary domain write authority is also required for promotion. Keep
 * the allowlist and permission mapping together so new tables cannot silently
 * inherit sandbox-management authority alone. */
const PROMOTION_PERMISSIONS: Readonly<Record<string, string>> = {
  user_scripts: "scripts.manage",
  custom_field_defs: "admin.custom_fields.manage",
  form_layouts: "admin.customization.manage",
  list_views: "admin.customization.manage",
  saved_reports: "reports.create",
  saved_views: "reports.create",
  statement_layouts: "reports.create",
  report_definitions: "reports.create",
  account_groups: "admin.setup.manage",
  app_roles: "admin.roles.manage",
};
const PROMOTABLE = Object.keys(PROMOTION_PERMISSIONS);

// Drizzle binds an interpolated JS array as a row constructor "( $1, $2 )"
// without an array cast, so the catalog lookup dies on the second entry —
// bind ONE PostgreSQL array-literal param instead (elements are internal
// table identifiers, so the literal needs no escaping).
const PROMOTABLE_ARRAY = `{${PROMOTABLE.join(",")}}`;

const STRUCTURAL = new Set(["id", "org_id", "created_at", "updated_at", "created_by", "updated_by"]);
// Execution evidence and scheduler cursors belong to their environment. They
// are neither configuration differences nor reasons to invalidate a review.
const SCRIPT_RUNTIME = new Set(["last_run_at", "next_run_at"]);
const USER_REFERENCE_COLUMNS: Readonly<Record<string, string>> = {
  saved_views: "owner_id",
  list_views: "owner_id",
  saved_reports: "created_by_user_id",
};

function mappedUserReference(value: unknown, ids: ReadonlyMap<string, string>, label: string): string | null {
  if (value === null) return null;
  const mapped = typeof value === "string" ? ids.get(value.toLowerCase()) : undefined;
  if (!mapped) throw new Error(`${label}: user reference has no counterpart in the production organization; recapture after correcting ownership`);
  return mapped;
}

interface SandboxTargetRow extends Record<string, unknown> { org_id: string; production_org_id: string }
interface SandboxSeedRow extends Record<string, unknown> { sandbox_seed: string }
interface TableNameRow extends Record<string, unknown> { table_name: string }
interface ChangeDiffRow extends Record<string, unknown> {
  sbx_id: string; prod_id: string | null; sbx_row: Record<string, unknown>; prod_row: Record<string, unknown> | null;
}
interface IdRow extends Record<string, unknown> { id: string; expected_before: Record<string, unknown> }
interface ChangeSetRow extends Record<string, unknown> {
  org_id: string;
  sandbox_org_id: string | null;
  status: string;
  capture_complete: boolean;
  item_count: number;
  created_by: string | null;
  reviewed_by: string | null;
  approved_by: string | null;
}
interface ChangeSetItemRow extends Record<string, unknown> {
  table_name: string; target_id: string; op: "insert" | "update" | "delete"; payload: Record<string, unknown> | null;
  expected_before: Record<string, unknown> | null; base_captured: boolean;
}

/** Every lifecycle transition must carry a real, active production user. */
function requireActor(actorId: string | null | undefined, label: string): string {
  if (!actorId) throw new Error(`${label} actor is required`);
  return assertUuid(actorId);
}

async function assertActiveActor(actorId: string, orgId: string): Promise<void> {
  const actor = await db.execute<{ id: string }>(sql`
    select id from users where id = ${actorId} and org_id = ${orgId} and is_active`);
  if (!actor.rows[0]) throw new Error(`actor ${actorId} is not an active user of the production organization`);
}

/** Freeze the applying actor's authority before any item can change a role.
 * User administration takes the user write lock; role edits take the role write
 * lock. Holding both here orders revocations with the whole promotion. */
async function promotionAuthority(actorId: string, orgId: string): Promise<Set<string>> {
  const actor = (await db.execute<{ is_super_admin: boolean; is_active: boolean }>(sql`
    select is_super_admin,is_active from users where id=${actorId} and org_id=${orgId} for share`)).rows[0];
  if (!actor?.is_active) throw new Error("promotion requires an active production actor");
  await db.execute(sql`select id from role_assignments where org_id=${orgId} and user_id=${actorId} order by id for share`);
  const roles = (await db.execute<{ permissions: string[] }>(sql`
    select r.permissions from app_roles r where r.org_id=${orgId}
      and exists(select 1 from role_assignments a where a.org_id=${orgId} and a.user_id=${actorId} and a.role_id=r.id)
     order by r.id for share`)).rows;
  const overrides = (await db.execute<{ permission: string; effect: "grant" | "deny" }>(sql`
    select permission,effect from user_permission_overrides where org_id=${orgId} and user_id=${actorId} order by id for share`)).rows;
  const permissions = actor.is_super_admin ? new Set(["*"]) : resolveEffectivePermissions({ rolePermissionSets: roles.map(row => row.permissions), overrides });
  if (!permissionSetCovers(permissions, "admin.sandboxes.manage")) throw new Error("promotion requires admin.sandboxes.manage");
  return permissions;
}

function promotedRolePermissions(value: unknown): string[] {
  if (!Array.isArray(value) || value.some(key => typeof key !== "string" ||
    !(isCataloguePermission(key) || key === "*" || (key.endsWith(".*") && PERMISSION_CATALOGUE.some(p => p.startsWith(key.slice(0, -1))))))) {
    throw new Error("promotion role permissions must contain valid permission keys");
  }
  return [...new Set(value as string[])];
}

/** Ownership is a record-level control in addition to module permissions.
 * Check both sides so an ownership/scope edit cannot authorize itself. A
 * legacy sandbox owner is accepted only through its proven actor mapping. */
async function assertPromotionOwner(
  table: string, row: Record<string, unknown> | null, actor: string,
  authority: ReadonlySet<string>, sandboxOrgId: string | null, legacy: boolean,
): Promise<void> {
  const field = USER_REFERENCE_COLUMNS[table];
  if (!row || !field) return;
  if (table === "list_views" ? row.scope !== "user" : authority.has("*")) return;
  if (row[field] === actor) return;
  if (legacy && sandboxOrgId && typeof row[field] === "string") {
    const counterpart = await db.execute(sql`
      select u.id from users u join orgs o on o.id=u.org_id
       where o.id=${sandboxOrgId} and o.env_kind='sandbox'
         and u.id=${row[field]} and u.id=ob_rebase(${actor}::uuid,o.sandbox_seed)
       for share of u,o`);
    if (counterpart.rows.length) return;
  }
  throw new Error(`${table} promotion requires the record owner`);
}

async function assertDistinctActors(
  actorId: string,
  existing: ReadonlyArray<[string, string | null]>,
): Promise<void> {
  for (const [label, prior] of existing) {
    if (prior === actorId) throw new Error(`${label} and lifecycle actor must be different users`);
  }
}

function contentSig(table: string, row: Record<string, unknown> | null): string {
  if (!row) return "";
  const o: Record<string, unknown> = {};
  for (const k of Object.keys(row).sort()) {
    if (!STRUCTURAL.has(k) && !(table === "user_scripts" && SCRIPT_RUNTIME.has(k))) o[k] = row[k];
  }
  return JSON.stringify(o);
}

export async function buildChangeSet(
  sandboxId: string,
  name: string,
  createdBy?: string | null,
): Promise<{ changeSetId: string; itemCount: number }> {
  // A null creator is retained for trusted non-interactive/CLI captures.  The
  // production server action always supplies its authenticated user; review,
  // approval, and application actors are mandatory regardless.
  const creator = createdBy == null ? null : requireActor(createdBy, "change-set creation");
  // The header and every item are one trusted, cross-tenant transaction.  A
  // failed catalog read or item insert therefore rolls back the header too;
  // no partially captured draft can become an applyable artifact.
  return withMaintenanceTransaction(null, async () => {
    await db.execute(sql`set local time zone 'UTC'`);
    const s = await db.execute<SandboxTargetRow>(sql`
      select org_id, production_org_id from sandboxes where id = ${sandboxId}`);
    const row = s.rows[0];
    if (!row) throw new Error(`sandbox not found: ${sandboxId}`);
    const sbx = assertUuid(row.org_id);
    const prod = assertUuid(row.production_org_id);
    if (creator) await assertActiveActor(creator, prod);
    const seedRes = await db.execute<SandboxSeedRow>(sql`select sandbox_seed from orgs where id = ${row.org_id}`);
    const seedRow = seedRes.rows[0];
    if (!seedRow) throw new Error(`sandbox organization not found: ${row.org_id}`);
    const seed = assertUuid(seedRow.sandbox_seed);
    const subsidiaryMap = await sandboxSubsidiaryMap(prod, sbx, seed);
    const productionSubsidiaries = new Map([...subsidiaryMap.keys()].map(id => [id, id]));
    const toProduction = new Map([...subsidiaryMap].map(([source, target]) => [target, source]));
    const users = (await db.execute<{ production_id: string; sandbox_id: string | null }>(sql`
      select p.id as production_id, s.id as sandbox_id from users p
      left join users s on s.org_id=${sbx} and s.id=ob_rebase(p.id,${seed}::uuid)
       where p.org_id=${prod}`)).rows;
    const toProductionUser = new Map(users.flatMap(row => row.sandbox_id ? [[row.sandbox_id, row.production_id] as const] : []));
    // A previously corrupted production owner can be repaired through its
    // proven origin, but only as an explicit reviewed change-set item.
    const productionUser = new Map([...users.map(row => [row.production_id, row.production_id] as const), ...toProductionUser]);

    const cs = (await db
      .insert(schema.changeSets)
      .values({
        orgId: prod,
        sandboxOrgId: sbx,
        name,
        status: "draft",
        captureComplete: false,
        itemCount: 0,
        createdBy: creator,
      })
      .returning({ id: schema.changeSets.id }))[0]!;

    // Which promotable tables actually exist and carry org_id + id.
    const present = await db.execute<TableNameRow>(sql`
      select table_name from information_schema.columns
       where table_schema = 'public' and column_name = 'org_id'
         and table_name = any(${PROMOTABLE_ARRAY}::text[])`);
    const tables = present.rows.map((r) => r.table_name);

    let itemCount = 0;
    for (const t of tables) {
      // Inserts + updates: every sandbox row, matched to its production origin.
      const diff = await db.execute<ChangeDiffRow>(sql.raw(`
        select s.id as sbx_id, p.id as prod_id, row_to_json(s) as sbx_row, row_to_json(p) as prod_row
          from "${t}" s
          left join "${t}" p on p.org_id = '${prod}' and ob_rebase(p.id, '${seed}') = s.id
         where s.org_id = '${sbx}'`));
      for (const d of diff.rows) {
        // Keep the raw production record before normalizing reference identities
        // for comparison. A reviewed repair must still match that actual base.
        const expectedBefore = d.prod_row ? structuredClone(d.prod_row) : null;
        const userField = USER_REFERENCE_COLUMNS[t];
        let repairsProductionReference = false;
        if (userField) {
          d.sbx_row[userField] = mappedUserReference(d.sbx_row[userField], toProductionUser, `promotion ${t}/${d.sbx_id}`);
          if (d.prod_row) {
            const original = d.prod_row[userField];
            d.prod_row[userField] = mappedUserReference(original, productionUser, `production ${t}/${d.prod_id}`);
            repairsProductionReference = original !== d.prod_row[userField];
          }
        }
        if (t === "app_roles") {
          d.sbx_row.subsidiary_restriction = remapRoleRestriction(d.sbx_row.subsidiary_restriction, toProduction, `promotion role ${d.sbx_id}`);
          if (d.prod_row) d.prod_row.subsidiary_restriction = remapRoleRestriction(d.prod_row.subsidiary_restriction, productionSubsidiaries, `production role ${d.prod_id}`);
        }
        if (!repairsProductionReference && contentSig(t, d.sbx_row) === contentSig(t, d.prod_row)) continue; // unchanged
        const targetId = d.prod_id ?? randomUUID();
        const payload = { ...d.sbx_row, id: targetId, org_id: prod, created_by: null, updated_by: null };
        await db.insert(schema.changeSetItems).values({
          orgId: prod,
          changeSetId: cs.id,
          tableName: t,
          targetId,
          op: d.prod_id ? "update" : "insert",
          payload,
          expectedBefore,
          baseCaptured: true,
        });
        itemCount++;
      }
      // Deletes: production rows with no sandbox counterpart.
      const dels = await db.execute<IdRow>(sql.raw(`
        select p.id, row_to_json(p) as expected_before from "${t}" p
         where p.org_id = '${prod}'
           and not exists (select 1 from "${t}" s where s.org_id = '${sbx}' and s.id = ob_rebase(p.id, '${seed}'))`));
      for (const dr of dels.rows) {
        await db.insert(schema.changeSetItems).values({
          orgId: prod,
          changeSetId: cs.id,
          tableName: t,
          targetId: dr.id,
          op: "delete",
          payload: null,
          expectedBefore: dr.expected_before,
          baseCaptured: true,
        });
        itemCount++;
      }
    }
    // The marker is written only after all item inserts have succeeded.  The
    // count is checked again by review and apply to detect any tampering.
    await db.execute(sql`
      update change_sets
         set capture_complete = true, item_count = ${itemCount}, updated_at = now(), updated_by = ${creator}
       where id = ${cs.id} and org_id = ${prod}`);
    return { changeSetId: cs.id, itemCount };
  });
}

/** Mark a complete capture as reviewed by an independent production actor. */
export async function reviewChangeSet(changeSetId: string, reviewerId?: string | null): Promise<void> {
  const id = assertUuid(changeSetId);
  const actor = requireActor(reviewerId, "change-set review");
  await withMaintenanceTransaction(null, async () => {
    const result = await db.execute<ChangeSetRow>(sql`
      select org_id, status, capture_complete, item_count, created_by, reviewed_by, approved_by
        from change_sets where id = ${id} for update`);
    const c = result.rows[0];
    if (!c) throw new Error(`change set not found: ${id}`);
    const prod = assertUuid(c.org_id);
    await assertActiveActor(actor, prod);
    if (c.status !== "draft") throw new Error(`change set is ${c.status}, not draft`);
    if (!c.capture_complete) throw new Error("change set capture is incomplete");
    await assertDistinctActors(actor, [["creator", c.created_by]]);
    const count = await db.execute<{ count: string }>(sql`
      select count(*)::text as count from change_set_items where change_set_id = ${id} and org_id = ${prod}`);
    if (Number(count.rows[0]?.count ?? -1) !== Number(c.item_count)) {
      throw new Error("change set item count does not match its captured snapshot");
    }
    await db.execute(sql`
      update change_sets
         set status = 'reviewed', reviewed_at = now(), reviewed_by = ${actor}, updated_at = now(), updated_by = ${actor}
       where id = ${id} and org_id = ${prod} and status = 'draft'`);
  });
}

/** Approve a reviewed capture by a second independent production actor. */
export async function approveChangeSet(changeSetId: string, approverId?: string | null): Promise<void> {
  const id = assertUuid(changeSetId);
  const actor = requireActor(approverId, "change-set approval");
  await withMaintenanceTransaction(null, async () => {
    const result = await db.execute<ChangeSetRow>(sql`
      select org_id, status, capture_complete, item_count, created_by, reviewed_by, approved_by
        from change_sets where id = ${id} for update`);
    const c = result.rows[0];
    if (!c) throw new Error(`change set not found: ${id}`);
    const prod = assertUuid(c.org_id);
    await assertActiveActor(actor, prod);
    if (c.status !== "reviewed") throw new Error(`change set is ${c.status}, not reviewed`);
    if (!c.capture_complete) throw new Error("change set capture is incomplete");
    await assertDistinctActors(actor, [["creator", c.created_by], ["reviewer", c.reviewed_by]]);
    const count = await db.execute<{ count: string }>(sql`
      select count(*)::text as count from change_set_items where change_set_id = ${id} and org_id = ${prod}`);
    if (Number(count.rows[0]?.count ?? -1) !== Number(c.item_count)) {
      throw new Error("change set item count does not match its captured snapshot");
    }
    await db.execute(sql`
      update change_sets
         set status = 'approved', approved_at = now(), approved_by = ${actor}, updated_at = now(), updated_by = ${actor}
       where id = ${id} and org_id = ${prod} and status = 'reviewed'`);
  });
}

/** Apply an approved change set to production in one transaction. */
export async function applyChangeSet(changeSetId: string, applierId?: string | null): Promise<void> {
  const id = assertUuid(changeSetId);
  const actor = requireActor(applierId, "change-set application");
  await withMaintenanceTransaction(null, async () => {
    await db.execute(sql`set local time zone 'UTC'`);
    const result = await db.execute<ChangeSetRow>(sql`
      select org_id, sandbox_org_id, status, capture_complete, item_count, created_by, reviewed_by, approved_by
        from change_sets where id = ${id} for update`);
    const c = result.rows[0];
    if (!c) throw new Error(`change set not found: ${id}`);
    const prod = assertUuid(c.org_id);
    await assertActiveActor(actor, prod);
    if (c.status !== "approved") throw new Error(`change set is ${c.status}, not approved`);
    if (!c.capture_complete) throw new Error("change set capture is incomplete");
    await assertDistinctActors(actor, [
      ["creator", c.created_by],
      ["reviewer", c.reviewed_by],
      ["approver", c.approved_by],
    ]);

    const items = await db.execute<ChangeSetItemRow>(sql`
      select table_name, target_id, op, payload, expected_before, base_captured from change_set_items
       where change_set_id = ${id} and org_id = ${prod} order by created_at, id`);
    if (items.rows.length !== Number(c.item_count)) {
      throw new Error("change set item count does not match its captured snapshot");
    }
    if (items.rows.some(item => !item.base_captured)) {
      throw new Error("change set has no captured production base; recapture and review it before applying");
    }

    const authority = await promotionAuthority(actor, prod);

    for (const it of items.rows) {
      const t = it.table_name;
      if (!PROMOTABLE.includes(t)) throw new Error(`change set contains non-promotable table: ${t}`);
      const requiredPermission = PROMOTION_PERMISSIONS[t]!;
      if (!permissionSetCovers(authority, requiredPermission)) {
        throw new Error(`${t} promotion requires ${requiredPermission}`);
      }
      if (t === "user_scripts" && !(await lockAndCheckOrgFeature(db, prod, "scripts"))) {
        throw new Error("scripts feature is disabled");
      }
      const target = assertUuid(it.target_id);
      const table = sql`public.${sql.identifier(t)}`;
      const runtimeColumns = t === "user_scripts" ? "{last_run_at,next_run_at}" : "{}";
      // Insert captures carry a null base, and jsonb `- text[]` rejects
      // non-objects — strip runtime cursors only from object bases so new
      // scripts can still promote.
      const expectedBefore = JSON.stringify(it.expected_before);
      const prior = await db.execute<{ row: Record<string, unknown>; matches_base: boolean }>(sql`
        select to_jsonb(existing) as row,
               (to_jsonb(existing) - ${runtimeColumns}::text[]) is not distinct from
               (case when jsonb_typeof(${expectedBefore}::jsonb) = 'object'
                     then ${expectedBefore}::jsonb - ${runtimeColumns}::text[]
                     else ${expectedBefore}::jsonb end) as matches_base
          from ${table} existing
         where id = ${target} and org_id = ${prod} for update`);
      const before = prior.rows[0]?.row ?? null;
      if (it.op === "insert" ? before !== null : before === null) {
        throw new Error(`promotion target ${t}/${target} ${it.op === "insert" ? "already exists" : "no longer exists"}; recapture the change set`);
      }
      if (it.op !== "insert" && !prior.rows[0]!.matches_base) {
        throw new Error(`promotion target ${t}/${target} changed since capture; recapture and review the change set`);
      }
      await assertPromotionOwner(t, before, actor, authority, c.sandbox_org_id, true);
      let after: Record<string, unknown> | null = null;
      if (it.op === "delete") {
        if (t === "user_scripts") {
          const history = await db.execute(sql`select id from script_runs where org_id = ${prod} and script_id = ${target} limit 1`);
          if (history.rows.length) throw new Error("This script has run history and cannot be deleted. Deactivate it instead to preserve its audit history.");
        }
        if (t === "report_definitions" && (before!.kind === "built_in" || before!.system)) {
          throw new Error("built-in reports cannot be deleted by promotion");
        }
        if (t === "app_roles") {
          if (before!.is_built_in) throw new Error("built-in roles cannot be deleted by promotion");
          const held = await db.execute(sql`select id from role_assignments where org_id = ${prod} and role_id = ${target} limit 1`);
          if (held.rows.length) throw new Error("an assigned role cannot be deleted by promotion; reassign its users first");
        }
        await db.execute(sql`delete from ${table} where id = ${target} and org_id = ${prod}`);
      } else {
        const payload = it.payload;
        if (!payload || typeof payload !== "object" || Array.isArray(payload)
          || typeof payload.id !== "string" || payload.id.toLowerCase() !== target.toLowerCase()
          || typeof payload.org_id !== "string" || payload.org_id.toLowerCase() !== prod.toLowerCase()) {
          throw new Error(`promotion payload identity does not match ${t}/${target}`);
        }
        if (t === "user_scripts") {
          const invalid = validateScriptConfiguration({
            name: payload.name, triggerPoint: payload.trigger_point, source: payload.source,
            documentKind: payload.document_kind, endpointSlug: payload.endpoint_slug,
            cron: payload.cron, timeoutMs: payload.timeout_ms, sortOrder: payload.sort_order,
            isActive: payload.is_active,
          });
          if (invalid) throw new Error(`script promotion: ${invalid.message}`);
          // Ignore even legacy captures' runtime values. Preserve the current
          // production cursor unless scheduling policy itself is changing.
          for (const field of SCRIPT_RUNTIME) delete payload[field];
          const next = payload.trigger_point === "scheduled"
            ? computeScheduledScriptNextRunAt(typeof payload.cron === "string" ? payload.cron : null)
            : null;
          const schedulingChanged = !before || ["trigger_point", "cron", "is_active"].some(field => payload[field] !== before[field]);
          if (schedulingChanged) payload.next_run_at = payload.is_active ? next?.toISOString() ?? null : null;
          if (!before) payload.last_run_at = null;
        }
        const userField = USER_REFERENCE_COLUMNS[t];
        if (userField && payload[userField] !== null) {
          const ownerId = typeof payload[userField] === "string" ? assertUuid(payload[userField]) : null;
          const owner = (await db.execute(sql`select id from users where org_id=${prod} and id=${ownerId} for key share`)).rows[0];
          if (!owner) throw new Error(`promotion ${t}/${target}: user reference must belong to production; recapture the change set`);
        }
        await assertPromotionOwner(t, payload, actor, authority, c.sandbox_org_id, false);
        if (t === "report_definitions") {
          if (!before && (payload.kind !== "custom" || payload.system)) {
            throw new Error("built-in report identity is managed by setup, not promotion");
          }
          if (before && ["kind", "system", "report_type"].some(field => payload[field] !== before[field])) {
            throw new Error("promotion cannot change report identity (kind, system, or report type)");
          }
        }
        if (t === "app_roles") {
          const requested = promotedRolePermissions(payload.permissions);
          const current = new Set(before ? promotedRolePermissions(before.permissions) : []);
          const missing = permissionsOutsideCeiling(authority, requested.filter(key => !current.has(key)));
          if (missing.length) throw new Error(`cannot grant permissions you do not hold: ${missing.join(", ")}`);
          payload.permissions = requested;
          // Revalidate a captured scope against live, locked production rows;
          // the target entity can disappear between capture and application.
          const subsidiaries = (await db.execute<{ id: string }>(sql`
            select id from subsidiaries where org_id=${prod} order by id for share`)).rows;
          payload.subsidiary_restriction = remapRoleRestriction(payload.subsidiary_restriction,
            new Map(subsidiaries.map(row => [row.id, row.id])), `promotion role ${target}`);
          if (!before && payload.is_built_in) throw new Error("built-in roles are managed by setup, not promotion");
          if (before) {
            if (before.is_built_in && before.key === "admin") throw new Error("the Administrator role cannot be edited by promotion");
            if (payload.key !== before.key || payload.is_built_in !== before.is_built_in) {
              throw new Error("promotion cannot change a role's key or built-in identity");
            }
            if (before.is_built_in && (payload.name !== before.name || payload.description !== before.description)) {
              throw new Error("only permissions and subsidiary restrictions can change on a built-in role");
            }
          }
        }
        const columns = (await db.execute<{ column_name: string }>(sql`
          select column_name from information_schema.columns
           where table_schema = 'public' and table_name = ${t} order by ordinal_position`)).rows.map((row) => row.column_name);
        if (Object.keys(payload).some((key) => !columns.includes(key))) {
          throw new Error(`promotion payload contains obsolete or unknown columns for ${t}; recapture the change set`);
        }
        const fields = columns.filter((column) => !STRUCTURAL.has(column) && Object.hasOwn(payload, column));
        const incoming = sql`jsonb_populate_record(null::${table}, ${JSON.stringify(payload)}::jsonb) incoming`;
        if (it.op === "update") {
          const sets = fields.map((column) => sql`${sql.identifier(column)} = incoming.${sql.identifier(column)}`);
          if (columns.includes("updated_at")) sets.push(sql`updated_at = clock_timestamp()`);
          if (columns.includes("updated_by")) sets.push(sql`updated_by = ${actor}`);
          if (!sets.length) throw new Error(`promotion has no updatable fields for ${t}/${target}`);
          const updated = await db.execute<{ row: Record<string, unknown> }>(sql`
            update ${table} existing set ${sql.join(sets, sql`, `)} from ${incoming}
             where existing.id = ${target} and existing.org_id = ${prod} returning to_jsonb(existing) as row`);
          after = updated.rows[0]!.row;
        } else {
          const names = [...fields, ...columns.filter((column) => STRUCTURAL.has(column))];
          const values = names.map((column) => {
            if (column === "id") return sql`${target}::uuid`;
            if (column === "org_id") return sql`${prod}::uuid`;
            if (column === "created_at" || column === "updated_at") return sql`clock_timestamp()`;
            if (column === "created_by" || column === "updated_by") return sql`${actor}::uuid`;
            return sql`incoming.${sql.identifier(column)}`;
          });
          const inserted = await db.execute<{ row: Record<string, unknown> }>(sql`
            insert into ${table} as inserted (${sql.join(names.map((name) => sql.identifier(name)), sql`, `)})
            select ${sql.join(values, sql`, `)} from ${incoming} returning to_jsonb(inserted) as row`);
          after = inserted.rows[0]!.row;
        }
      }
      await db.execute(sql`insert into audit_log(org_id, table_name, row_id, action, changes, actor_id)
        values (${prod}, ${t}, ${target}, ${it.op},
          ${JSON.stringify({ operation: "apply_change_set", changeSetId: id, before, after })}::jsonb, ${actor})`);
    }
    await db.execute(sql`
      update change_sets
         set status = 'applied', applied_at = now(), applied_by = ${actor}, updated_at = now(), updated_by = ${actor}
       where id = ${id} and org_id = ${prod} and status = 'approved'`);
  });
}
