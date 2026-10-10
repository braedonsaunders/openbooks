import { z } from "zod";
import { defineRoute } from "@/lib/api/route";

import { pgTextArrayLiteral } from "@/lib/pg-array";
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { guardPermission, type Authz } from '../../../../lib/authz'
import { MODULE_BY_KEY, type OrgNavConfig } from '../../../../lib/nav/registry'
import { LOCAL_NAVIGATION } from '@openbooks/engine/navigation'
import { listActiveExtensionContributions } from '@openbooks/engine/extensions/navigation'
import { safeNavigationHref, validLocalNavigationPreferences } from '../../../../lib/nav/preferences'
import { nativeAppNavigationCatalog } from '../../../../lib/nav/native-apps'

const navItemBodySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("module"), moduleKey: z.string(), placement: z.literal('custom').optional(), label: z.string().trim().min(1).max(100).optional(), iconKey: z.string().optional(), hidden: z.boolean().optional(), mobile: z.boolean().optional() }),
  z.object({ kind: z.literal("app"), appKey: z.string(), label: z.string().optional(), iconKey: z.string().optional(), hidden: z.boolean().optional(), mobile: z.boolean().optional() }),
  z.object({ kind: z.literal("link"), href: z.string().min(1), label: z.string().min(1), iconKey: z.string().optional(), hidden: z.boolean().optional(), mobile: z.boolean().optional(), extensionKey: z.string().optional(), requiredPermission: z.string().optional(), retiredAt: z.string().datetime({ offset: true }).optional() }),
]);
const requestBodySchema = z.object({
  config: z.object({
    version: z.literal(2),
    architectureVersion: z.literal(1).optional(),
    localNavigation: z.record(z.string(), z.object({ items: z.array(z.object({ href: z.string().min(1).max(512), label: z.string().trim().min(1).max(100).optional(), hidden: z.boolean().optional() })).max(64) })).optional(),
    groups: z.array(z.object({ id: z.string().min(1).max(100), label: z.string().min(1).max(80), items: z.array(navItemBodySchema) })).min(1).max(32),
  }),
  expectedUpdatedAt: z.string().datetime({ offset: true }).nullable().optional(),
});


class NavigationSaveRefusal extends Error {
  readonly status = 409
}

export const runtime = 'nodejs'

function validate(config: unknown): config is OrgNavConfig {
  const c = config as OrgNavConfig
  if (!c || c.version !== 2 || !Array.isArray(c.groups) || c.groups.length === 0 || c.groups.length > 32) return false
  const groupIds = new Set<string>()
  const moduleKeys = new Set<string>()
  const appKeys = new Set<string>()
  let itemCount = 0
  for (const g of c.groups) {
    if (
      typeof g.id !== 'string' ||
      !g.id.trim() ||
      g.id.length > 100 ||
      groupIds.has(g.id) ||
      typeof g.label !== 'string' ||
      !g.label.trim() ||
      g.label.length > 80 ||
      !Array.isArray(g.items)
    )
      return false
    groupIds.add(g.id)
    itemCount += g.items.length
    if (itemCount > 256) return false
    for (const i of g.items) {
      if (i.kind === 'module') {
        if (!MODULE_BY_KEY.has(i.moduleKey) || MODULE_BY_KEY.get(i.moduleKey)?.localOnly || moduleKeys.has(i.moduleKey)) return false
        moduleKeys.add(i.moduleKey)
      } else if (i.kind === 'app') {
        if (
          typeof i.appKey !== 'string' ||
          !/^[a-z][a-z0-9-]*$/.test(i.appKey) ||
          appKeys.has(i.appKey) ||
          (i.label !== undefined && (typeof i.label !== 'string' || i.label.length > 100))
        )
          return false
        appKeys.add(i.appKey)
      } else if (i.kind === 'link') {
        if (
          typeof i.href !== 'string' ||
          !safeNavigationHref(i.href) ||
          typeof i.label !== 'string' ||
          !i.label.trim() ||
          i.label.length > 100
        )
          return false
      } else {
        return false
      }
      if (i.mobile !== undefined && typeof i.mobile !== 'boolean') return false
    }
  }
  const mobileCount = c.groups.flatMap((group) => group.items).filter((item) => item.mobile).length
  if (mobileCount > 4) return false
  return true
}

/**
 * Navigation is administered under the catalogue key admin.nav.manage
 * ("Customize navigation", the key the admin hub tile gates on). Holders of
 * the historical admin.customization.manage keep their save access so
 * existing administrators lose nothing.
 */
async function guardNavManage(): Promise<Authz | NextResponse> {
  const navGate = await guardPermission('admin.nav.manage');
  if (!(navGate instanceof NextResponse)) return navGate;
  // Preserve the authentication failure from the first gate. Probing the
  // legacy permission is only a compatibility fallback for an authenticated
  // user who lacks the new key; it must not turn a 401 into a misleading 403.
  if (navGate.status === 401) return navGate;
  const customizationGate = await guardPermission('admin.customization.manage');
  if (!(customizationGate instanceof NextResponse)) return customizationGate;
  return NextResponse.json({ error: 'missing permission: admin.nav.manage' }, { status: 403 });
}



export const PUT = defineRoute({
  authorize: async () => guardNavManage(),
  feature: { none: "Navigation access is controlled by the navigation and customization permissions." },
  body: requestBodySchema,
  handler: async ({ body, authz: gate }) => {
    const { config, expectedUpdatedAt } = body;
    const { user } = gate




    if (!validate(config)) return NextResponse.json({ error: 'invalid nav config' }, { status: 400 })
    if (expectedUpdatedAt !== undefined && expectedUpdatedAt !== null && (typeof expectedUpdatedAt !== 'string' || Number.isNaN(Date.parse(expectedUpdatedAt)))) {
      return NextResponse.json({ error: 'invalid nav config' }, { status: 400 })
    }

    const configuredAppKeys = config.groups.flatMap((group) =>
      group.items.flatMap((item) => (item.kind === 'app' ? [item.appKey] : [])),
    )
    if (configuredAppKeys.length > 0) {
      const installed = (await db.execute<{ key: string }>(sql`
        select key from apps where org_id = ${user.orgId} and key = any(${pgTextArrayLiteral(configuredAppKeys)}::text[])
      `))
      if (installed.rows.length !== configuredAppKeys.length) {
        return NextResponse.json({ error: 'navigation references an unknown app' }, { status: 400 })
      }
    }

    const outcome = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`extension-projections:${user.orgId}`}, 0))`);
      const before = (await tx.execute<{ id: string; config: OrgNavConfig; updated_at: Date }>(sql`
        select id, config, updated_at from org_nav_configs where org_id = ${user.orgId} limit 1 for update
      `))
      if (config.localNavigation) {
        const catalog = new Map(LOCAL_NAVIGATION.map((set) => [set.id, new Set(set.tabs.map((tab) => tab.href))]))
        for (const app of await nativeAppNavigationCatalog(user.orgId, tx)) catalog.set(app.id, new Set(app.tabs.map((tab) => tab.href)))
        for (const entry of await listActiveExtensionContributions(user.orgId, tx)) {
          if (entry.contribution.kind === 'nav' && entry.contribution.workspaceKey) catalog.get(entry.contribution.workspaceKey)?.add(entry.contribution.href)
        }
        // Retired extension screens keep their stored presentation preferences.
        // They may be preserved unchanged, but only live destinations can be edited.
        for (const [key, savedPreference] of Object.entries(before.rows[0]?.config.localNavigation ?? {})) {
          const draft = config.localNavigation[key]
          if (draft?.items.length === savedPreference.items.length && draft.items.every((item, index) => {
            const saved = savedPreference.items[index]!
            return item.href === saved.href && item.label === saved.label && item.hidden === saved.hidden
          })) {
            const hrefs = catalog.get(key) ?? new Set<string>()
            for (const item of savedPreference.items) hrefs.add(item.href)
            catalog.set(key, hrefs)
          }
        }
        if (!validLocalNavigationPreferences(config.localNavigation, catalog)) return { invalid: true as const, conflict: false as const }
      }
      // Optimistic fence for the full-config write: the editor sends the row
      // version it loaded, compared while holding the row lock. updated_at is
      // the compare token (millisecond compare after a Date round trip — two
      // administrators saving within the same millisecond of one read is the
      // accepted residual; every human-scale race is rejected). An absent
      // expectation is a legacy writer and stays unfenced.
      if (expectedUpdatedAt !== undefined) {
        const current = before.rows[0]?.updated_at ?? null
        const expectedTime = expectedUpdatedAt === null ? null : Date.parse(expectedUpdatedAt)
        const currentTime = current === null ? null : new Date(current).getTime()
        if (expectedTime !== currentTime) return { conflict: true as const }
      }
      const owned = new Map((before.rows[0]?.config.groups ?? []).flatMap((group) => group.items).flatMap((item) => item.kind === 'link' && item.extensionKey ? [[item.href, item] as const] : []))
      for (const group of config.groups) for (const item of group.items) if (item.kind === 'link') {
        const source = owned.get(item.href)
        // Preserve installer provenance across editor round trips; only the installer can mint it.
        if (source) { item.extensionKey = source.extensionKey; item.requiredPermission = source.requiredPermission }
        else { delete item.extensionKey; delete item.requiredPermission }
      }
      const saved = (await tx.execute<{ id: string; updated_at: Date }>(sql`
        insert into org_nav_configs (org_id, config, created_by, updated_by)
        values (${user.orgId}, ${JSON.stringify(config)}, ${user.id}, ${user.id})
        on conflict (org_id) do update set
          config = excluded.config,
          updated_at = now(),
          updated_by = ${user.id}
        where org_nav_configs.org_id = ${user.orgId}
        returning id, updated_at
      `))
      if (!saved.rows[0]) throw new NavigationSaveRefusal('Navigation was not saved; reload the editor and try again')
      const audited = await tx.execute<{ id: string }>(sql`
        insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
        values (
          ${user.orgId},
          'org_nav_configs',
          ${saved.rows[0]!.id},
          ${before.rows[0] ? 'update' : 'insert'},
          ${JSON.stringify({ before: before.rows[0]?.config ?? null, after: config })}::jsonb,
          ${user.id}
        )
        returning id
      `)
      if (!audited.rows[0]) throw new NavigationSaveRefusal('Navigation was not saved because audit evidence could not be recorded; reload the editor and try again')
      return { invalid: false as const, conflict: false as const, id: saved.rows[0]!.id, updatedAt: saved.rows[0]!.updated_at }
    })
    if (outcome.conflict) {
      return NextResponse.json({ error: 'navigation config changed since loaded' }, { status: 409 })
    }
    if (outcome.invalid) return NextResponse.json({ error: 'invalid nav config' }, { status: 400 })
    return NextResponse.json({ ok: true, revision: new Date(outcome.updatedAt).toISOString() })
  },
});
