import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { BUILTIN_PROJECT_TYPES, type FinancialProfile, type InvoicingProfile, type BackupProfile } from '@openbooks/schema'

/**
 * The single resolver for a project's classification. A project is classified by
 * its `project_type_id` (→ project_types) and nothing else; an unconfigured
 * project defaults to the built-in Time & Materials type. This is the ONE place
 * that default lives — callers read the resolved type's profiles/key, never a
 * coarse billing-method string re-derived inline.
 */
export interface ResolvedProjectType {
  id: string | null
  key: string
  name: string
  /** Coarse classifier carried by the type (for snapshots/labels), derived here. */
  billingMethod: 'time_and_materials' | 'fixed_price' | 'cost_plus'
  financialProfile: FinancialProfile
  financialProfileEffectiveFrom: string | null
  invoicingProfile: InvoicingProfile
  backupProfile: BackupProfile
}

const byKey = new Map(BUILTIN_PROJECT_TYPES.map((t) => [t.key, t]))

/** The coarse billing method a project type maps to (from its built-in definition). */
export function coarseBillingMethod(key: string | null | undefined): ResolvedProjectType['billingMethod'] {
  return (key && byKey.get(key)?.billingMethod) || 'time_and_materials'
}

function timeAndMaterials(): ResolvedProjectType {
  const t = byKey.get('time_and_materials')!
  return { id: null, key: t.key, name: t.name, billingMethod: t.billingMethod, financialProfile: t.financialProfile, financialProfileEffectiveFrom: null, invoicingProfile: t.invoicingProfile, backupProfile: t.backupProfile }
}

export async function loadProjectType(
  orgId: string,
  projectId: string,
  asOf = new Date().toISOString().slice(0, 10),
): Promise<ResolvedProjectType> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) {
    throw new Error('project type asOf must be YYYY-MM-DD')
  }
  const r = (await db.execute(sql`
    select pt.id, pt.key, pt.name, pt.billing_method as bm,
           version.financial_profile as fp,
           version.effective_from::text as fp_effective_from,
           pt.invoicing_profile as ip, pt.backup_profile as bp
      from projects p
      left join project_types pt on pt.id = p.project_type_id and pt.org_id = p.org_id
      left join lateral (
        select v.financial_profile, v.effective_from
          from project_financial_profile_versions v
         where v.org_id = p.org_id
           and v.project_type_id = pt.id
           and v.effective_from <= ${asOf}
           and (v.effective_to is null or v.effective_to >= ${asOf})
         order by v.effective_from desc
         limit 1
      ) version on true
     where p.id = ${projectId} and p.org_id = ${orgId}
  `)) as unknown as { rows: { id: string | null; key: string | null; name: string | null; bm: ResolvedProjectType['billingMethod'] | null; fp: FinancialProfile | null; fp_effective_from: string | null; ip: InvoicingProfile | null; bp: BackupProfile | null }[] }
  const row = r.rows[0]
  if (row?.id && row.fp && row.ip && row.bp) {
    if (!row.bm) throw new Error(`project type ${row.id} is missing its billing classification`)
    return { id: row.id, key: row.key!, name: row.name!, billingMethod: row.bm, financialProfile: row.fp, financialProfileEffectiveFrom: row.fp_effective_from, invoicingProfile: row.ip, backupProfile: row.bp }
  }
  return timeAndMaterials()
}
