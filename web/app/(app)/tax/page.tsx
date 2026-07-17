import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { PageContainer } from '../../../components/page-layout'
import { getAuthz, can } from '../../../lib/authz'
import { resolveOrgId } from '../../../lib/org-scope'
import { TaxFilingsView } from './TaxFilingsView'

export const dynamic = 'force-dynamic'

export default async function TaxPage() {
  const orgId = await resolveOrgId()
  const authz = await getAuthz()
  const canManage = !!authz && (can(authz, 'admin.users.manage') || can(authz, '*'))

  const r = (await db.execute(sql`
    select code, name, submission_channel, official_pdf_file_id is not null as has_official
      from tax_return_forms
     where org_id = ${orgId} and is_active
     order by name`)) as unknown as {
    rows: { code: string; name: string; submission_channel: string; has_official: boolean }[]
  }

  return (
    <PageContainer>
      <TaxFilingsView forms={r.rows} canManage={canManage} />
    </PageContainer>
  )
}
