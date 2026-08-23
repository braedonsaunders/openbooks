/** Property-management migration import/export resources. */

import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { normalizeMoney } from '@openbooks/engine/src/money.ts'
import {
  activatePropertyLease,
  addLeaseCharge,
  createManagedProperty,
  createPropertyLease,
  createPropertyUnit,
  recordSecurityDeposit,
  scheduleLeaseCharges,
  updateManagedProperty,
  updatePropertyLease,
  updatePropertyUnit,
} from '@openbooks/engine/src/property-management.ts'
import { coerceBoolean, UUID_RE } from '../setup/coerce'
import { INVENTORY_ITEM_KINDS } from './master-data-resources'
import {
  MAX_EXPORT_ROWS,
  orgFeatureEnabled,
  RefResolver,
  type DataResource,
  type WriteCtx,
} from './resource-core'
import {
  type CellValue,
  type ResourceDescriptor,
  type ResourceField,
  type WriteOutcome,
} from './types'
// --- Property-management migration resources --------------------------------

export const PROPERTY_DESCRIPTORS: ResourceDescriptor[] = [
  { key: 'properties', label: 'Properties', group: 'Property management', iconKey: 'building', readPermission: 'ar.read', writePermission: 'ar.create', supportsImport: true, naturalKey: 'code' },
  { key: 'property-units', label: 'Property units', group: 'Property management', iconKey: 'building-2', readPermission: 'ar.read', writePermission: 'ar.create', supportsImport: true, naturalKey: 'propertyCode + code' },
  { key: 'property-leases', label: 'Property leases', group: 'Property management', iconKey: 'file-text', readPermission: 'ar.read', writePermission: 'ar.create', supportsImport: true, naturalKey: 'leaseNumber' },
  { key: 'lease-charges', label: 'Lease charges', group: 'Property management', iconKey: 'receipt', readPermission: 'ar.read', writePermission: 'ar.create', supportsImport: true, naturalKey: 'leaseNumber + chargeType + effectiveFrom + description' },
  { key: 'security-deposit-opening-balances', label: 'Security deposit opening balances', group: 'Property management', iconKey: 'shield-check', readPermission: 'ar.read', writePermission: 'ar.create', supportsImport: true, naturalKey: 'externalKey' },
]
export const PROPERTY_DESCRIPTOR_BY_KEY = new Map(PROPERTY_DESCRIPTORS.map((d) => [d.key, d]))

export async function propertyManagementEnabled(orgId: string): Promise<boolean> {
  return orgFeatureEnabled(orgId, 'propertyManagement')
}
async function naturalId(orgId: string, table: string, column: string, value: unknown): Promise<string | null> {
  const human = String(value ?? '').trim()
  if (!human) return null
  if (UUID_RE.test(human)) return human
  const found = (await db.execute(sql`
    select id from ${sql.raw(table)} where org_id=${orgId} and ${sql.raw(column)}=${human} limit 1`)) as { rows: { id: string }[] }
  return found.rows[0]?.id ?? null
}

function propertyFields(fixedAssetsOn = true, multiCurrencyOn = true): ResourceField[] {
  const fields: ResourceField[] = [
    { key: 'code', label: 'Property code', kind: 'text', required: true },
    { key: 'name', label: 'Property name', kind: 'text', required: true },
    { key: 'propertyType', label: 'Property type', kind: 'select', required: true, options: ['residential', 'commercial', 'mixed_use', 'industrial', 'other'].map((value) => ({ value, label: value })) },
    { key: 'status', label: 'Status', kind: 'select', options: ['active', 'inactive', 'sold'].map((value) => ({ value, label: value })) },
    { key: 'subsidiary', label: 'Subsidiary', kind: 'reference', required: true },
    { key: 'location', label: 'Location code', kind: 'reference' },
    { key: 'fixedAsset', label: 'Fixed asset number', kind: 'reference' },
    { key: 'currency', label: 'Currency', kind: 'text' },
    { key: 'street', label: 'Street', kind: 'text' },
    { key: 'city', label: 'City', kind: 'text' },
    { key: 'region', label: 'Region', kind: 'text' },
    { key: 'postalCode', label: 'Postal code', kind: 'text' },
    { key: 'rentIncomeAccount', label: 'Rent income account', kind: 'reference', ref: { resource: 'accounts', by: 'number' } },
    { key: 'camIncomeAccount', label: 'CAM income account', kind: 'reference', ref: { resource: 'accounts', by: 'number' } },
    { key: 'depositLiabilityAccount', label: 'Deposit liability account', kind: 'reference', ref: { resource: 'accounts', by: 'number' } },
    { key: 'defaultBankAccount', label: 'Default bank account', kind: 'reference', ref: { resource: 'accounts', by: 'number' } },
  ]
  return fields.filter((field) =>
    (fixedAssetsOn || field.key !== 'fixedAsset') &&
    (multiCurrencyOn || field.key !== 'currency'))
}

function propertyResource(orgId: string): DataResource {
  return {
    descriptor: PROPERTY_DESCRIPTOR_BY_KEY.get('properties')!,
    async fields() { return propertyFields(await orgFeatureEnabled(orgId, 'fixedAssets'), await orgFeatureEnabled(orgId, 'multiCurrency')) },
    async columns() {
      return (await propertyFields(await orgFeatureEnabled(orgId, 'fixedAssets'), await orgFeatureEnabled(orgId, 'multiCurrency'))).map((f) => ({ key: f.key, label: f.label }))
    },
    async read() {
      const fields = await propertyFields(await orgFeatureEnabled(orgId, 'fixedAssets'), await orgFeatureEnabled(orgId, 'multiCurrency'))
      const rows = (await db.execute(sql`
        select p.code,p.name,p.property_type as "propertyType",p.status,s.name as subsidiary,l.code as location,
          fa.asset_number as "fixedAsset",p.currency,p.address->>'street' as street,p.address->>'city' as city,
          p.address->>'region' as region,p.address->>'postalCode' as "postalCode",ra.number as "rentIncomeAccount",
          ca.number as "camIncomeAccount",da.number as "depositLiabilityAccount",ba.number as "defaultBankAccount"
        from managed_properties p join subsidiaries s on s.id=p.subsidiary_id and s.org_id=p.org_id
        left join locations l on l.id=p.location_id and l.org_id=p.org_id
        left join fixed_assets fa on fa.id=p.fixed_asset_id and fa.org_id=p.org_id
        left join accounts ra on ra.id=p.rent_income_account_id and ra.org_id=p.org_id
        left join accounts ca on ca.id=p.cam_income_account_id and ca.org_id=p.org_id
        left join accounts da on da.id=p.deposit_liability_account_id and da.org_id=p.org_id
        left join accounts ba on ba.id=p.default_bank_account_id and ba.org_id=p.org_id
        where p.org_id=${orgId} order by p.code limit ${MAX_EXPORT_ROWS}`)) as { rows: Record<string, CellValue>[] }
      return { fields, columns: fields.map((f) => ({ key: f.key, label: f.label })), rows: rows.rows }
    },
    async write(rows, mode, ctx) {
      const outcome: WriteOutcome = { created: 0, updated: 0, failed: 0, errors: [] }
      const accounts = new RefResolver(ctx.orgId)
      const fixedAssetsOn = await orgFeatureEnabled(ctx.orgId, 'fixedAssets')
      const multiCurrencyOn = await orgFeatureEnabled(ctx.orgId, 'multiCurrency')
      for (let index = 0; index < rows.length; index++) {
        const src = rows[index]
        try {
          const code = String(src.code ?? '').trim()
          const name = String(src.name ?? '').trim()
          if (!code || !name || !src.subsidiary) throw new Error('code, name, and subsidiary are required')
          const existing = (await db.execute(sql`select * from managed_properties where org_id=${ctx.orgId} and code=${code} limit 1`)) as { rows: any[] }
          if (existing.rows[0] && mode === 'insert') throw new Error(`already exists (code=${code})`)
          const subsidiaryId = await naturalId(ctx.orgId, 'subsidiaries', 'name', src.subsidiary)
          if (!subsidiaryId) throw new Error(`subsidiary "${String(src.subsidiary)}" not found`)
          const current = existing.rows[0]
          const locationId = src.location ? await naturalId(ctx.orgId, 'locations', 'code', src.location) : current?.location_id ?? null
          if (src.location && !locationId) throw new Error(`location "${String(src.location)}" not found`)
          if (!fixedAssetsOn && src.fixedAsset !== undefined) throw new Error('fixedAsset is not available')
          if (!multiCurrencyOn && src.currency !== undefined) throw new Error('currency is not available')
          const fixedAssetId = src.fixedAsset ? await naturalId(ctx.orgId, 'fixed_assets', 'asset_number', src.fixedAsset) : current?.fixed_asset_id ?? null
          if (src.fixedAsset && !fixedAssetId) throw new Error(`fixed asset "${String(src.fixedAsset)}" not found`)
          const resolveAccount = async (key: string, currentId: string | null) => src[key] ? accounts.resolveId({ resource: 'accounts', by: 'number' }, src[key]) : currentId
          const rentIncomeAccountId = await resolveAccount('rentIncomeAccount', current?.rent_income_account_id ?? null)
          const camIncomeAccountId = await resolveAccount('camIncomeAccount', current?.cam_income_account_id ?? null)
          const depositLiabilityAccountId = await resolveAccount('depositLiabilityAccount', current?.deposit_liability_account_id ?? null)
          const defaultBankAccountId = await resolveAccount('defaultBankAccount', current?.default_bank_account_id ?? null)
          for (const [key, id] of Object.entries({ rentIncomeAccount: rentIncomeAccountId, camIncomeAccount: camIncomeAccountId, depositLiabilityAccount: depositLiabilityAccountId, defaultBankAccount: defaultBankAccountId })) {
            if (src[key] && !id) throw new Error(`${key} "${String(src[key])}" not found`)
          }
          if (ctx.dryRun) {
            existing.rows[0] ? outcome.updated++ : outcome.created++
            continue
          }
          const currentAddress = current?.address ?? {}
          const address = { street: String(src.street ?? currentAddress.street ?? ''), city: String(src.city ?? currentAddress.city ?? ''), region: String(src.region ?? currentAddress.region ?? ''), postalCode: String(src.postalCode ?? currentAddress.postalCode ?? '') }
          const common = { orgId: ctx.orgId, actorId: ctx.actorId, subsidiaryId, locationId, fixedAssetId, code, name, propertyType: String(src.propertyType ?? existing.rows[0]?.property_type ?? 'residential'), address, rentIncomeAccountId, camIncomeAccountId, depositLiabilityAccountId, defaultBankAccountId, ...(multiCurrencyOn ? { currency: String(src.currency ?? existing.rows[0]?.currency ?? '') } : {}) }
          if (existing.rows[0]) {
            await updateManagedProperty({ ...common, propertyId: existing.rows[0].id, status: String(src.status ?? existing.rows[0].status), custom: existing.rows[0].custom ?? {} })
            outcome.updated++
          } else {
            const created = await createManagedProperty(common)
            if (src.status && src.status !== 'active') {
              if (multiCurrencyOn) {
                const createdRow = (await db.execute(sql`select currency from managed_properties where org_id=${ctx.orgId} and id=${created.id}`)) as { rows: { currency: string }[] }
                await updateManagedProperty({ ...common, propertyId: created.id, status: String(src.status), currency: createdRow.rows[0]!.currency, custom: {} })
              } else {
                await updateManagedProperty({ ...common, propertyId: created.id, status: String(src.status), custom: {} })
              }
            }
            outcome.created++
          }
        } catch (error) {
          outcome.failed++
          outcome.errors.push({ row: index + 1, message: error instanceof Error ? error.message : 'write failed' })
        }
      }
      return outcome
    },
  }
}

function unitFields(): ResourceField[] {
  return [
    { key: 'propertyCode', label: 'Property code', kind: 'reference', required: true },
    { key: 'code', label: 'Unit code', kind: 'text', required: true },
    { key: 'name', label: 'Unit name', kind: 'text' },
    { key: 'unitType', label: 'Unit type', kind: 'text' },
    { key: 'rentableArea', label: 'Rentable area', kind: 'number' },
    { key: 'bedrooms', label: 'Bedrooms', kind: 'number' },
    { key: 'status', label: 'Status', kind: 'select', options: ['vacant', 'offline'].map((value) => ({ value, label: value })) },
  ]
}

function unitResource(orgId: string): DataResource {
  const fields = unitFields()
  return {
    descriptor: PROPERTY_DESCRIPTOR_BY_KEY.get('property-units')!,
    async fields() { return fields }, async columns() { return fields.map((f) => ({ key: f.key, label: f.label })) },
    async read() {
      const result = (await db.execute(sql`select p.code as "propertyCode",u.code,u.name,u.unit_type as "unitType",u.rentable_area as "rentableArea",u.bedrooms,u.status from property_units u join managed_properties p on p.id=u.property_id and p.org_id=u.org_id where u.org_id=${orgId} order by p.code,u.code limit ${MAX_EXPORT_ROWS}`)) as { rows: Record<string, CellValue>[] }
      return { fields, columns: fields.map((f) => ({ key: f.key, label: f.label })), rows: result.rows }
    },
    async write(rows, mode, ctx) {
      const outcome: WriteOutcome = { created: 0, updated: 0, failed: 0, errors: [] }
      for (let index = 0; index < rows.length; index++) try {
        const propertyId = await naturalId(ctx.orgId, 'managed_properties', 'code', rows[index].propertyCode)
        const code = String(rows[index].code ?? '').trim()
        if (!propertyId || !code) throw new Error('valid propertyCode and code are required')
        const found = (await db.execute(sql`select * from property_units where org_id=${ctx.orgId} and property_id=${propertyId} and code=${code} limit 1`)) as { rows: any[] }
        if (found.rows[0] && mode === 'insert') throw new Error(`already exists (${String(rows[index].propertyCode)} + ${code})`)
        if (!ctx.dryRun) {
          const values = { orgId: ctx.orgId, actorId: ctx.actorId, code, name: rows[index].name ? String(rows[index].name) : null, unitType: rows[index].unitType ? String(rows[index].unitType) : null, rentableArea: rows[index].rentableArea ? String(rows[index].rentableArea) : null, bedrooms: rows[index].bedrooms === '' || rows[index].bedrooms == null ? null : Number(rows[index].bedrooms) }
          if (found.rows[0]) await updatePropertyUnit({ ...values, unitId: found.rows[0].id, status: String(rows[index].status ?? found.rows[0].status) })
          else {
            const created = await createPropertyUnit({ ...values, propertyId })
            if (rows[index].status === 'offline') await updatePropertyUnit({ ...values, unitId: created.id, status: 'offline' })
          }
        }
        found.rows[0] ? outcome.updated++ : outcome.created++
      } catch (error) { outcome.failed++; outcome.errors.push({ row: index + 1, message: error instanceof Error ? error.message : 'write failed' }) }
      return outcome
    },
  }
}

function leaseFields(): ResourceField[] {
  return [
    { key: 'leaseNumber', label: 'Lease number', kind: 'text', required: true },
    { key: 'propertyCode', label: 'Property code', kind: 'reference', required: true },
    { key: 'unitCode', label: 'Unit code', kind: 'reference' },
    { key: 'tenant', label: 'Tenant short code', kind: 'reference', required: true, ref: { resource: 'parties', by: 'short_code' } },
    { key: 'status', label: 'Status', kind: 'select', options: ['draft', 'active'].map((value) => ({ value, label: value })) },
    { key: 'startsOn', label: 'Starts on', kind: 'date', required: true },
    { key: 'endsOn', label: 'Ends on', kind: 'date' },
    { key: 'baseRent', label: 'Base rent', kind: 'currency', required: true },
    { key: 'billingDay', label: 'Billing day', kind: 'number' },
    { key: 'paymentTermsDays', label: 'Payment terms days', kind: 'number' },
    { key: 'securityDepositRequired', label: 'Security deposit required', kind: 'currency' },
    { key: 'camMethod', label: 'CAM method', kind: 'select', options: ['none', 'fixed', 'pro_rata'].map((value) => ({ value, label: value })) },
    { key: 'camSharePercent', label: 'CAM share percent', kind: 'percent' },
    { key: 'lateFeeType', label: 'Late fee type', kind: 'select', options: ['none', 'fixed', 'percent'].map((value) => ({ value, label: value })) },
    { key: 'lateFeeValue', label: 'Late fee value', kind: 'currency' },
    { key: 'graceDays', label: 'Grace days', kind: 'number' },
    { key: 'autoInvoice', label: 'Auto invoice', kind: 'boolean' },
    { key: 'autoPost', label: 'Auto post', kind: 'boolean' },
  ]
}

function leaseResource(orgId: string): DataResource {
  const fields = leaseFields()
  return {
    descriptor: PROPERTY_DESCRIPTOR_BY_KEY.get('property-leases')!,
    async fields() { return fields }, async columns() { return fields.map((f) => ({ key: f.key, label: f.label })) },
    async read() {
      const result = (await db.execute(sql`select l.lease_number as "leaseNumber",p.code as "propertyCode",u.code as "unitCode",t.short_code as tenant,l.status,l.starts_on as "startsOn",l.ends_on as "endsOn",c.amount as "baseRent",l.billing_day as "billingDay",l.payment_terms_days as "paymentTermsDays",l.security_deposit_required as "securityDepositRequired",l.cam_method as "camMethod",l.cam_share_percent as "camSharePercent",l.late_fee_type as "lateFeeType",l.late_fee_value as "lateFeeValue",l.grace_days as "graceDays",l.auto_invoice as "autoInvoice",l.auto_post as "autoPost" from property_leases l join managed_properties p on p.id=l.property_id and p.org_id=l.org_id left join property_units u on u.id=l.unit_id and u.org_id=l.org_id join parties t on t.id=l.tenant_id and t.org_id=l.org_id left join lateral(select amount from lease_charges where org_id=l.org_id and lease_id=l.id and charge_type='base_rent' order by effective_from desc limit 1)c on true where l.org_id=${orgId} order by l.lease_number limit ${MAX_EXPORT_ROWS}`)) as { rows: Record<string, CellValue>[] }
      return { fields, columns: fields.map((f) => ({ key: f.key, label: f.label })), rows: result.rows }
    },
    async write(rows, mode, ctx) {
      const outcome: WriteOutcome = { created: 0, updated: 0, failed: 0, errors: [] }
      const resolver = new RefResolver(ctx.orgId)
      for (let index = 0; index < rows.length; index++) try {
        const src = rows[index]
        const leaseNumber = String(src.leaseNumber ?? '').trim()
        const propertyId = await naturalId(ctx.orgId, 'managed_properties', 'code', src.propertyCode)
        const tenantId = await resolver.resolveId({ resource: 'parties', by: 'short_code' }, src.tenant)
        if (!leaseNumber || !propertyId || !tenantId || !src.startsOn || !src.baseRent) throw new Error('leaseNumber, valid propertyCode, tenant, startsOn, and baseRent are required')
        const unitId = src.unitCode ? ((await db.execute(sql`select id from property_units where org_id=${ctx.orgId} and property_id=${propertyId} and code=${String(src.unitCode)} limit 1`)) as { rows: { id: string }[] }).rows[0]?.id ?? null : null
        if (src.unitCode && !unitId) throw new Error(`unit "${String(src.unitCode)}" not found on property`)
        const found = (await db.execute(sql`select l.*,(select amount from lease_charges where org_id=l.org_id and lease_id=l.id and charge_type='base_rent' order by effective_from desc limit 1) as base_rent from property_leases l where l.org_id=${ctx.orgId} and l.lease_number=${leaseNumber} limit 1`)) as { rows: any[] }
        if (found.rows[0] && mode === 'insert') throw new Error(`already exists (leaseNumber=${leaseNumber})`)
        const current = found.rows[0]
        const values = { orgId: ctx.orgId, actorId: ctx.actorId, propertyId, unitId, tenantId, leaseNumber, startsOn: String(src.startsOn), endsOn: src.endsOn ? String(src.endsOn) : null, baseRent: String(src.baseRent), billingDay: Number(src.billingDay ?? current?.billing_day ?? 1), paymentTermsDays: Number(src.paymentTermsDays ?? current?.payment_terms_days ?? 0), securityDepositRequired: String(src.securityDepositRequired ?? current?.security_deposit_required ?? '0'), camMethod: String(src.camMethod ?? current?.cam_method ?? 'none') as 'none' | 'fixed' | 'pro_rata', camSharePercent: src.camSharePercent == null || src.camSharePercent === '' ? current?.cam_share_percent ?? null : String(src.camSharePercent), lateFeeType: String(src.lateFeeType ?? current?.late_fee_type ?? 'none') as 'none' | 'fixed' | 'percent', lateFeeValue: String(src.lateFeeValue ?? current?.late_fee_value ?? '0'), graceDays: Number(src.graceDays ?? current?.grace_days ?? 0), autoInvoice: src.autoInvoice == null || src.autoInvoice === '' ? current?.auto_invoice ?? true : coerceBoolean(src.autoInvoice), autoPost: src.autoPost == null || src.autoPost === '' ? current?.auto_post ?? false : coerceBoolean(src.autoPost) }
        if (!ctx.dryRun) {
          if (current) await updatePropertyLease({ ...values, leaseId: current.id })
          else {
            const created = await createPropertyLease(values)
            if (String(src.status ?? 'draft') === 'active') await activatePropertyLease(ctx.orgId, ctx.actorId, created.id)
          }
        }
        current ? outcome.updated++ : outcome.created++
      } catch (error) { outcome.failed++; outcome.errors.push({ row: index + 1, message: error instanceof Error ? error.message : 'write failed' }) }
      return outcome
    },
  }
}

function leaseChargeFields(inventoryOn = true): ResourceField[] {
  const fields: ResourceField[] = [
    { key: 'leaseNumber', label: 'Lease number', kind: 'reference', required: true },
    { key: 'chargeType', label: 'Charge type', kind: 'select', required: true, options: ['cam', 'parking', 'storage', 'utility', 'other'].map((value) => ({ value, label: value })) },
    { key: 'description', label: 'Description', kind: 'text', required: true },
    { key: 'amount', label: 'Amount', kind: 'currency', required: true },
    { key: 'frequency', label: 'Frequency', kind: 'select', required: true, options: ['monthly', 'quarterly', 'annually', 'one_time'].map((value) => ({ value, label: value })) },
    { key: 'effectiveFrom', label: 'Effective from', kind: 'date', required: true },
    { key: 'effectiveTo', label: 'Effective to', kind: 'date' },
    { key: 'incomeAccount', label: 'Income account', kind: 'reference', ref: { resource: 'accounts', by: 'number' } },
    { key: 'item', label: 'Item code', kind: 'reference' },
    { key: 'taxCode', label: 'Tax code', kind: 'reference', ref: { resource: 'tax-codes', by: 'code' } },
  ]
  return inventoryOn ? fields : fields.filter((field) => field.key !== 'item')
}

function leaseChargeResource(orgId: string): DataResource {
  return {
    descriptor: PROPERTY_DESCRIPTOR_BY_KEY.get('lease-charges')!,
    async fields() { return leaseChargeFields(await orgFeatureEnabled(orgId, 'inventory')) },
    async columns() {
      return (await leaseChargeFields(await orgFeatureEnabled(orgId, 'inventory'))).map((f) => ({ key: f.key, label: f.label }))
    },
    async read() {
      const fields = await leaseChargeFields(await orgFeatureEnabled(orgId, 'inventory'))
      const result = (await db.execute(sql`select l.lease_number as "leaseNumber",c.charge_type as "chargeType",c.description,c.amount,c.frequency,c.effective_from as "effectiveFrom",c.effective_to as "effectiveTo",a.number as "incomeAccount",i.code as item,t.code as "taxCode" from lease_charges c join property_leases l on l.id=c.lease_id and l.org_id=c.org_id left join accounts a on a.id=c.income_account_id and a.org_id=c.org_id left join items i on i.id=c.item_id and i.org_id=c.org_id left join tax_codes t on t.id=c.tax_code_id and t.org_id=c.org_id where c.org_id=${orgId} and c.charge_type<>'base_rent' order by l.lease_number,c.effective_from,c.description limit ${MAX_EXPORT_ROWS}`)) as { rows: Record<string, CellValue>[] }
      return { fields, columns: fields.map((f) => ({ key: f.key, label: f.label })), rows: result.rows }
    },
    async write(rows, mode, ctx) {
      const outcome: WriteOutcome = { created: 0, updated: 0, failed: 0, errors: [] }
      const resolver = new RefResolver(ctx.orgId)
      const inventoryOn = await orgFeatureEnabled(ctx.orgId, 'inventory')
      for (let index = 0; index < rows.length; index++) try {
        const src = rows[index]
        const leaseNumber = String(src.leaseNumber ?? '').trim()
        const chargeType = String(src.chargeType ?? '').trim()
        const description = String(src.description ?? '').trim()
        const effectiveFrom = String(src.effectiveFrom ?? '').trim()
        const frequency = String(src.frequency ?? '').trim()
        if (!leaseNumber || !chargeType || !description || !effectiveFrom || !src.amount || !frequency) throw new Error('leaseNumber, chargeType, description, amount, frequency, and effectiveFrom are required')
        if (!['cam', 'parking', 'storage', 'utility', 'other'].includes(chargeType)) throw new Error('base rent belongs on the property lease import; select another chargeType')
        if (!['monthly', 'quarterly', 'annually', 'one_time'].includes(frequency)) throw new Error(`invalid frequency "${frequency}"`)
        if (Number(src.amount) <= 0 || !Number.isFinite(Number(src.amount))) throw new Error('amount must be positive')
        if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom) || (src.effectiveTo && String(src.effectiveTo) < effectiveFrom)) throw new Error('effective dates must form a valid YYYY-MM-DD range')
        const lease = (await db.execute(sql`select id,status from property_leases where org_id=${ctx.orgId} and lease_number=${leaseNumber} limit 1`)) as { rows: { id: string; status: string }[] }
        if (!lease.rows[0]) throw new Error(`lease "${leaseNumber}" not found`)
        const existing = (await db.execute(sql`select c.*,a.number as account_number,i.code as item_code,t.code as tax_code from lease_charges c left join accounts a on a.id=c.income_account_id and a.org_id=c.org_id left join items i on i.id=c.item_id and i.org_id=c.org_id left join tax_codes t on t.id=c.tax_code_id and t.org_id=c.org_id where c.org_id=${ctx.orgId} and c.lease_id=${lease.rows[0].id} and c.charge_type=${chargeType} and c.effective_from=${effectiveFrom} and c.description=${description} limit 1`)) as { rows: any[] }
        if (existing.rows[0]) {
          if (mode === 'insert') throw new Error('charge already exists')
          const itemOmitted = src.item === undefined || src.item === null || src.item === ''
          const itemSame = itemOmitted || String(existing.rows[0].item_code ?? '') === String(src.item)
          const same = normalizeMoney(existing.rows[0].amount) === normalizeMoney(String(src.amount)) && existing.rows[0].frequency === frequency && String(existing.rows[0].effective_to ?? '') === String(src.effectiveTo ?? '') && String(existing.rows[0].account_number ?? '') === String(src.incomeAccount ?? '') && itemSame && String(existing.rows[0].tax_code ?? '') === String(src.taxCode ?? '')
          if (!same) throw new Error('an existing charge with this key differs; edit it from the lease so scheduled billing evidence is preserved')
          outcome.updated++
          continue
        }
        const incomeAccountId = src.incomeAccount ? await resolver.resolveId({ resource: 'accounts', by: 'number' }, src.incomeAccount) : null
        const itemId = src.item ? await naturalId(ctx.orgId, 'items', 'code', src.item) : null
        const taxCodeId = src.taxCode ? await resolver.resolveId({ resource: 'tax-codes', by: 'code' }, src.taxCode) : null
        if ((src.incomeAccount && !incomeAccountId) || (src.item && !itemId) || (src.taxCode && !taxCodeId)) throw new Error('incomeAccount, item, or taxCode was not found')
        if (itemId && !inventoryOn) {
          const item = (await db.execute(sql`select kind from items where id = ${itemId} and org_id = ${ctx.orgId}`)) as { rows: { kind: string }[] }
          if (item.rows[0] && INVENTORY_ITEM_KINDS.has(item.rows[0].kind)) throw new Error('item is not available')
        }
        if (!ctx.dryRun) {
          await addLeaseCharge({ orgId: ctx.orgId, actorId: ctx.actorId, leaseId: lease.rows[0].id, chargeType, description, amount: String(src.amount), frequency, effectiveFrom, effectiveTo: src.effectiveTo ? String(src.effectiveTo) : null, incomeAccountId, itemId, taxCodeId })
          if (['active', 'notice'].includes(lease.rows[0].status)) await scheduleLeaseCharges(ctx.orgId, ctx.actorId, lease.rows[0].id)
        }
        outcome.created++
      } catch (error) { outcome.failed++; outcome.errors.push({ row: index + 1, message: error instanceof Error ? error.message : 'write failed' }) }
      return outcome
    },
  }
}

function depositOpeningResource(orgId: string): DataResource {
  const fields: ResourceField[] = [
    { key: 'externalKey', label: 'External key', kind: 'text', required: true },
    { key: 'leaseNumber', label: 'Lease number', kind: 'reference', required: true },
    { key: 'occurredOn', label: 'Opening balance date', kind: 'date', required: true },
    { key: 'amount', label: 'Amount', kind: 'currency', required: true },
    { key: 'offsetAccount', label: 'Migration clearing account', kind: 'reference', required: true, ref: { resource: 'accounts', by: 'number' } },
    { key: 'memo', label: 'Memo', kind: 'text' },
  ]
  return {
    descriptor: PROPERTY_DESCRIPTOR_BY_KEY.get('security-deposit-opening-balances')!,
    async fields() { return fields }, async columns() { return fields.map((f) => ({ key: f.key, label: f.label })) },
    async read() {
      const result = (await db.execute(sql`select d.import_key as "externalKey",l.lease_number as "leaseNumber",d.occurred_on as "occurredOn",d.amount,a.number as "offsetAccount",d.memo from security_deposit_transactions d join property_leases l on l.id=d.lease_id and l.org_id=d.org_id left join accounts a on a.id=d.offset_account_id and a.org_id=d.org_id where d.org_id=${orgId} and d.import_key is not null order by d.occurred_on,d.import_key limit ${MAX_EXPORT_ROWS}`)) as { rows: Record<string, CellValue>[] }
      return { fields, columns: fields.map((f) => ({ key: f.key, label: f.label })), rows: result.rows }
    },
    async write(rows, mode, ctx) {
      const outcome: WriteOutcome = { created: 0, updated: 0, failed: 0, errors: [] }
      const resolver = new RefResolver(ctx.orgId)
      for (let index = 0; index < rows.length; index++) try {
        const src = rows[index]
        const externalKey = String(src.externalKey ?? '').trim()
        const leaseNumber = String(src.leaseNumber ?? '').trim()
        if (!externalKey || !leaseNumber || !src.occurredOn || !src.amount || !src.offsetAccount) throw new Error('externalKey, leaseNumber, occurredOn, amount, and offsetAccount are required')
        const existing = (await db.execute(sql`select id from security_deposit_transactions where org_id=${ctx.orgId} and import_key=${externalKey} limit 1`)) as { rows: { id: string }[] }
        if (existing.rows[0]) {
          if (mode === 'insert') throw new Error(`already exists (externalKey=${externalKey})`)
          outcome.updated++
          continue
        }
        const lease = (await db.execute(sql`select id from property_leases where org_id=${ctx.orgId} and lease_number=${leaseNumber} limit 1`)) as { rows: { id: string }[] }
        const offsetAccountId = await resolver.resolveId({ resource: 'accounts', by: 'number' }, src.offsetAccount)
        if (!lease.rows[0] || !offsetAccountId) throw new Error('leaseNumber or offsetAccount was not found')
        if (!ctx.dryRun) await recordSecurityDeposit({ orgId: ctx.orgId, actorId: ctx.actorId, leaseId: lease.rows[0].id, kind: 'adjustment_increase', occurredOn: String(src.occurredOn), amount: String(src.amount), offsetAccountId, memo: src.memo ? String(src.memo) : 'Imported security deposit opening balance', importKey: externalKey })
        outcome.created++
      } catch (error) { outcome.failed++; outcome.errors.push({ row: index + 1, message: error instanceof Error ? error.message : 'write failed' }) }
      return outcome
    },
  }
}

export function propertyDataResource(orgId: string, key: string): DataResource | null {
  if (key === 'properties') return propertyResource(orgId)
  if (key === 'property-units') return unitResource(orgId)
  if (key === 'property-leases') return leaseResource(orgId)
  if (key === 'lease-charges') return leaseChargeResource(orgId)
  if (key === 'security-deposit-opening-balances') return depositOpeningResource(orgId)
  return null
}
