import type { ComponentProps } from 'react'
import Link from 'next/link'
import { Badge } from '@openbooks/ui'
import type { CellSpec, LeafCell, TextCell } from '@openbooks/viewspec'
import { resolvePath, resolveText, resolveValue } from '@openbooks/viewspec'
import { ReportDrillLink } from '../../app/(app)/reports/ReportDrillLink'
import { TxnLink } from '../../app/(app)/reports/TxnLink'
import type { ReportDrillTarget } from '../../lib/report-drill'
import { DRILL_LINK_CLASS, FALLBACK_CLASS } from './tone'
import { WidgetBlockView } from './widgets'

/**
 * Cell renderers — the leaves of the block registry.
 *
 * Each renderer receives the already-resolved row scope and does exactly one
 * presentational job. None of them format: money and dates arrive as strings
 * the loader already rendered with the tenant's currency, scale and locale.
 * That split is what lets a spec stay declarative, and it is also why these
 * renderers can be exhaustive over a closed union — there is no open-ended
 * "format however this page happens to want" case to accommodate.
 */

/**
 * Tone is applied by the CONTAINER (the table cell, the summary-line wrapper),
 * never by the leaf. The native pages put their conditional colour class on
 * the `<td>`, so emitting it again on a nested span here would produce markup
 * the conformance harness rejects — and would double the styling in the
 * cases where both happened to apply.
 */
function LeafCellView({ spec, scope }: { spec: LeafCell; scope: unknown }) {
  switch (spec.kind) {
    case 'text': {
      const raw = resolvePath(scope, spec.field.$)
      const empty = raw === null || raw === undefined || raw === ''
      if (empty && spec.fallback !== undefined) {
        return <span className={FALLBACK_CLASS}>{resolveText(spec.fallback, scope)}</span>
      }
      if (spec.prefix || spec.suffix) {
        // An affix whose value resolves empty renders NOTHING, not an empty
        // span: the native pages write `{kind ? <span>…</span> : null}`, so an
        // always-present span would be markup they do not have.
        const affix = (part: NonNullable<TextCell['prefix']>) => {
          const value = resolvePath(scope, part.field.$)
          if (value === null || value === undefined || value === '') return null
          return <span className={part.className}>{String(value)}</span>
        }
        return (
          <>
            {spec.prefix ? affix(spec.prefix) : null}
            {String(raw ?? '')}
            {spec.suffix ? affix(spec.suffix) : null}
          </>
        )
      }
      return <>{String(raw ?? '')}</>
    }

    case 'money':
    case 'number':
      return <>{String(resolvePath(scope, spec.field.$) ?? '')}</>


    case 'date':
      return <>{String(resolvePath(scope, spec.field.$) ?? '')}</>

    case 'badge': {
      const variant = resolveValue(spec.variant as never, scope) as
        | 'default'
        | 'outline'
        | 'secondary'
        | 'destructive'
        | undefined
      return <Badge variant={variant ?? 'default'}>{resolveText(spec.field, scope)}</Badge>
    }

    case 'link': {
      const href = resolvePath(scope, spec.href.$)
      const label = resolveText(spec.field, scope)
      // A link with no resolved href degrades to text rather than rendering a
      // dead anchor — the loader owning href means absence is a data state.
      if (typeof href !== 'string' || href === '') return <>{label}</>
      return <Link href={href} className={spec.className}>{label}</Link>
    }

    case 'record-link': {
      const id = resolvePath(scope, spec.id.$)
      const label = resolveText(spec.field, scope)
      const recordType = resolveText(spec.recordType, scope)
      if (typeof id !== 'string' || id === '') return <>{label}</>
      return <Link href={`?${recordType}=${encodeURIComponent(id)}`} scroll={false}>{label}</Link>
    }
  }
}

export function CellView({ spec, scope }: { spec: CellSpec; scope: unknown }) {
  if (spec.kind === 'widget') {
    return <WidgetBlockView name={spec.widget} props={spec.props ?? {}} scope={scope} />
  }
  if (spec.kind === 'txn') {
    // The loader emits the component's own link shape ({ kind: 'transaction',
    // entryId, docKind, docId }) so the renderer performs no reshaping.
    const target = resolvePath(scope, spec.target.$) as
      | ComponentProps<typeof TxnLink>['target']
      | undefined
    if (!target) return <LeafCellView spec={spec.inner} scope={scope} />
    return (
      <TxnLink target={target} className={DRILL_LINK_CLASS}>
        <LeafCellView spec={spec.inner} scope={scope} />
      </TxnLink>
    )
  }
  if (spec.kind === 'drill') {
    const target = resolvePath(scope, spec.target.$) as ReportDrillTarget | undefined
    // No drill target resolved ⇒ render the inner value plainly. Statement rows
    // legitimately lack a target (subtotal rows, unattributed lines).
    if (!target) return <LeafCellView spec={spec.inner} scope={scope} />
    return (
      <ReportDrillLink target={target} className={DRILL_LINK_CLASS}>
        <LeafCellView spec={spec.inner} scope={scope} />
      </ReportDrillLink>
    )
  }
  return <LeafCellView spec={spec} scope={scope} />
}
