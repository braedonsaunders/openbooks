'use client'

import type { FormLayoutConfig, HeaderFieldPlacement } from '@openbooks/customization'

/**
 * Layout-driven transaction header renderer. Iterates the form layout's header
 * groups in order, rendering each visible field inside a 4-column grid cell
 * with its col-span. The full cell content (label + control + help text) is
 * supplied per-field by `renderField`, so this component stays generic across
 * record types while honouring a customized layout (move / hide / rename /
 * required / group / col-span). Custom fields (`cf_<key>`) are placed here
 * exactly like built-ins.
 *
 * This replaces the hand-coded header grid the transaction drawers used.
 */
const COL_SPAN_CLASS: Record<number, string> = {
  1: '',
  2: 'lg:col-span-2',
  3: 'lg:col-span-3',
  4: 'lg:col-span-4',
}

export function HeaderFields({
  layout,
  editable,
  renderField,
}: {
  layout: FormLayoutConfig
  editable: boolean
  /** Render the full cell (label + control + help text) for one placement. */
  renderField: (placement: HeaderFieldPlacement, editable: boolean) => React.ReactNode
}) {
  return (
    <div className="space-y-5">
      {layout.header.groups.map((group) => {
        const visible = group.fields.filter((f) => f.visible)
        if (visible.length === 0) return null
        return (
          <div key={group.id} className="space-y-3">
            {group.label && group.label.trim() ? (
              <div className="text-xs font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400">
                {group.label}
              </div>
            ) : null}
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {visible.map((placement) => {
                const content = renderField(placement, editable)
                if (content == null) return null
                return (
                  <div key={placement.key} className={`space-y-1.5 ${COL_SPAN_CLASS[placement.colSpan ?? 1] ?? ''}`}>
                    {content}
                  </div>
                )
              })}
            </div>
          </div>
        )
      })}
    </div>
  )
}
