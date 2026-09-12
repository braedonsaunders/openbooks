import { sql } from 'drizzle-orm';
import { isDeepStrictEqual } from 'node:util';
import { actorHasPermission } from '../actor-permissions.ts';
import { db, type SqlExecutor } from '../db.ts';
import { isCataloguePermission, permissionSetCovers } from '../permissions.ts';
import { defaultNavConfig, type OrgNavConfig } from './nav-registry.ts';
import { supplementalContributionSchema, type SupplementalContribution } from './contribution-schemas.ts';

export const CONTRIBUTION_PERMISSIONS = {
  nav: 'admin.customization.manage', setting: 'admin.setup.manage', permission: 'admin.roles.manage',
} as const;

export async function listActiveModuleContributions(orgId: string, tx: SqlExecutor = db) {
  const rows = (await tx.execute<{ moduleKey: string; moduleId: string; versionId: string; manifest: { contributions?: unknown[] } }>(sql`
    select m.key as "moduleKey", m.id as "moduleId", v.id as "versionId", v.manifest
    from modules m join module_versions v on v.id = m.active_version_id and v.org_id = m.org_id
    where m.org_id = ${orgId} and m.status = 'installed' and m.kind = 'module' and v.status = 'active'
  `)).rows;
  return rows.flatMap(({ manifest, ...row }) => (manifest.contributions ?? []).flatMap((raw) => {
    if (!raw || typeof raw !== 'object' || !('kind' in raw) || !['nav', 'setting', 'permission'].includes(String(raw.kind))) return [];
    return [{ ...row, contribution: supplementalContributionSchema.parse(raw) }];
  }));
}

type SettingHistory = Record<string, Record<string, { effectiveFrom: string; value: unknown }[]>>;

function timestampMicros(value: string): bigint {
  const milliseconds = new Date(value).getTime();
  if (!Number.isFinite(milliseconds)) throw new Error('Invalid stored settings effective date');
  const fraction = /\.(\d+)/.exec(value)?.[1] ?? '';
  return BigInt(milliseconds) * 1000n + BigInt(fraction.padEnd(6, '0').slice(3, 6));
}

/** As-of reads use immutable value history; changing defaults never reinterprets prior configuration. */
export async function getModuleSettings(orgId: string, tx: SqlExecutor = db, asOf?: Date): Promise<Record<string, Record<string, unknown>>> {
  const row = (await tx.execute<{ settings: Record<string, unknown> }>(sql`select settings from orgs where id = ${orgId}`)).rows[0];
  if (asOf) {
    if (!Number.isFinite(asOf.getTime())) throw new Error('Invalid settings effective date');
    const history = (row?.settings.moduleSettingsHistory ?? {}) as SettingHistory;
    return Object.fromEntries(Object.entries(history).map(([moduleKey, settings]) => [moduleKey,
      Object.fromEntries(Object.entries(settings).flatMap(([key, versions]) => {
        const version = versions.filter((entry) => timestampMicros(entry.effectiveFrom) <= BigInt(asOf.getTime()) * 1000n).at(-1);
        return version ? [[key, version.value]] : [];
      })),
    ]));
  }
  const settings = row?.settings.moduleSettings;
  return settings && typeof settings === 'object' && !Array.isArray(settings) ? settings as Record<string, Record<string, unknown>> : {};
}

async function effectiveTimestamp(tx: SqlExecutor): Promise<string> {
  return (await tx.execute<{ timestamp: string }>(sql`select clock_timestamp()::text as timestamp`)).rows[0]!.timestamp;
}

function appendSettingHistory(settings: Record<string, unknown>, moduleKey: string, key: string, value: unknown, effectiveFrom: string) {
  const history = structuredClone((settings.moduleSettingsHistory ?? {}) as SettingHistory);
  const module = history[moduleKey] ?? {};
  module[key] = [...(module[key] ?? []), { effectiveFrom, value }];
  history[moduleKey] = module;
  settings.moduleSettingsHistory = history;
}

async function audit(tx: SqlExecutor, args: { orgId: string; actorId: string; rowId: string; table: string; reason: string; before: unknown; after: unknown; event?: string }) {
  await tx.execute(sql`insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${args.orgId}, ${args.table}, ${args.rowId}, 'update',
      ${JSON.stringify({ event: args.event ?? 'module_projection', reason: args.reason, before: args.before, after: args.after })}::jsonb, ${args.actorId})`);
}

/** Caller owns the module/org transaction lock. All projections and their evidence commit together. */
export async function projectSupplementalContributions(tx: SqlExecutor, args: {
  orgId: string; actorId: string; moduleId: string; moduleKey: string; versionId: string;
  contributions: SupplementalContribution[]; reason: string; previousVersionId?: string | null;
}) {
  const previous = args.previousVersionId ? (await tx.execute<{ manifest: { contributions?: unknown[] } }>(sql`select manifest from module_versions where org_id = ${args.orgId} and module_id = ${args.moduleId} and id = ${args.previousVersionId}`)).rows[0]?.manifest.contributions ?? [] : [];
  const previousDeclarations = previous.flatMap((raw) => { const parsed = supplementalContributionSchema.safeParse(raw); return parsed.success ? [parsed.data] : []; });
  const siblings = (await listActiveModuleContributions(args.orgId, tx)).filter((entry) => entry.moduleId !== args.moduleId);
  for (const contribution of args.contributions) {
    if (contribution.kind === 'permission') {
      const owner = (await tx.execute<{ key: string }>(sql`
        select m.key from modules m join module_versions v on v.module_id = m.id and v.org_id = m.org_id
        cross join lateral jsonb_array_elements(coalesce(v.manifest->'contributions', '[]'::jsonb)) declaration
        where m.org_id = ${args.orgId} and m.id <> ${args.moduleId} and m.kind = 'module'
          and declaration->>'kind' = 'permission' and declaration->>'key' = ${contribution.key} limit 1
      `)).rows[0];
      if (owner) throw new Error(`permission ${contribution.key} is reserved by module ${owner.key}; historical grants cannot be reassigned`);
    }
    if (contribution.kind === 'permission' && (isCataloguePermission(contribution.key) || siblings.some((entry) => entry.contribution.kind === 'permission' && entry.contribution.key === contribution.key))) {
      throw new Error(`permission ${contribution.key} already has an owner`);
    }
  }
  const navs = args.contributions.filter((c) => c.kind === 'nav').sort((a, b) => a.sortOrder - b.sortOrder);
  for (const nav of navs) if (nav.requiredPermission && !isCataloguePermission(nav.requiredPermission) &&
    ![...args.contributions, ...siblings.map((entry) => entry.contribution)].some((entry) => entry.kind === 'permission' && entry.key === nav.requiredPermission)) {
    throw new Error(`navigation requires undeclared permission ${nav.requiredPermission}`);
  }
  const navRow = (await tx.execute<{ id: string; config: OrgNavConfig }>(sql`select id, config from org_nav_configs where org_id = ${args.orgId} for update`)).rows[0];
  const beforeNav = navRow?.config ?? null;
  const config: OrgNavConfig = structuredClone(beforeNav ?? defaultNavConfig());
  let changed = false;
  for (const group of config.groups) for (const item of group.items) {
    if (item.kind === 'link' && item.moduleKey === args.moduleKey && !item.hidden) { item.hidden = true; changed = true; }
  }
  for (const contribution of navs) {
    const occupants = config.groups.flatMap((group) => group.items).filter((item) => item.kind === 'link' && item.href === contribution.href);
    if (occupants.some((item) => item.kind === 'link' && item.moduleKey !== args.moduleKey)) throw new Error(`navigation href ${contribution.href} already has an owner`);
    // Move our owned row when the new version changes its group; never duplicate a live shortcut.
    for (const group of config.groups) group.items = group.items.filter((item) => !(item.kind === 'link' && item.moduleKey === args.moduleKey && item.href === contribution.href));
    let group = config.groups.find((g) => g.id === contribution.group);
    if (!group) { const canonical = defaultNavConfig().groups.find((g) => g.id === contribution.group)!; group = { ...canonical, items: [] }; config.groups.push(group); }
    group.items.push({ kind: 'link', href: contribution.href, label: contribution.label, iconKey: contribution.iconKey, moduleKey: args.moduleKey, requiredPermission: contribution.requiredPermission });
    changed = true;
  }
  if (config.groups.reduce((n, group) => n + group.items.length, 0) > 256) throw new Error('navigation exceeds 256 items');
  if (changed) {
    const row = (await tx.execute<{ id: string }>(sql`insert into org_nav_configs (org_id, config, created_by, updated_by)
      values (${args.orgId}, ${JSON.stringify(config)}::jsonb, ${args.actorId}, ${args.actorId})
      on conflict (org_id) do update set config = excluded.config, updated_by = excluded.updated_by, updated_at = now() returning id`)).rows[0]!;
    await audit(tx, { ...args, rowId: row.id, table: 'org_nav_configs', before: beforeNav, after: config });
  }
  const settings = args.contributions.filter((c) => c.kind === 'setting');
  if (settings.length) {
    const row = (await tx.execute<{ settings: Record<string, unknown> }>(sql`select settings from orgs where id = ${args.orgId} for update`)).rows[0]!;
    const before = structuredClone(row.settings);
    const modules = await getModuleSettings(args.orgId, tx);
    const values = { ...(modules[args.moduleKey] ?? {}) };
    const after: Record<string, unknown> = { ...row.settings, moduleSettings: { ...modules, [args.moduleKey]: values } };
    const effectiveFrom = await effectiveTimestamp(tx);
    for (const setting of settings) if (Object.hasOwn(values, setting.key)) supplementalContributionSchema.parse({ ...setting, defaultValue: values[setting.key] });
    for (const setting of settings) if (!Object.hasOwn(values, setting.key) && setting.defaultValue !== undefined) {
      values[setting.key] = setting.defaultValue;
      appendSettingHistory(after, args.moduleKey, setting.key, setting.defaultValue, effectiveFrom);
    }
    await tx.execute(sql`update orgs set settings = ${JSON.stringify(after)}::jsonb where id = ${args.orgId}`);
    await audit(tx, { ...args, rowId: args.orgId, table: 'orgs', before, after });
  }
  for (const contribution of args.contributions.filter((c) => c.kind === 'permission')) {
    const prior = previousDeclarations.find((entry) => entry.kind === 'permission' && entry.key === contribution.key);
    await audit(tx, { ...args, rowId: args.moduleId, table: 'modules', before: prior ? { contribution: prior, versionId: args.previousVersionId, grantable: true } : null, after: { contribution, versionId: args.versionId, grantable: true } });
  }
  for (const prior of previousDeclarations.filter((entry) => entry.kind !== 'nav')) {
    if (args.contributions.some((entry) => entry.kind !== 'nav' && entry.kind === prior.kind && entry.key === prior.key)) continue;
    await audit(tx, { ...args, rowId: args.moduleId, table: 'modules', event: 'module_projection_withdrawn', before: { contribution: prior, active: true }, after: { contribution: prior, active: false, storedValuesPreserved: true } });
  }
}

export async function withdrawSupplementalContributions(tx: SqlExecutor, args: {
  orgId: string; actorId: string; moduleId: string; moduleKey: string; reason: string;
}) {
  const active = (await listActiveModuleContributions(args.orgId, tx)).filter((entry) => entry.moduleId === args.moduleId);
  await projectSupplementalContributions(tx, { ...args, versionId: '', contributions: [] });
  for (const entry of active.filter((entry) => entry.contribution.kind !== 'nav')) await audit(tx, {
    ...args, rowId: args.moduleId, table: 'modules', event: 'module_projection_withdrawn',
    before: { contribution: entry.contribution, active: true }, after: { contribution: entry.contribution, active: false, storedValuesPreserved: true },
  });
  return active.length;
}

export async function updateModuleSetting(args: {
  orgId: string; actorId: string; moduleKey: string; key: string; value: unknown; reason: string; effectivePermissions: readonly string[];
  expectedValue?: unknown; expectedModuleVersionId?: string;
}) {
  if (!args.reason.trim()) throw new Error('A reason is required');
  if (!permissionSetCovers(new Set(args.effectivePermissions), 'admin.setup.manage')) throw new Error('admin.setup.manage required');
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`module-projections:${args.orgId}`}, 0))`);
    if (!(await actorHasPermission(tx, args.orgId, args.actorId, 'admin.setup.manage'))) throw new Error('admin.setup.manage required');
    const entry = (await listActiveModuleContributions(args.orgId, tx)).find((entry) => entry.moduleKey === args.moduleKey && entry.contribution.kind === 'setting' && entry.contribution.key === args.key);
    if (!entry || entry.contribution.kind !== 'setting') throw new Error('Active module setting not found');
    if (args.expectedModuleVersionId !== undefined && entry.versionId !== args.expectedModuleVersionId) throw Object.assign(new Error('Module version changed; reload the setting before saving'), { status: 409 });
    supplementalContributionSchema.parse({ ...entry.contribution, defaultValue: args.value });
    if (args.value === undefined) throw new Error('A setting value is required');
    const row = (await tx.execute<{ settings: Record<string, unknown> }>(sql`select settings from orgs where id = ${args.orgId} for update`)).rows[0]!;
    const values = await getModuleSettings(args.orgId, tx);
    if (Object.hasOwn(args, 'expectedValue') && !isDeepStrictEqual(values[args.moduleKey]?.[args.key] ?? null, args.expectedValue ?? null)) throw Object.assign(new Error('Setting changed; reload before saving'), { status: 409 });
    const after: Record<string, unknown> = { ...row.settings, moduleSettings: { ...values, [args.moduleKey]: { ...values[args.moduleKey], [args.key]: args.value } } };
    appendSettingHistory(after, args.moduleKey, args.key, args.value, await effectiveTimestamp(tx));
    await tx.execute(sql`update orgs set settings = ${JSON.stringify(after)}::jsonb where id = ${args.orgId}`);
    await audit(tx, { ...args, table: 'orgs', rowId: args.orgId, event: 'module_setting_changed', before: row.settings, after });
    return { ok: true };
  });
}
