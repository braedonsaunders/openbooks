import 'server-only'

import { page, widgetBlock, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import { getTranslations } from 'next-intl/server'
import { requirePermission } from '@/lib/authz'
import { getAppByKey } from '@/lib/apps/store'
import type { AppFrame } from './AppFrame'

/**
 * The installed-app runtime, split into a loader and a spec.
 *
 * This route has three mutually exclusive bodies — not found, disabled, live —
 * and that is the case the language deliberately does not let a spec decide.
 * `when` OMITS a block; it cannot choose between three. So the loader computes
 * three complementary flags and the spec places three blocks, exactly one of
 * which survives. Setting more than one would be a loader bug, and the flags
 * are derived from a single resolution so it cannot happen.
 *
 * The two notice branches bind the SAME widget with different strings, because
 * they are the same markup: a PageHeader and a back link. Only the title and
 * description differ, and the loader resolves both.
 *
 * Loader work copied verbatim: the `apps.use` gate, the key lookup, the
 * missing-or-no-active-version test, the `status !== 'installed'` test, and
 * the `context` object handed to the frame. That context is plain data — app
 * id/key/name plus the caller's id, name and role KEYS — so it crosses the
 * spec boundary as data, not as a capability. An `Authz` never would.
 *
 * The two notice branches resolve their copy through the apps.runtime
 * catalog keys, in the request locale like the sibling library loader.
 */

type FrameContext = Parameters<typeof AppFrame>[0]['context']

export interface AppRuntimeData {
  /** Exactly one of these three is true. */
  notFound: boolean
  disabled: boolean
  live: boolean
  native?: boolean
  searchParams?: Record<string, string | string[] | undefined>
  noticeTitle: string
  noticeDescription: string
  backHref: string
  backLabel: string
  appKey: string
  appName: string
  appsHref: string
  appsLabel: string
  context: FrameContext | null
}

export async function loadAppRuntime(key: string): Promise<AppRuntimeData> {
  const authz = await requirePermission('apps.use')
  const t = await getTranslations('apps')
  const app = await getAppByKey(authz.user.orgId, key)

  const base = {
    backHref: '/apps',
    backLabel: `← ${t('runtime.backToApps')}`,
    appsHref: '/apps',
    appsLabel: t('title'),
  }

  if (!app || !app.activeVersionId) {
    return {
      ...base,
      notFound: true,
      disabled: false,
      live: false,
      noticeTitle: t('runtime.notFoundTitle'),
      noticeDescription: t('runtime.notInstalled'),
      appKey: key,
      appName: '',
      context: null,
    }
  }

  if (app.status !== 'installed') {
    return {
      ...base,
      notFound: false,
      disabled: true,
      live: false,
      noticeTitle: app.name,
      noticeDescription: t('runtime.disabled'),
      appKey: app.key,
      appName: app.name,
      context: null,
    }
  }

  return {
    ...base,
    notFound: false,
    disabled: false,
    live: app.manifest?.frontend.renderer !== 'native',
    native: app.manifest?.frontend.renderer === 'native',
    noticeTitle: '',
    noticeDescription: '',
    appKey: app.key,
    appName: app.name,
    context: {
      app: { id: app.id, key: app.key, name: app.name, versionId: app.activeVersionId },
      user: {
        id: authz.user.id,
        name: authz.user.name,
        roles: authz.user.roles.map(({ key: roleKey }) => roleKey),
      },
    },
  }
}

export function appRuntimeSpec(data: AppRuntimeData): PageSpec {
  return page({
    route: '/apps/[key]',
    // The runtime owns its own full-height flex column, and the two notice
    // branches own their own centred container. A `list` layout would nest
    // either inside a shell the native page never renders.
    layout: 'bare',
    header: [],
    body: [
      {
        ...widgetBlock('app-notice', {
          title: data.noticeTitle,
          description: data.noticeDescription,
          backHref: data.backHref,
          backLabel: data.backLabel,
        }),
        when: { $: 'notFound' },
      },
      {
        ...widgetBlock('app-notice', {
          title: data.noticeTitle,
          description: data.noticeDescription,
          backHref: data.backHref,
          backLabel: data.backLabel,
        }),
        when: { $: 'disabled' },
      },
      { ...widgetBlock('native-extension', { appKey: data.appKey, sp: data.searchParams ?? {} }), when: { $: 'native' } },
      {
        ...widgetBlock('app-runtime-chrome', {
          appKey: data.appKey,
          appName: data.appName,
          appsHref: data.appsHref,
          appsLabel: data.appsLabel,
          context: data.context,
        }),
        when: { $: 'live' },
      },
    ],
  })
}
