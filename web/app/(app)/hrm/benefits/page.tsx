import { ModuleView } from '../../../../components/viewspec/module-view'
import { SetupEntitySection } from '../../admin/setup/[entity]/SetupEntitySection'
import { SETUP_ENTITY_BY_KEY } from '../../../../lib/setup/registry'
import { benefitsSpec, benefitsTitle, loadBenefitsPage } from './view'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  return { title: await benefitsTitle() }
}

/**
 * The Benefits tab. The default overview is the portfolio cockpit above the
 * enrollment-windows table; focused views narrow to programs, windows,
 * enrolments, rewards, incentives, or payouts. The insured-plan Setup
 * section rehomes onto the programs view, where the health and retirement
 * cards land — the same generic CRUD surface as the setup workspace, only
 * the base path changes, so the plan drawers stay local to this page.
 * Renders only when the hrm feature gate is on and the actor holds
 * hrm.benefits.read — the view 404s otherwise.
 */
export default async function BenefitsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const sp = await searchParams
  const data = await loadBenefitsPage(sp)
  const planEntity = data.planSection ? SETUP_ENTITY_BY_KEY.get('benefit-plans') : undefined
  return (
    <>
      <ModuleView spec={benefitsSpec(data, '/hrm/benefits')} data={data} searchParams={sp} trusted />
      {data.planSection && planEntity ? (
        <SetupEntitySection
          entity={planEntity}
          orgId={data.planSection.orgId}
          actorId={data.planSection.actorId}
          searchParams={sp}
          basePath="/hrm/benefits"
          canManage={data.planSection.canManage}
          allowedSubsidiaryIds={
            data.planSection.allowedSubsidiaryIds ? new Set(data.planSection.allowedSubsidiaryIds) : null
          }
          hideHeader
          rowParam="plan"
        />
      ) : null}
    </>
  )
}
