import { getTranslations } from 'next-intl/server'
import { getTrainingParticipant, TrainingError } from '@openbooks/engine/hrm/training'
import { ScopeNotFoundError } from '@openbooks/engine/organization/scope'
import { notFound } from 'next/navigation'
import { isUuid, mergeHref } from '@/lib/list-params'
import { can } from '@/lib/authz'
import { ModuleView } from '@/components/viewspec/module-view'
import { loadMeTraining, meTrainingSpec } from './view'
import { OwnTrainingDrawer } from './OwnTrainingDrawer'
export const dynamic = 'force-dynamic'
export async function generateMetadata() {
  return { title: (await getTranslations('hrm.me.training'))('title') }
}
export default async function MeTrainingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const sp = await searchParams,
    workspace = await loadMeTraining(sp)
  let data = workspace.data,
    record: Awaited<ReturnType<typeof getTrainingParticipant>> | null = null
  if (sp.training && !isUuid(sp.training)) notFound()
  if (sp.training && !data.refusal) {
    try {
      record = await getTrainingParticipant({
        orgId: workspace.authz.user.orgId,
        actorId: workspace.authz.user.id,
        participantId: sp.training,
        audience: 'self',
      })
    } catch (error) {
      if (error instanceof ScopeNotFoundError) notFound()
      if (!(error instanceof TrainingError)) throw error
      data = { ...data, refusal: error.message, hasContent: false }
    }
  }
  const closeHref = mergeHref('/me/training', sp, { training: undefined })
  return (
    <>
      <ModuleView spec={meTrainingSpec(data)} data={data} searchParams={sp} trusted />
      {record ? (
        <OwnTrainingDrawer
          detail={record}
          canRespond={can(workspace.authz, 'hrm.self.request')}
          closeHref={closeHref}
        />
      ) : null}
    </>
  )
}
