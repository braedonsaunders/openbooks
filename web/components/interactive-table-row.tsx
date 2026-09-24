'use client'

import { isValidElement, type ComponentProps, type KeyboardEvent, type MouseEvent } from 'react'
import { TableRow } from '@openbooks/ui'

type Props = ComponentProps<typeof TableRow>

const ACTION_DESCENDANT =
  'a, button, input, select, textarea, label, [role="button"], [role="menuitem"], [data-row-action]'
const INTERACTIVE_COMPONENTS = new Set([
  'Button', 'Checkbox', 'Input', 'Link', 'SearchSelect', 'Select', 'Textarea',
])

function containsInteractiveControl(children: unknown): boolean {
  if (Array.isArray(children)) return children.some(containsInteractiveControl)
  if (!isValidElement<{ children?: unknown }>(children)) return false
  const type: unknown = children.type
  const name = typeof type === 'string'
    ? type
    : typeof type === 'function'
      ? type.name
      : typeof type === 'object' && type !== null && 'displayName' in type
        ? String((type as { displayName?: unknown }).displayName)
      : ''
  return (
    ['a', 'button', 'input', 'select', 'textarea'].includes(name) ||
    INTERACTIVE_COMPONENTS.has(name) ||
    containsInteractiveControl(children.props.children)
  )
}

/** Adds native button-style keyboard behavior to a row that opens a record. */
export function InteractiveTableRow({
  onClick,
  onKeyDown,
  role,
  tabIndex,
  className,
  children,
  ...props
}: Props) {
  const hasInteractiveChild = containsInteractiveControl(children)
  const handleClick = (event: MouseEvent<HTMLTableRowElement>) => {
    const target = event.target as Element | null
    if (target !== event.currentTarget && target?.closest?.(ACTION_DESCENDANT)) return
    onClick?.(event)
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLTableRowElement>) => {
    onKeyDown?.(event)
    if (
      event.defaultPrevented ||
      event.target !== event.currentTarget ||
      !onClick ||
      (event.key !== 'Enter' && event.key !== ' ')
    ) {
      return
    }
    event.preventDefault()
    event.currentTarget.click()
  }

  return (
    <TableRow
      {...props}
      role={onClick ? role ?? (hasInteractiveChild ? undefined : 'button') : role}
      tabIndex={onClick ? tabIndex ?? 0 : tabIndex}
      onClick={onClick ? handleClick : undefined}
      onKeyDown={onClick ? handleKeyDown : onKeyDown}
      className={`${className ?? ''} focus-visible:outline focus-visible:outline-2 focus-visible:outline-teal-600`}
    >
      {children}
    </TableRow>
  )
}
