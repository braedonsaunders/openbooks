import 'server-only'
import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { Alert, PageHeader } from '@openbooks/ui'
import {
  TrainingError,
  listTrainingCourses,
  getTrainingCourse,
  getTrainingSession,
  getTrainingParticipant,
} from '@openbooks/engine/hrm/training'
import { requirePermission, can } from '@/lib/authz'
import { requireFeatureEnabled } from '@/lib/feature-gates'
import { isUuid } from '@/lib/list-params'
import { ListPageLayout } from '@/components/page-layout'
import { AuditTrailPanel } from '@/components/audit-trail-panel'
import {
  TRAINING_COURSES_ENTITY,
  TRAINING_SESSIONS_ENTITY,
  TRAINING_PARTICIPANTS_ENTITY,
} from '@/lib/setup/hrm-training'
import { SetupEntitySection } from '@/app/(app)/admin/setup/[entity]/SetupEntitySection'
import { NewSetupButton } from '@/app/(app)/admin/setup/[entity]/SetupDrawer'
import { TrainingActions } from './TrainingActions'

export const dynamic = 'force-dynamic'
export async function generateMetadata() {
  return { title: (await getTranslations('admin.setup.training'))('title') }
}

/** CompensationPackagesSection is the exemplar: one course record owns sessions, outcomes and evidence. */
export default async function TrainingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const sp = await searchParams,
    authz = await requirePermission('hrm.certifications.read'),
    t = await getTranslations('admin.setup.training')
  await requireFeatureEnabled(authz.user.orgId, 'hrm')
  await requireFeatureEnabled(authz.user.orgId, 'hrmCertifications')
  const manage = can(authz, 'hrm.certifications.manage'),
    actor = { orgId: authz.user.orgId, actorId: authz.user.id }
  const shared = {
    ...actor,
    searchParams: sp,
    basePath: '/hrm/training',
    canManage: true,
    allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
  }
  const header = (
    <PageHeader
      title={t('title')}
      description={t('description')}
      actions={
        manage ? (
          <NewSetupButton
            entityKey="training-courses"
            label={t('newCourse')}
            basePath="/hrm/training"
            rowParam="course"
          />
        ) : undefined
      }
    />
  )
  const { courses, selected, delivery, result, refusal } = await loadTrainingWorkspace(actor, sp)
  if (refusal)
    return (
      <ListPageLayout header={<PageHeader title={t('title')} description={t('description')} />}>
        <Alert variant="destructive">{refusal}</Alert>
      </ListPageLayout>
    )
  const tabs = []
  if (selected) {
    const course = selected.course
    const sessionTabs = delivery
      ? [
          {
            key: 'review',
            label: t('review'),
            content: (
              <TrainingActions
                key={`session:${delivery.session.id}:${delivery.session.revision}`}
                course={course}
                session={delivery.session}
                canManage={manage}
              />
            ),
          },
          {
            key: 'participants',
            label: t('participants'),
            content: (
              <SetupEntitySection
                {...shared}
                entity={{
                  ...TRAINING_PARTICIPANTS_ENTITY,
                  recordChildren: [],
                  recordLinks: result?.participant.qualificationId
                    ? [
                        {
                          href: `/hrm/qualifications?qualification=${result.participant.qualificationId}`,
                          label: t('qualificationType'),
                        },
                      ]
                    : [],
                  readOnly: !manage,
                  allowCreate: manage && delivery.session.status === 'scheduled',
                  mutationPath: `/api/hrm/training/sessions/${delivery.session.id}/participants`,
                  fields: TRAINING_PARTICIPANTS_ENTITY.fields.map((field) =>
                    field.key === 'subsidiaryId' ? { ...field, defaultValue: delivery.session.subsidiaryId } : field,
                  ),
                }}
                rowParam="childChildRow"
                paramPrefix="childChild"
                parent={{ recordKey: 'training-sessions', value: delivery.session.id }}
                stacked
                visibleRowIds={new Set(delivery.participants.map((row) => row.id))}
                additionalRecordTabs={
                  result
                    ? [
                        {
                          key: 'review',
                          label: t('review'),
                          content: (
                            <TrainingActions
                              key={`participant:${result.participant.id}:${result.participant.revision}:${result.feedback.length}`}
                              course={course}
                              session={delivery.session}
                              participant={result.participant}
                              feedback={result.feedback}
                              canManage={manage}
                            />
                          ),
                        },
                        {
                          key: 'history',
                          label: t('history'),
                          content: (
                            <AuditTrailPanel table="hrm_training_participants" recordId={result.participant.id} />
                          ),
                        },
                      ]
                    : []
                }
              />
            ),
          },
          {
            key: 'history',
            label: t('history'),
            content: <AuditTrailPanel table="hrm_training_sessions" recordId={delivery.session.id} />,
          },
        ]
      : []
    tabs.push({
      key: 'review',
      label: t('review'),
      content: <TrainingActions key={`course:${course.id}:${course.revision}`} course={course} canManage={manage} />,
    })
    tabs.push({
      key: 'sessions',
      label: t('sessions'),
      content: (
        <SetupEntitySection
          {...shared}
          entity={{
            ...TRAINING_SESSIONS_ENTITY,
            recordChildren: [],
            readOnly: !manage,
            allowCreate: manage && course.status === 'approved',
            mutationPath: `/api/hrm/training/courses/${course.id}/sessions`,
            fields: TRAINING_SESSIONS_ENTITY.fields.map((field) =>
              field.key === 'subsidiaryId' ? { ...field, defaultValue: course.subsidiaryId } : field,
            ),
          }}
          rowParam="childRow"
          paramPrefix="child"
          parent={{ recordKey: 'training-courses', value: course.id }}
          stacked
          visibleRowIds={new Set(selected.sessions.map((row) => row.id))}
          additionalRecordTabs={sessionTabs}
        />
      ),
    })
    tabs.push({
      key: 'history',
      label: t('history'),
      content: <AuditTrailPanel table="hrm_training_courses" recordId={course.id} />,
    })
  }
  return (
    <ListPageLayout header={header} contained>
      <SetupEntitySection
        {...shared}
        entity={{ ...TRAINING_COURSES_ENTITY, recordChildren: [], readOnly: !manage }}
        rowParam="course"
        hideHeader
        contained
        visibleRowIds={new Set(courses.map((row) => row.id))}
        additionalRecordTabs={tabs}
      />
    </ListPageLayout>
  )
}

async function loadTrainingWorkspace(
  actor: { orgId: string; actorId: string },
  sp: Record<string, string | undefined>,
) {
  try {
    const courses = await listTrainingCourses(actor)
    if (sp.course && sp.course !== 'new' && (!isUuid(sp.course) || !courses.some((row) => row.id === sp.course)))
      notFound()
    if (sp.childRow && (!sp.course || sp.course === 'new')) notFound()
    if (sp.childChildRow && (!sp.childRow || sp.childRow === 'new')) notFound()
    const selected =
      sp.course && sp.course !== 'new' ? await getTrainingCourse({ ...actor, courseId: sp.course }) : null
    const sessionId = sp.childRow
    if (sessionId && sessionId !== 'new' && !selected!.sessions.some((row) => row.id === sessionId)) notFound()
    const delivery = sessionId && sessionId !== 'new' ? await getTrainingSession({ ...actor, sessionId }) : null
    const participantId = sp.childChildRow
    if (participantId && participantId !== 'new' && !delivery?.participants.some((row) => row.id === participantId))
      notFound()
    const result =
      participantId && participantId !== 'new'
        ? await getTrainingParticipant({ ...actor, participantId, audience: 'staff' })
        : null
    return { courses, selected, delivery, result, refusal: null }
  } catch (error) {
    if (!(error instanceof TrainingError)) throw error
    return { courses: [], selected: null, delivery: null, result: null, refusal: error.message }
  }
}
