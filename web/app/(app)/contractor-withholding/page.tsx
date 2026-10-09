import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/platform/database'
import { requirePermission, can } from '@/lib/authz'
import { requireFeatureEnabled } from '@/lib/feature-gates'
import { withholdingEnrollments } from '@/lib/contractor-withholding'
import { WithholdingWorkspace } from './WithholdingWorkspace'
export const dynamic = 'force-dynamic'
export async function generateMetadata() { const t = await getTranslations('ap.withholding'); return { title: t('title') } }
export default async function ContractorWithholdingPage() {
  const authz = await requirePermission('ap.read')
  await requireFeatureEnabled(authz.user.orgId, 'contractorWithholding')
  const canSetup = can(authz, 'admin.setup.manage')
  const canStandings = canSetup && authz.allowedSubsidiaryIds === null
  const standings = canStandings ? (await db.execute<{ id: string; entityName: string | null; partyName: string; schemeCode: string; bandCode: string; status: string; validFrom: string; validTo: string | null }>(sql`
    select w.id, s.name as "entityName", p.display_name as "partyName", w.scheme_code as "schemeCode", w.band_code as "bandCode", w.status,
           w.valid_from::text as "validFrom", w.valid_to::text as "validTo"
      from withholding_standings w join parties p on p.org_id=w.org_id and p.id=w.party_id
      left join subsidiaries s on s.org_id=w.org_id and s.id=w.subsidiary_id
     where w.org_id=${authz.user.orgId} order by p.display_name, w.scheme_code, w.valid_from desc`)).rows : []
  return <WithholdingWorkspace enrollments={await withholdingEnrollments(authz)} canManage={can(authz, 'ap.pay')} canSetup={canSetup} canStandings={canStandings} standings={standings} />
}
