import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import type { InvoicingPreference } from '@openbooks/schema'
import { loadProjectType } from './project-type'

/** The fully-resolved invoicing/backup settings for a project after applying
 *  the project type default ← customer override ← project override cascade. */
export interface EffectiveInvoicing {
  allowedBases: string[]
  defaultBasis: string
  lineBuilder: string
  revenueAccount: string
  recognition: string
  backupRequired: boolean
  backupType: string
  allowedBackupTypes: string[]
  invoiceTemplateId: string | null
  /** Where each effective value came from — for the UI "inherited from …" hint. */
  source: { basis: Layer; backupRequired: Layer; backupType: Layer; template: Layer }
}
type Layer = 'type' | 'customer' | 'project'

const pref = (col: unknown): InvoicingPreference => (col as InvoicingPreference) ?? {}

/**
 * Resolve effective invoicing preferences for a project. The type supplies the
 * structural defaults (bases, line builder, revenue account, recognition, backup
 * defaults); the customer then the project override the overridable subset
 * (default basis, backup required/type, invoice template) — project wins.
 */
export async function resolveInvoicingPreference(orgId: string, projectId: string): Promise<EffectiveInvoicing> {
  const type = await loadProjectType(orgId, projectId)
  const row = (await db.execute(sql`
    select p.invoicing_preference as project_pref, cust.invoicing_preference as customer_pref
      from projects p left join parties cust on cust.id = p.customer_id
     where p.id = ${projectId} and p.org_id = ${orgId}
  `)) as unknown as { rows: { project_pref: unknown; customer_pref: unknown }[] }
  const custPref = pref(row.rows[0]?.customer_pref)
  const projPref = pref(row.rows[0]?.project_pref)

  // pick(field): project override ← customer override ← type default, tracking source.
  function pick<T>(typeVal: T, cKey: keyof InvoicingPreference, pKey: keyof InvoicingPreference): [T, Layer] {
    if (projPref[pKey] != null) return [projPref[pKey] as T, 'project']
    if (custPref[cKey] != null) return [custPref[cKey] as T, 'customer']
    return [typeVal, 'type']
  }

  const [defaultBasis, basisSrc] = pick(type.invoicingProfile.defaultBasis, 'defaultBasis', 'defaultBasis')
  const [backupRequired, brSrc] = pick(type.backupProfile.required, 'backupRequired', 'backupRequired')
  const [backupType, btSrc] = pick(type.backupProfile.defaultBackupType, 'backupType', 'backupType')
  const [invoiceTemplateId, tmplSrc] = pick<string | null>(null, 'invoiceTemplateId', 'invoiceTemplateId')

  return {
    allowedBases: type.invoicingProfile.allowedBases,
    defaultBasis,
    lineBuilder: type.invoicingProfile.lineBuilder,
    revenueAccount: type.invoicingProfile.revenueAccount,
    recognition: type.invoicingProfile.recognition,
    backupRequired,
    backupType,
    allowedBackupTypes: type.backupProfile.allowedBackupTypes,
    invoiceTemplateId,
    source: { basis: basisSrc, backupRequired: brSrc, backupType: btSrc, template: tmplSrc },
  }
}
