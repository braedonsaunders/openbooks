import 'server-only'

import { getTranslations } from 'next-intl/server'
import {
  grid,
  page,
  pageHeader,
  panel,
  ref,
  textBlock,
  widget,
  widgetBlock,
  type PageSpec,
} from '@braedonsaunders/appkit-viewspec'
import { requirePermission } from '../../../../lib/authz'
import { requireFeatureEnabled } from '../../../../lib/feature-gates'
import { loadMeProfile, type MeProfileData } from '../../../../lib/hrm/self-service'

/**
 * Me profile — the person's party fields in a read view with an Edit that
 * opens a URL-drawer form whose submit files the profile_change request. A
 * pending proposal shows as a banner with its status. Nothing else on the
 * party is editable here.
 */

const f = ref<MeProfileData>()

export function meProfileSpec(data: MeProfileData): PageSpec {
  return page({
    route: '/me/profile',
    layout: 'list',
    bodyClassName: 'flex h-full min-h-0 flex-col',
    header: [
      pageHeader({
        title: f('title'),
        description: f('description'),
        actionsClassName: 'flex flex-wrap items-center gap-3',
        actions: [
          widget('link-button', { href: f('editHref'), label: f('editButton') }),
          widget('module-home-tabs', { tabs: data.tabs }),
        ],
      }),
    ],
    body: [
      widgetBlock(
        'empty-state',
        {
          title: data.refusal?.title ?? '',
          description: data.refusal?.message,
        },
        f('refusal'),
      ),
      {
        ...grid('flex h-full min-h-0 flex-col gap-4', [
          {
            ...panel({
              title: f('pendingTitle'),
              iconKey: 'clipboard',
              bodyClassName: 'p-4',
              blocks: [textBlock(f('pendingMessage'))],
            }),
            when: f('hasPending'),
          },
          panel({
            title: f('contactTitle'),
            iconKey: 'users',
            bodyClassName: 'min-h-0 overflow-y-auto p-0',
            blocks: [widgetBlock('hrm-facts', { facts: data.contactFacts })],
          }),
          panel({
            title: f('addressTitle'),
            iconKey: 'building',
            bodyClassName: 'min-h-0 overflow-y-auto p-0',
            blocks: [widgetBlock('hrm-facts', { facts: data.addressFacts, empty: data.noAddress })],
          }),
          panel({
            title: f('emergencyTitle'),
            iconKey: 'heart-pulse',
            bodyClassName: 'min-h-0 overflow-y-auto p-0',
            blocks: [widgetBlock('hrm-facts', { facts: data.emergencyFacts, empty: data.noEmergency })],
          }),
          widgetBlock(
            'hrm-profile-dialog',
            {
              dialog: data.dialog,
              closeHref: data.dialogCloseHref,
            },
            f('dialogOpen'),
          ),
        ]),
        when: f('hasContent'),
      },
    ],
  })
}

export async function loadMeProfilePage(
  sp: Record<string, string | undefined> = {},
): Promise<MeProfileData> {
  const authz = await requirePermission('hrm.self.read')
  await requireFeatureEnabled(authz.user.orgId, 'hrm')
  return loadMeProfile(authz, sp)
}

export async function meProfileTitle(): Promise<string> {
  const t = await getTranslations('hrm')
  return t('me.profile.title')
}
