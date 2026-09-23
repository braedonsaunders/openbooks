import 'server-only'

import { getTranslations } from 'next-intl/server'
import { HrmSurveysError } from '@openbooks/engine/src/hrm/documents/errors.ts'
import { listOwnInvitations } from '@openbooks/engine/src/hrm/surveys/responses.ts'
import { loadOrRefuse, type PageRefusal } from '../load-or-refuse'
import { meTabs } from './self-service'
import { getAuthz, type Authz } from '../authz'
import { requireFeatureEnabled } from '../feature-gates'

/**
 * Me open-surveys loader (0230, HR-19): the actor's unanswered
 * invitations on open surveys. Responding rides a re-minted
 * invitation token to the public /survey/[token] page — the raw
 * token is never stored anywhere, so the island reissues it
 * in-session and navigates. Renders when hrm and hrmSurveys are on
 * and the actor holds hrm.self.read — a switched-off feature redirects to
 * its remedy instead.
 */

export interface MeSurveysAuthz {
  orgId: string
  userId: string
  session: Authz
}

export async function meSurveysAuthz(): Promise<MeSurveysAuthz | null> {
  const gate = await getAuthz()
  if (!gate) return null
  await requireFeatureEnabled(gate.user.orgId, 'hrm')
  await requireFeatureEnabled(gate.user.orgId, 'hrmSurveys')
  return { orgId: gate.user.orgId, userId: gate.user.id, session: gate }
}

export async function loadMeSurveysHome(authz: MeSurveysAuthz) {
  const t = await getTranslations('hrm')
  const tabs = await meTabs(authz.session, '/me/surveys')
  // An unlinked login is a correct refusal with the remedy (the shared
  // loadOrRefuse mechanism): only the no-link REFUSED text converts — the
  // grant refusal from the same call and every other error still throw.
  const outcome = await loadOrRefuse(
    () => listOwnInvitations({ orgId: authz.orgId, actorId: authz.userId }),
    {
      refusals: [
        { error: HrmSurveysError, code: 'REFUSED', messageIncludes: 'not linked to a person record' },
      ],
      title: t('me.refusedTitle'),
    },
  )
  const invitations = outcome.ok ? outcome.data : []
  const refusal: PageRefusal | null = outcome.ok ? null : outcome.refusal
  return {
    title: t('meSurveys.title'),
    description: t('meSurveys.description'),
    tabs,
    refusal,
    columns: {
      name: t('meSurveys.columns.name'),
      closes: t('meSurveys.columns.closes'),
    },
    rows: invitations.map((invitation) => ({
      id: invitation.invitationId,
      name: invitation.surveyName,
      kind: invitation.surveyKind,
      closes: invitation.closesAt,
    })),
    empty: t('meSurveys.empty'),
    respondLabel: t('meSurveys.respond'),
    actionFailed: t('meSurveys.actionFailed'),
  }
}
