import 'server-only'

import { getTranslations } from 'next-intl/server'
import { frame, page, pageHeader, ref, widgetBlock, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import { readOrgEmailConfigView } from '@openbooks/engine/src/email-config.ts'
import { requirePermission } from '../../../../lib/authz'
import type { ComponentProps } from 'react'
import type { EmailSettingsForm } from './EmailSettingsForm'

/**
 * Email delivery settings, split into a loader and a spec.
 *
 * The native page is a permission gate + one config read, then the whole
 * surface renders inside ONE client island (`EmailSettingsForm`): the form
 * owns `useState` (field values, the secret draft, replaceSecret,
 * saving/testing flags), fires `fetch` PUT/POST mutations, looks up
 * `EMAIL_PROVIDER_SPECS` to decide which provider fields and secret block to
 * show, and toasts + `router.refresh()` on save. Decomposing any of that
 * into spec blocks would render the wrong provider's fields — a spec `when`
 * is presence, never a choice between field sets, and the provider switch is
 * a five-way conditional pair — and would strand the inputs from the state
 * they edit (the bank-feeds precedent). So the island arrives whole through
 * one widget; the loader makes every server-side decision the native page
 * made (the `admin.setup.manage` gate, the hub back label, the redacted
 * config read) and the widget only renders.
 *
 * Secret note: the loader returns `readOrgEmailConfigView`, which carries
 * only `hasSecret` — the sealed ciphertext never leaves the engine module,
 * so the serializable `initial` blob is safe to bind through the spec.
 */

export interface EmailSettingsData {
  title: string
  description: string
  backHref: string
  backLabel: string
  initial: ComponentProps<typeof EmailSettingsForm>['initial']
}

export async function loadEmailSettings(): Promise<EmailSettingsData> {
  const authz = await requirePermission('admin.setup.manage')
  const tHub = await getTranslations('admin.hub')
  const config = await readOrgEmailConfigView(authz.user.orgId)

  return {
    title: 'Email delivery',
    description: 'Configure your email provider so scheduled reports and notifications can be delivered.',
    backHref: '/admin',
    backLabel: tHub('title'),
    initial: config,
  }
}

const f = ref<EmailSettingsData>()

export function emailSettingsSpec(data: EmailSettingsData): PageSpec {
  return page({
    route: '/admin/email',
    // The page owns its own shell (PageContainer) the way the platform hub
    // does — ListPageLayout's sticky-header chrome would nest a second shell
    // around it, so header and body concatenate and the frame renders the
    // exact native shell. The native page places PageHeader and the form as
    // DIRECT children of PageContainer (no wrapper div), so the frame holds
    // exactly those two blocks — the form's `max-w-2xl space-y-6` root
    // belongs to the island itself and must not be placed twice.
    layout: 'bare',
    header: [],
    body: [
      frame('page-container', [
        pageHeader({
          title: f('title'),
          description: f('description'),
          back: { href: f('backHref'), label: f('backLabel') },
        }),
        widgetBlock('email-settings-form', { initial: data.initial }),
      ]),
    ],
  })
}
