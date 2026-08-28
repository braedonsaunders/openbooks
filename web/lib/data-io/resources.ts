import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { SETUP_ENTITIES, SETUP_ENTITY_BY_KEY, type SetupEntity } from '../setup/registry'
import { featureEnabled, resolvedFeatureState } from '../features'
import { DOC_KINDS, docKindConfig } from '../document-kinds'
import { isDocKindEnabled } from '../documents'
import { loadRecordTypeByKey } from '../records'
import {
  PAYROLL_OPENING_BALANCES_DESCRIPTOR,
  PAYROLL_OPENING_BALANCES_KEY,
  PAYROLL_OPENING_ENTITLEMENTS_DESCRIPTOR,
  PAYROLL_OPENING_ENTITLEMENTS_KEY,
  payrollOpeningBalancesResource,
  payrollOpeningEntitlementsResource,
} from './payroll-opening-balances-resource'
import {
  PRIOR_PAYROLL_REGISTER_DESCRIPTOR,
  PRIOR_PAYROLL_REGISTER_KEY,
  priorPayrollRegisterResource,
} from './prior-payroll-register-resource'
import { MASTER_ENTITIES, MASTER_BY_KEY, masterDescriptor, masterResource } from './master-data-resources'
import { PROPERTY_DESCRIPTORS, PROPERTY_DESCRIPTOR_BY_KEY, propertyDataResource, propertyManagementEnabled } from './property-resources'
import { recordSections, recordResource } from './record-resources'
import { setupDescriptor, setupResource } from './setup-resources'
import { transactionDescriptor, transactionResource } from './transaction-resources'
import {
  orgFeatureEnabled,
  subsidiaryReadFilter,
  type DataResource,
  type ReadCtx,
  type ReadResult,
} from './resource-core'
import { type ResourceDescriptor } from './types'
import type { ResourceField } from './types'

export type { ReadResult, WriteCtx, DataResource, ReadCtx } from './resource-core'
export { RefResolver } from './resource-core'

/**
 * This file is the module's public surface: the org-scoped registry API plus a
 * re-export of the cohesive sibling modules without changing any name or
 * signature.
 */

/**
 * Server registry of import/export resources. Every entity family (Setup
 * config, master data, custom records) is exposed as a uniform `DataResource`
 * bound to one org, so the export route, import route, and wizard never
 * special-case a table.
 *
 * SECURITY: table/column identifiers come only from trusted registries
 * (SETUP_ENTITIES / the master descriptors below / a record type's linted
 * field defs) — never from a request body. All values are bound parameters,
 * and every write path delegates to the same validators the interactive UIs
 * use (setup coerce, validateCustomValues, forms-core validateRecordData).
 */

// --- Feature-gated setup entity lookup ----------------------------------------

async function setupEntityEnabled(entity: SetupEntity, orgId: string): Promise<boolean> {
  if (!entity.featureKey) return true
  return orgFeatureEnabled(orgId, entity.featureKey)
}

type SubsidiaryScope = ReadonlySet<string> | null

function scopeAllows(
  scope: SubsidiaryScope,
  subsidiaryId: unknown,
  orgWideNull = false,
): boolean {
  if (scope === null) return true
  const value = String(subsidiaryId ?? '').trim()
  if (!value) return orgWideNull
  return scope.has(value)
}

/**
 * Resolve the names used by export adapters for subsidiary references. Setup
 * and property resources intentionally export natural keys, so filtering the
 * already-shaped result must compare against the same names rather than UUIDs.
 */
async function subsidiaryNames(orgId: string, scope: SubsidiaryScope): Promise<Set<string>> {
  if (scope === null) return new Set()
  const result = (await db.execute(sql`
    select id, name
      from subsidiaries
     where org_id = ${orgId}${subsidiaryReadFilter(sql`id`, scope)}`)) as {
    rows: { id: string; name: string }[]
  }
  const names = new Set<string>()
  for (const row of result.rows) {
    names.add(row.id)
    names.add(row.name)
  }
  return names
}

function scopeReferenceFields(result: ReadResult): ResourceField[] {
  return result.fields.filter((field) => field.ref?.resource === 'subsidiaries')
}

function filterReferenceScopedRows(
  result: ReadResult,
  names: ReadonlySet<string>,
  scope: ReadonlySet<string>,
): ReadResult | null {
  const fields = scopeReferenceFields(result)
  if (fields.length === 0) return null
  return {
    ...result,
    rows: result.rows.filter((row) => fields.every((field) => {
      const value = row[field.key]
      if (value === null || value === undefined || value === '') return false
      return names.has(String(value)) || scope.has(String(value))
    })),
  }
}

async function filterMasterRows(
  orgId: string,
  key: string,
  result: ReadResult,
  scope: SubsidiaryScope,
): Promise<ReadResult | null> {
  if (key !== 'accounts' && key !== 'parties') return null
  const table = key === 'accounts' ? 'accounts' : 'parties'
  const rowKey = key === 'accounts' ? 'number' : 'shortCode'
  const raw = (await db.execute(sql`
    select ${sql.raw(key === 'accounts' ? 'number' : 'short_code')} as row_key,
           ${sql.raw(key === 'accounts' ? 'name' : 'display_name')} as display_name,
           subsidiary_id
      from ${sql.raw(table)}
     where org_id = ${orgId}`)) as {
    rows: { row_key: string | null; display_name: string | null; subsidiary_id: string | null }[]
  }
  const visible = new Set<string>()
  for (const row of raw.rows) {
    if (!scopeAllows(scope, row.subsidiary_id, true)) continue
    if (row.row_key) visible.add(row.row_key)
    if (row.display_name) visible.add(row.display_name)
  }
  return {
    ...result,
    rows: result.rows.filter((row) => {
      const value = row[rowKey] ?? (key === 'parties' ? row.displayName : undefined)
      return visible.has(String(value ?? ''))
    }),
  }
}

async function propertyVisibleKeys(orgId: string, scope: SubsidiaryScope): Promise<{
  propertyCodes: Set<string>
  leaseNumbers: Set<string>
}> {
  const propertyCodes = new Set<string>()
  const leaseNumbers = new Set<string>()
  const result = (await db.execute(sql`
    select p.code as property_code, l.lease_number
      from managed_properties p
      left join property_leases l on l.property_id = p.id and l.org_id = p.org_id
     where p.org_id = ${orgId}${subsidiaryReadFilter(sql`p.subsidiary_id`, scope)}`)) as {
    rows: { property_code: string; lease_number: string | null }[]
  }
  for (const row of result.rows) {
    propertyCodes.add(row.property_code)
    if (row.lease_number) leaseNumbers.add(row.lease_number)
  }
  return { propertyCodes, leaseNumbers }
}

async function filterPropertyRows(
  orgId: string,
  key: string,
  result: ReadResult,
  scope: SubsidiaryScope,
): Promise<ReadResult | null> {
  if (!['properties', 'property-units', 'property-leases', 'lease-charges', 'security-deposit-opening-balances'].includes(key)) {
    return null
  }
  if (key === 'properties') {
    const names = await subsidiaryNames(orgId, scope)
    return {
      ...result,
      rows: result.rows.filter((row) => names.has(String(row.subsidiary ?? ''))),
    }
  }
  const visible = await propertyVisibleKeys(orgId, scope)
  const useLease = key === 'property-leases' || key === 'lease-charges' || key === 'security-deposit-opening-balances'
  const field = useLease ? 'leaseNumber' : 'propertyCode'
  const keys = useLease ? visible.leaseNumbers : visible.propertyCodes
  return {
    ...result,
    rows: result.rows.filter((row) => keys.has(String(row[field] ?? ''))),
  }
}

async function employeeVisibleLabels(orgId: string, scope: SubsidiaryScope): Promise<Set<string>> {
  const result = (await db.execute(sql`
    select distinct coalesce(er.employee_number, p.short_code, p.display_name) as employee,
           p.display_name, p.subsidiary_id
      from parties p
      left join employee_roles er on er.party_id = p.id and er.org_id = p.org_id
      left join employee_payroll_profiles prof on prof.employee_party_id = p.id and prof.org_id = p.org_id
     where p.org_id = ${orgId}
       and (er.party_id is not null or prof.employee_party_id is not null)
       and p.subsidiary_id is not null`)) as {
    rows: { employee: string | null; display_name: string | null; subsidiary_id: string | null }[]
  }
  const labels = new Set<string>()
  for (const row of result.rows) {
    if (!scopeAllows(scope, row.subsidiary_id, true)) continue
    if (row.employee) labels.add(row.employee)
    if (row.display_name) labels.add(row.display_name)
  }
  return labels
}

async function filterPayrollRows(
  orgId: string,
  key: string,
  result: ReadResult,
  scope: SubsidiaryScope,
): Promise<ReadResult | null> {
  if (!['payroll-opening-balances', 'payroll-opening-entitlements', 'prior-payroll-register'].includes(key)) {
    return null
  }
  const labels = await employeeVisibleLabels(orgId, scope)
  return {
    ...result,
    rows: result.rows.filter((row) => labels.has(String(row.employee ?? ''))),
  }
}

/** Bind role-derived visibility to every resource returned by the registry. */
function bindReadScope(resource: DataResource, orgId: string, scope?: SubsidiaryScope): DataResource {
  if (scope === undefined) return resource
  return {
    ...resource,
    async read(readCtx?: ReadCtx) {
      const effectiveScope = readCtx ? readCtx.allowedSubsidiaryIds : scope
      const result = await resource.read({ allowedSubsidiaryIds: effectiveScope })
      if (effectiveScope === null) return result

      // Transaction resources enforce this in their source query. The generic
      // adapters below cover setup, master, property, payroll and custom
      // records whose legacy read methods expose natural keys instead.
      const master = await filterMasterRows(orgId, resource.descriptor.key, result, effectiveScope)
      if (master) return master
      const property = await filterPropertyRows(orgId, resource.descriptor.key, result, effectiveScope)
      if (property) return property
      const payroll = await filterPayrollRows(orgId, resource.descriptor.key, result, effectiveScope)
      if (payroll) return payroll
      const names = await subsidiaryNames(orgId, effectiveScope)
      return filterReferenceScopedRows(result, names, effectiveScope) ?? result
    },
  }
}

// --- Public registry API ------------------------------------------------------

/** All resources visible to this org (records enumerated dynamically). */
export async function listResources(orgId: string): Promise<ResourceDescriptor[]> {
  const features = await resolvedFeatureState(orgId)
  const setup = SETUP_ENTITIES
    .filter((entity) => !entity.featureKey || featureEnabled(features, entity.featureKey))
    .map(setupDescriptor)
  const master = MASTER_ENTITIES.map(masterDescriptor)
  const recordTypes = (await db.execute(sql`
    select key, plural_name from custom_record_types
     where org_id = ${orgId} and status = 'published' order by sort_order, name`)) as {
    rows: { key: string; plural_name: string }[]
  }
  const records: ResourceDescriptor[] = recordTypes.rows.map((t) => ({
    key: `record:${t.key}`,
    label: t.plural_name,
    group: 'Records',
    iconKey: 'clipboard-list',
    readPermission: 'records.read',
    writePermission: 'records.create',
    supportsImport: true,
    naturalKey: 'record_number',
  }))
  const transactions: ResourceDescriptor[] = []
  for (const cfg of Object.values(DOC_KINDS)) {
    if (await isDocKindEnabled(orgId, cfg.kind)) transactions.push(transactionDescriptor(cfg))
  }
  const propertyManagement = featureEnabled(features, 'propertyManagement') ? PROPERTY_DESCRIPTORS : []
  // Mid-year adoption carry-in — a bulk load from the outgoing provider's
  // year-to-date report. See ./payroll-opening-balances-resource.ts.
  // Mid-year adoption carry-in, plus the prior provider's per-period register
  // for a parallel run. See ./prior-payroll-register-resource.ts.
  const payroll = featureEnabled(features, 'payroll')
    ? [
        PAYROLL_OPENING_BALANCES_DESCRIPTOR,
        PAYROLL_OPENING_ENTITLEMENTS_DESCRIPTOR,
        PRIOR_PAYROLL_REGISTER_DESCRIPTOR,
      ]
    : []
  return [...setup, ...master, ...records, ...propertyManagement, ...payroll, ...transactions]
}

/** Resolve one resource bound to the org and (for export reads) its visibility scope. */
export async function getResource(
  orgId: string,
  key: string,
  allowedSubsidiaryIds?: SubsidiaryScope,
): Promise<DataResource | null> {
  if (PROPERTY_DESCRIPTOR_BY_KEY.has(key)) {
    if (!(await propertyManagementEnabled(orgId))) return null
    const resource = propertyDataResource(orgId, key)
    return resource ? bindReadScope(resource, orgId, allowedSubsidiaryIds) : null
  }
  if (key === PRIOR_PAYROLL_REGISTER_KEY) {
    if (!(await orgFeatureEnabled(orgId, 'payroll'))) return null
    return bindReadScope(priorPayrollRegisterResource(orgId), orgId, allowedSubsidiaryIds)
  }
  if (key === PAYROLL_OPENING_BALANCES_KEY) {
    if (!(await orgFeatureEnabled(orgId, 'payroll'))) return null
    return bindReadScope(payrollOpeningBalancesResource(orgId), orgId, allowedSubsidiaryIds)
  }
  if (key === PAYROLL_OPENING_ENTITLEMENTS_KEY) {
    if (!(await orgFeatureEnabled(orgId, 'payroll'))) return null
    return bindReadScope(payrollOpeningEntitlementsResource(orgId), orgId, allowedSubsidiaryIds)
  }
  const setup = SETUP_ENTITY_BY_KEY.get(key)
  if (setup) {
    if (!(await setupEntityEnabled(setup, orgId))) return null
    return bindReadScope(setupResource(setup, orgId), orgId, allowedSubsidiaryIds)
  }
  const master = MASTER_BY_KEY.get(key)
  if (master) return bindReadScope(masterResource(master, orgId), orgId, allowedSubsidiaryIds)
  if (key.startsWith('record:')) {
    const typeKey = key.slice('record:'.length)
    const sections = await recordSections(orgId, typeKey)
    if (!sections) return null
    const type = await loadRecordTypeByKey(orgId, typeKey)
    return bindReadScope(
      recordResource(orgId, typeKey, sections, type?.plural_name ?? typeKey),
      orgId,
      allowedSubsidiaryIds,
    )
  }
  if (key.startsWith('txn:')) {
    const cfg = docKindConfig(key.slice('txn:'.length))
    if (!cfg || !(await isDocKindEnabled(orgId, cfg.kind))) return null
    return bindReadScope(transactionResource(cfg, orgId, allowedSubsidiaryIds), orgId, allowedSubsidiaryIds)
  }
  return null
}
