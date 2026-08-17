'use client'

import * as React from 'react'
import { CircleHelp } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { BaseLabel } from './label'
import { Popover } from './popover'
import { cn } from './utils'

export interface FieldLabelProps extends React.LabelHTMLAttributes<HTMLLabelElement> {
  /** Short, plain-language explanation of what the field controls. */
  help?: React.ReactNode
  /**
   * Localized field name used to produce a concise fallback explanation when
   * a more specific `help` string has not been authored yet.
   */
  fieldName?: string
  /** Accessible name override for the help button. */
  helpLabel?: string
  /** Classes for the label/help-button row rather than the label itself. */
  containerClassName?: string
}

function textFromNode(node: React.ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textFromNode).join(' ')
  if (React.isValidElement<{ children?: React.ReactNode }>(node)) return textFromNode(node.props.children)
  return ''
}

/**
 * The `?` help button + popover that `FieldLabel` renders beside every label.
 * Exported so surfaces without a `<label>` (toolbar hints, checkbox rows,
 * table headers) can attach the SAME field-help affordance — never a bespoke
 * hint paragraph.
 */
export function FieldHelp({
  help,
  buttonLabel,
}: {
  /** Explanation shown in the popover. */
  help: React.ReactNode
  /** Accessible name override for the help button. */
  buttonLabel?: string
}) {
  const t = useTranslations('ui.fieldHelp')
  const [open, setOpen] = React.useState(false)
  // A start-aligned panel opening from a trigger near the right viewport edge
  // (a drawer's right column) would clip offscreen, so flip to end-aligned
  // when the button sits in the right half of the screen.
  const [align, setAlign] = React.useState<'start' | 'end'>('start')
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      align={align}
      className="w-72 max-w-[calc(100vw-2rem)] p-3"
      trigger={
        <button
          type="button"
          aria-label={buttonLabel ?? t('open')}
          aria-expanded={open}
          aria-haspopup="dialog"
          onClick={(event) => {
            const { left } = event.currentTarget.getBoundingClientRect()
            setAlign(left > window.innerWidth / 2 ? 'end' : 'start')
            setOpen((value) => !value)
          }}
          className="inline-grid h-5 w-5 shrink-0 place-items-center rounded-full text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 focus-visible:ring-offset-1 dark:hover:bg-slate-800 dark:hover:text-slate-200"
        >
          <CircleHelp size={14} aria-hidden="true" />
        </button>
      }
    >
      <div className="text-sm leading-5 text-slate-700 dark:text-slate-200">{help}</div>
    </Popover>
  )
}

/**
 * A normal form label with an optional click, keyboard, and touch-friendly
 * explanation. The help button deliberately sits beside (not inside) the
 * `<label>` so clicking the label still focuses or toggles its control.
 */
export const FieldLabel = React.forwardRef<HTMLLabelElement, FieldLabelProps>(
  ({ help, fieldName, helpLabel, containerClassName, children, className, ...props }, ref) => {
    const t = useTranslations('ui.fieldHelp')
    const inferredFieldName = textFromNode(children)
      .replace(/\s+/g, ' ')
      .trim()
    const resolvedFieldName = fieldName ?? inferredFieldName
    const resolvedHelp = help ?? (resolvedFieldName ? t('generic', { field: resolvedFieldName }) : undefined)

    if (!resolvedHelp) {
      return (
        <BaseLabel ref={ref} className={className} {...props}>
          {children}
        </BaseLabel>
      )
    }

    return (
      <span className={cn('inline-flex max-w-full items-center gap-1.5', containerClassName)}>
        <BaseLabel ref={ref} className={className} {...props}>
          {children}
        </BaseLabel>
        <FieldHelp help={resolvedHelp} buttonLabel={helpLabel} />
      </span>
    )
  },
)

FieldLabel.displayName = 'FieldLabel'

/** The default app label includes contextual help; use BaseLabel only for raw typography. */
export { FieldLabel as Label }
