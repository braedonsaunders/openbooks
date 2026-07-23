import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { BUILTIN_PROJECT_TYPES, type FinancialProfile, type InvoicingProfile, type BackupProfile } from '@openbooks/schema'

export interface ResolvedProjectType {
  id: string | null
  key: string
  name: string
  financialProfile: FinancialProfile
  invoicingProfile: InvoicingProfile
  backupProfile: BackupProfile
}

/** Legacy JSON profiles predate the explicit procedure discriminator. Treat
 * absence as standard without rewriting historical configuration in place. */
function normalizedInvoicingProfile(profile: InvoicingProfile): InvoicingProfile {
  return { ...profile, billingProcedure: profile.billingProcedure ?? 'standard' }
}

const DEFAULTS = BUILTIN_PROJECT_TYPES
const byKey = new Map(DEFAULTS.map((t) => [t.key, t]))
const byMethod = new Map(DEFAULTS.map((t) => [t.billingMethod, t]))

function fallback(billingMethod: string | null): ResolvedProjectType {
  const t = (billingMethod && byMethod.get(billingMethod as any)) || byKey.get('time_and_materials')!
  return { id: null, key: t.key, name: t.name, financialProfile: t.financialProfile, invoicingProfile: normalizedInvoicingProfile(t.invoicingProfile), backupProfile: t.backupProfile }
}

/** Resolve the profiles governing a project: its assigned type, else the
 *  built-in matching its billing_method, else Time & Materials. */
export async function loadProjectType(orgId: string, projectId: string): Promise<ResolvedProjectType> {
  const r = (await db.execute(sql`
    select p.billing_method,
           pt.id, pt.key, pt.name, pt.financial_profile as fp, pt.invoicing_profile as ip, pt.backup_profile as bp
      from projects p
      left join project_types pt on pt.id = p.project_type_id and pt.org_id = p.org_id
     where p.id = ${projectId} and p.org_id = ${orgId}
  `)) as unknown as { rows: { billing_method: string | null; id: string | null; key: string | null; name: string | null; fp: FinancialProfile | null; ip: InvoicingProfile | null; bp: BackupProfile | null }[] }
  const row = r.rows[0]
  if (!row) return fallback(null)
  if (row.id && row.fp && row.ip && row.bp) {
    return { id: row.id, key: row.key!, name: row.name!, financialProfile: row.fp, invoicingProfile: normalizedInvoicingProfile(row.ip), backupProfile: row.bp }
  }
  return fallback(row.billing_method)
}
