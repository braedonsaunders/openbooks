import 'server-only'

import { redirect } from 'next/navigation'
import { page, widgetBlock, type PageSpec } from '@openbooks/viewspec'
import { currentUser } from '../../../../lib/auth'

/**
 * The sign-in security page, split into a loader and a spec.
 *
 * This page is the degenerate case of the brief's vocabulary: a fully
 * client-side panel (`'use client'` — MFA setup/disable forms, recovery
 * codes, session revocation, every fetch) with zero server-rendered content.
 * The LOADER reproduces the native `page.tsx` gate verbatim (`currentUser`
 * or redirect to /login) and returns no presentation data, because there is
 * none: the MFA status and the session list both arrive over
 * `/api/auth/*` after mount. The spec places the whole page body through
 * the `security-panel` widget, exactly as a studio (CardStudio, ViewStudio)
 * or the SQL console is placed: the spec composes pages, it does not
 * reimplement domain components.
 *
 * The native markup is NOT copied. The `<main>` wrapper, the header copy and
 * the panel live in `sections.tsx` (`SecurityPageContent`, moved there from
 * `page.tsx` so both render paths share one implementation), and the
 * registry entry in INTEGRATION.md renders it directly with no props.
 * `layout: 'bare'` is load-bearing: the native page renders straight into
 * the app shell's `<main>`, so `list`/`detail` would nest a second
 * ListPageLayout around it and break parity.
 */

/** No server-rendered content: the loader runs the gate and binds nothing. */
export type SecurityData = Record<string, unknown>

export async function loadSecurity(
  _sp: Record<string, string | string[] | undefined>,
): Promise<SecurityData> {
  // Native page.tsx, verbatim: unauthenticated readers bounce to /login.
  const user = await currentUser()
  if (!user) redirect('/login')
  return {}
}

export function securitySpec(_data: SecurityData): PageSpec {
  return page({
    layout: 'bare',
    header: [],
    body: [widgetBlock('security-panel')],
  })
}
