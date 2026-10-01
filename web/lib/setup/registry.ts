/**
 * openbooks Setup registry — one descriptor per configurable entity. Powers a
 * generic list view (admin/setup/[entity]/page.tsx), a generic create/edit
 * drawer (SetupDrawer.tsx), and a generic CRUD API (api/admin/setup/[entity]).
 * Adding a new configuration surface = adding one entry here.
 *
 * This module is intentionally PURE (no db/server imports) so it can be shared
 * by the server list page, the client drawer, and the API route. Labels are
 * next-intl message keys under the `admin.setup` namespace, resolved at each
 * render site — never translated here. Column/field `key`s are camelCase; the
 * API maps them to snake_case db columns via `toSnake`.
 *
 * SECURITY: column identifiers used to build SQL come ONLY from this registry
 * (never from request bodies). Values are always bound as parameters. That is
 * what makes the generic API safe — see api/admin/setup/[entity]/route.ts.
 */

import type { SetupEntity } from './types'
import { SETUP_GROUPS } from './types'
import { COMPANY_ENTITIES } from './entities/company'
import { ACCOUNTING_ENTITIES } from './entities/accounting'
import { TAX_ENTITIES } from './entities/taxes'
import { DIMENSION_ENTITIES } from './entities/dimensions'
import { BILLING_ENTITIES } from './entities/billing'
import { REVENUE_ENTITIES } from './entities/revenue'
import { INVENTORY_ENTITIES } from './entities/inventory'
import { WAREHOUSE_ENTITIES } from './entities/warehouses'
import { WORKFORCE_ENTITIES } from './entities/workforce'
import { HRM_PROCESS_ENTITIES } from './entities/hrm-processes'
import { ASSET_ENTITIES } from './entities/assets'
import { CURRENCY_ENTITIES } from './entities/currency'
import { MANUFACTURING_ENTITIES } from './entities/manufacturing'
import { USAGE_ENTITIES } from './entities/usage'
import { NONPROFIT_SETUP_ENTITIES } from './entities/nonprofit'

export type { SetupFieldKind, SetupColumnKind, SetupRefSource, SetupOption, SetupDynamicOptionsSource, SetupField, SetupColumn, SetupFilter, SetupEntity, SetupEntityGate, SetupGroup } from './types'
export { setupOptionLabel, setupFieldVisible, setupFieldOptions, setupEntitySubsidiaryField, setupEntitySubsidiaryReferenceFields, setupEntityForFeatureState, resolveSetupEntityGate, SETUP_PROJECTS_OR_MANUFACTURING_REMEDY } from './types'
export { SETUP_GROUPS }
export { OVERHEAD_RATE_KINDS, LIEN_WAIVER_TYPES } from './options'

export const SETUP_ENTITIES: SetupEntity[] = [
  ...COMPANY_ENTITIES,
  ...ACCOUNTING_ENTITIES,
  ...TAX_ENTITIES,
  ...DIMENSION_ENTITIES,
  ...BILLING_ENTITIES,
  ...REVENUE_ENTITIES,
  ...INVENTORY_ENTITIES,
  ...WAREHOUSE_ENTITIES,
  ...WORKFORCE_ENTITIES,
  ...HRM_PROCESS_ENTITIES,
  ...ASSET_ENTITIES,
  ...CURRENCY_ENTITIES,
  ...MANUFACTURING_ENTITIES,
  ...USAGE_ENTITIES,
  ...NONPROFIT_SETUP_ENTITIES,
]

export const SETUP_ENTITY_BY_KEY = new Map(SETUP_ENTITIES.map((e) => [e.key, e]))

/** Collections rendered inside an owning record with the shared setup list. */
export function setupChildEntities(parentKey: string): SetupEntity[] {
  return SETUP_ENTITIES.filter((entity) => entity.parentRecords?.some((parent) => parent.entityKey === parentKey))
}

/** Collection links lead to the owning records, where the child tab is opened. */
export function setupEntityHref(entity: SetupEntity): string {
  if (entity.key === 'benefit-programs') return '/hrm/benefits?view=programs'
  if (entity.key === 'benefit-plans') return '/hrm/benefits?view=programs'
  const parentKey = entity.parentRecords?.[0]?.entityKey
  if (!parentKey) return `/admin/setup/${entity.key}`
  const parentHomes: Record<string, string> = {
    items: '/items',
    'benefit-plans': '/hrm/benefits?view=programs',
    'benefit-programs': '/hrm/benefits?view=programs',
    'tax-regimes': '/admin/setup/tax-depreciation?tab=regimes',
    'entitlement-plans': '/admin/setup/payroll?tab=entitlements',
    'pay-components': '/admin/setup/payroll?tab=components',
  }
  const home = parentHomes[parentKey] ?? `/admin/setup/${parentKey}`
  return `${home}${home.includes('?') ? '&' : '?'}${parentKey === 'items' ? 'itemSetup' : 'setupTab'}=${entity.key}`
}

/** Entities grouped by section, in registry order — drives the left rail. */
export function setupEntitiesByGroup(): Map<string, SetupEntity[]> {
  const byGroup = new Map<string, SetupEntity[]>()
  for (const g of SETUP_GROUPS) byGroup.set(g.key, [])
  for (const e of SETUP_ENTITIES) {
    if (e.nestedUnder || e.parentRecords?.length || e.rehomed) continue
    const list = byGroup.get(e.groupKey)
    if (list) list.push(e)
  }
  return byGroup
}

/** camelCase field key → snake_case db column. */
export function toSnake(key: string): string {
  return key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)
}

/** Generic picker columns for a ref-option target, derived from the columns
 *  the target entity actually declares. Most entities carry code/name
 *  (subsidiaries are name-only, stock locations code-only);
 *  hrm-document-categories carries key/label instead. Referencing fields
 *  store the category's KEY, so the option value is the refValue column
 *  (the natural key), never the row id the write path cannot take back.
 *  loadEntityOptions (./ref-options.ts) builds its SQL from exactly this,
 *  so this function is the single derivation the picker test pins. */
export interface RefTargetPicker {
  /** Option-value column (what referencing rows store). */
  valueCol: string
  /** Label columns: both when a code-like and a name-like column exist
   *  (rendered `code · name`), else the single one, else the natural key,
   *  else the value column itself (never a missing column). */
  labelCols: string[]
  /** ORDER BY column, same priority as the label. */
  orderCol: string
}

export function refTargetPicker(target: SetupEntity): RefTargetPicker {
  const declared = new Set([
    ...target.fields.map((f) => toSnake(f.key)),
    ...target.columns.map((c) => toSnake(c.key)),
  ])
  const valueCol = toSnake(target.refValue ?? target.idColumn ?? 'id')
  const codeCol = declared.has('code') ? 'code' : declared.has('key') ? 'key' : null
  const nameCol = declared.has('name') ? 'name' : declared.has('label') ? 'label' : null
  const naturalCol = target.naturalKey ? toSnake(target.naturalKey) : null
  const labelCols =
    codeCol && nameCol ? [codeCol, nameCol] : [nameCol ?? codeCol ?? naturalCol ?? valueCol]
  return { valueCol, labelCols, orderCol: nameCol ?? codeCol ?? naturalCol ?? valueCol }
}
