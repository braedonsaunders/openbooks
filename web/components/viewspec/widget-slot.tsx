import { Fragment } from 'react'
import type { WidgetRef } from '@braedonsaunders/appkit-viewspec'
import { isFieldRef, resolvePath } from '@braedonsaunders/appkit-viewspec'
import { WIDGET_REGISTRY, UnknownWidgetError } from './widgets'

/**
 * Resolve any field references in a widget's props against the current scope.
 * One level deep — enough for per-item widgets inside `repeat`, and shallow
 * enough that it stays a lookup rather than a traversal language.
 */
export function resolveWidgetProps(
  props: Record<string, unknown> | undefined,
  scope: unknown,
): Record<string, unknown> {
  if (!props) return {}
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(props)) {
    out[key] = isFieldRef(value) ? resolvePath(scope, value.$) : value
  }
  return out
}

/**
 * Render a slot's widgets. A `when` reference that resolves falsy omits the
 * widget entirely — that is how a spec expresses the native pages' conditional
 * `{x ? <Button/> : null}` without gaining a conditional operator.
 */
export function WidgetSlot({ widgets, scope }: { widgets: WidgetRef[] | undefined; scope: unknown }) {
  if (!widgets || widgets.length === 0) return null
  return (
    <>
      {widgets.map((ref, index) => {
        if (ref.when && !resolvePath(scope, ref.when.$)) return null
        const renderer = WIDGET_REGISTRY[ref.widget]
        if (!renderer) throw new UnknownWidgetError(`unknown widget: ${ref.widget}`)
        // A Fragment, not a wrapper element: the native pages place these
        // widgets as direct children of the slot, and any real element here
        // (even display:contents) is markup the native render does not have.
        return <Fragment key={`${ref.widget}-${index}`}>{renderer(resolveWidgetProps(ref.props, scope))}</Fragment>
      })}
    </>
  )
}

/** Render one widget by name — the `widget` block's renderer. */
export function WidgetBlockView({
  name,
  props,
  scope,
}: {
  name: string
  props: Record<string, unknown>
  scope: unknown
}) {
  const renderer = WIDGET_REGISTRY[name]
  if (!renderer) throw new UnknownWidgetError(`unknown widget: ${name}`)
  return <>{renderer(resolveWidgetProps(props, scope))}</>
}
