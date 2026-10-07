import 'server-only'
import { sql } from 'drizzle-orm'
import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { Alert } from '@openbooks/ui'
import { db, withOrgTransaction } from '@openbooks/engine/platform/database'
import { BenefitsError, getBenefitProgram, getBenefitTransactionPolicy, getBenefitTransactionReferences } from '@openbooks/engine/hrm/benefits'
import { can, type Authz } from '../../../../lib/authz'
import { loadRefOptions } from '../../../../lib/setup/ref-options'
import { BENEFIT_TRANSACTION_POLICY_ENTITY } from '../../../../lib/setup/benefit-transaction-policy'
import { SetupDrawer } from '../../admin/setup/[entity]/SetupDrawer'

/** Reuse the shared structured record editor, with one selected policy concept. */
export async function TransactionRulesDrawer({ authz, programId }: { authz: Authz; programId: string }) {
  const orgId = authz.user.orgId
  const t = await getTranslations('admin.setup')
  return withOrgTransaction(orgId, async () => {
    try {
      const program = await getBenefitProgram(db, orgId, authz.user.id, programId)
      if (program.metric !== 'transactions') notFound()
      const record = await getBenefitTransactionPolicy({ orgId, actorId: authz.user.id, programId })
      const policy = record?.policy ?? { documentKind: 'sales_order', dateBasis: 'document_date', groupingSegmentId: null, itemIds: [], positions: [], responsibilities: [], limits: [] }
      const entity = { ...BENEFIT_TRANSACTION_POLICY_ENTITY, readOnly: !can(authz, 'hrm.benefits.manage') || program.status !== 'draft' }
      const options = await loadRefOptions(entity, orgId, authz.allowedSubsidiaryIds)
      const references = await getBenefitTransactionReferences({ orgId, actorId: authz.user.id, programId })
      options['segment-definitions'] = references.segments
      options['benefit-transaction-groups'] = references.groups
      // Responsibilities are confined to the program's responsible legal employer.
      const employed = (await db.execute<{ id: string }>(sql`select id from worker_employments where org_id=${orgId} and employer_subsidiary_id=${program.legalEntityId}`)).rows
      const employmentIds = new Set(employed.map(row => row.id))
      options['worker-employments'] = (options['worker-employments'] ?? []).filter(option => employmentIds.has(option.value))
      const row = { id: program.id, revision: record?.programRevision ?? program.revision, document_kind: policy.documentKind, date_basis: policy.dateBasis, grouping_segment_id: policy.groupingSegmentId, positions: policy.positions, responsibilities: policy.responsibilities, limits: policy.limits, reason: '' }
      return <SetupDrawer entity={entity} row={row} members={[...policy.itemIds]} refOptions={options}
        recordTitle={`${program.name} · ${t('transactionBenefits.title')}`} closeHref={`/hrm/benefits?view=programs&program=${program.id}`} />
    } catch (error) {
      if (!(error instanceof BenefitsError)) throw error
      if (error.code === 'NOT_FOUND') notFound()
      return <Alert variant="destructive">{error.message}</Alert>
    }
  })
}
