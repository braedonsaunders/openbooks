import 'server-only'
import { NextResponse } from 'next/server'
import {
  RECORD_TYPE_BY_KEY,
  RECORD_TYPES,
  recordTypeFeatureKey,
} from '@openbooks/customization'
import { featureEnabled, isFeatureEnabled, orgFeatureState } from '../features'

/** False when this record type belongs to a Features switch that is off. */
export async function isRecordTypeEnabled(orgId: string, recordType: string): Promise<boolean> {
  const feature = recordTypeFeatureKey(recordType)
  if (!feature) return true
  return isFeatureEnabled(orgId, feature)
}

/** Optional-module record types whose Features switch is off. Historical rows stay. */
export async function disabledRecordTypes(orgId: string): Promise<string[]> {
  const state = await orgFeatureState(orgId)
  return RECORD_TYPES.flatMap((rt) =>
    rt.featureKey && !featureEnabled(state, rt.featureKey) ? [rt.key] : [],
  )
}

/**
 * Features switch for a custom-field target. Kind wins (documents:expense_report
 * follows Expenses). A table with no kind is gated only when every catalog type
 * on that table shares one feature — so `items` and `parties` stay core.
 * `crm_account_profiles` is CRM-only and is not a RECORD_TYPES customFieldTable.
 */
export function customFieldTargetFeatureKey(table: string, kind?: string | null): string | null {
  if (kind) return recordTypeFeatureKey(kind)
  const keys = new Set(
    RECORD_TYPES
      .filter((rt) => (rt.customFieldTable ?? 'documents') === table)
      .map((rt) => rt.featureKey ?? null),
  )
  if (keys.size === 1) {
    const [only] = keys
    return only
  }
  if (table === 'crm_account_profiles') return 'crm'
  return null
}

export async function isCustomFieldTargetEnabled(
  orgId: string,
  table: string,
  kind?: string | null,
): Promise<boolean> {
  const feature = customFieldTargetFeatureKey(table, kind)
  if (!feature) return true
  return isFeatureEnabled(orgId, feature)
}

const OPTIONAL_CUSTOM_FIELD_TABLES = [
  'projects',
  'managed_properties',
  'item_rate_versions',
  'crm_account_profiles',
  'crm_activities',
  'crm_opportunities',
] as const

/** Tables / kinds whose Features switch is off. Historical defs stay. */
export async function disabledCustomFieldTargets(orgId: string): Promise<{ kinds: string[]; tables: string[] }> {
  const state = await orgFeatureState(orgId)
  return {
    kinds: RECORD_TYPES.flatMap((rt) =>
      rt.featureKey && !featureEnabled(state, rt.featureKey) ? [rt.key] : [],
    ),
    tables: OPTIONAL_CUSTOM_FIELD_TABLES.filter((table) => {
      const key = customFieldTargetFeatureKey(table)
      return Boolean(key && !featureEnabled(state, key))
    }),
  }
}

/** 404 when the kind belongs to a Features switch that is off. */
export async function refuseDisabledRecordType(
  orgId: string,
  recordType: string,
): Promise<NextResponse | null> {
  if (!RECORD_TYPE_BY_KEY[recordType]) return null
  if (!(await isRecordTypeEnabled(orgId, recordType))) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }
  return null
}
