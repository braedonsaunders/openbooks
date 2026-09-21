import { UrlDrawer } from '@openbooks/ui'
import { ProcessChecklistBody } from '../processes-client'
import type { ProcessesPageData } from '../../../../lib/hrm/processes-page'

/**
 * Process checklist drawer section (server component): the URL drawer shell
 * around the shared client checklist body with owners, due dates, evidence,
 * and the complete/skip actions. The segment pills and the checklist table
 * now render through the shared `filter-chips` widget and the ViewSpec
 * `table` block in ./view, so they live there and not here. Every string
 * arrives loader-resolved as props — no org id, user id, or Authz crosses
 * into render. The interactive body stays the client component the page
 * and the widget registry share via this file so they cannot drift.
 */

/**
 * The checklist flyout shell: a URL drawer around the shared client
 * checklist body that closes by navigation, or the named load failure for
 * a bookmarked id that no longer resolves. Null payload renders nothing —
 * the spec's `when` gate already omits it, so this is the second half of
 * the same guard.
 */
export function ProcessDrawer({
  drawer,
}: {
  drawer: ProcessesPageData['drawer']
}) {
  if (!drawer) return null
  return (
    <UrlDrawer
      open
      closeHref={drawer.closeHref}
      title={drawer.title}
      description={drawer.description ?? undefined}
      headerActions={
        drawer.draft ? (
          <a href={drawer.draft.href} className="text-sm font-medium text-teal-700 dark:text-teal-300">
            {drawer.draft.label}
          </a>
        ) : undefined
      }
    >
      {drawer.detail ? (
        <ProcessChecklistBody detail={drawer.detail} />
      ) : drawer.missingDetail ? (
        <p className="text-sm text-slate-500 dark:text-slate-400">{drawer.missingDetail}</p>
      ) : null}
    </UrlDrawer>
  )
}
