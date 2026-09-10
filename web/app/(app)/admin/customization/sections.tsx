import Link from 'next/link'
import { Badge } from '@openbooks/ui'

/**
 * Composite cells and the tab strip for the record-customization page.
 *
 * Each piece below holds conditional or multi-element composition that is a
 * component, not a spec construct — the established boundary. Shared by both
 * render paths: the native page imports these back so there is exactly one
 * implementation.
 */

/** Forms table "default" cell: `{isDefault ? Badge : null}{' '}{roles ? span : null}`. */
export function FormDefaultCell({
  showDefault,
  defaultLabel,
  rolesLabel,
}: {
  showDefault: boolean
  defaultLabel: string
  rolesLabel: string
}) {
  return (
    <>
      {showDefault ? <Badge variant="default">{defaultLabel}</Badge> : null}{' '}
      {rolesLabel ? <span className="text-xs text-slate-400">{rolesLabel}</span> : null}
    </>
  )
}

/** Views table "scope" cell: scope badge plus the conditional default badge. */
export function ViewScopeCell({
  scopeLabel,
  scopeVariant,
  showDefault,
  defaultLabel,
}: {
  scopeLabel: string
  scopeVariant: 'default' | 'secondary'
  showDefault: boolean
  defaultLabel: string
}) {
  return (
    <>
      <Badge variant={scopeVariant}>{scopeLabel}</Badge>
      {showDefault ? <Badge variant="outline">{defaultLabel}</Badge> : null}
    </>
  )
}

/**
 * The forms/views tab strip. Plain links in a bordered pill with teal-active
 * classes — deliberately NOT the Badge links `toggle-links` renders.
 */
export function CustomizationTabs({
  formsHref,
  viewsHref,
  formsLabel,
  viewsLabel,
  formsActive,
  showForms,
}: {
  formsHref: string
  viewsHref: string
  formsLabel: string
  viewsLabel: string
  formsActive: boolean
  showForms: boolean
}) {
  const activeClass = 'bg-teal-50 text-teal-700 dark:bg-teal-950/50 dark:text-teal-300'
  const idleClass = 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'
  return (
    <div className="flex rounded-lg border border-slate-200 p-0.5 dark:border-slate-800">
      {showForms ? (
        <Link
          href={formsHref as never}
          className={`rounded-md px-3 py-1.5 text-sm font-medium ${formsActive ? activeClass : idleClass}`}
        >
          {formsLabel}
        </Link>
      ) : null}
      <Link
        href={viewsHref as never}
        className={`rounded-md px-3 py-1.5 text-sm font-medium ${formsActive ? idleClass : activeClass}`}
      >
        {viewsLabel}
      </Link>
    </div>
  )
}
