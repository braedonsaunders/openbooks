'use client'

// Select — the app-wide select control. It looks and behaves like the
// SearchSelect typeahead (anchored dropdown on desktop, bottom sheet on mobile,
// searchable, keyboard nav, dark-mode) but keeps the *exact* native-<select>
// API: pass <option>/<optgroup> children, `value`/`onChange`, or
// `name`/`defaultValue` for server-action forms. A visually-hidden real
// <select> underneath carries the value, fires the genuine
// onChange(ChangeEvent<HTMLSelectElement>), and powers native form submission
// + `required` validation — so this is a drop-in replacement for a plain
// <select> with no field-contract change anywhere.
//
// There are intentionally NO native <select> dropdowns in the product; use this
// (or SearchSelect / PersonSelectField for fully-custom cases) everywhere.

import * as React from 'react'
import { SearchSelect, type SelectOption } from './search-select'
import { cn } from './utils'

export type SelectProps = React.SelectHTMLAttributes<HTMLSelectElement> & {
  /** Greyed placeholder shown when nothing is selected (or use a leading <option value=""> ). */
  placeholder?: string
  /** Title of the mobile bottom sheet. */
  sheetTitle?: string
  searchPlaceholder?: string
  /** Force the in-dropdown search box on/off. Defaults to auto (shown for long lists). */
  searchable?: boolean
  /** Extra classes for the trigger button (the visible control). */
  triggerClassName?: string
}

function textOf(node: React.ReactNode): string {
  if (node == null || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (React.isValidElement(node))
    return textOf((node.props as { children?: React.ReactNode }).children)
  return ''
}

type Parsed = {
  options: SelectOption[]
  placeholder?: string
  clearable: boolean
  emptyLabel?: string
}

// Flatten <option>/<optgroup> children into a SelectOption[] for the typeahead.
// A leading <option value=""> becomes the placeholder (greyed); if it isn't
// disabled it also makes the field clearable back to "".
function parseChildren(children: React.ReactNode): Parsed {
  const options: SelectOption[] = []
  let placeholder: string | undefined
  let emptyLabel: string | undefined
  let clearable = false
  let seenAny = false

  const pushOption = (el: React.ReactElement, group?: string) => {
    const p = el.props as {
      value?: string | number | readonly string[]
      children?: React.ReactNode
      disabled?: boolean
      hidden?: boolean
    }
    const label = textOf(p.children)
    const value = p.value != null ? String(p.value) : label
    if (value === '' && !seenAny) {
      // Leading empty option = placeholder.
      placeholder = label || undefined
      emptyLabel = label || 'None'
      clearable = !p.disabled
      seenAny = true
      return
    }
    seenAny = true
    if (p.hidden) return
    options.push({ value, label: label || value, disabled: !!p.disabled, group })
  }

  const walk = (nodes: React.ReactNode) => {
    React.Children.forEach(nodes, (child) => {
      if (!React.isValidElement(child)) return
      if (child.type === React.Fragment) {
        walk((child.props as { children?: React.ReactNode }).children)
      } else if (child.type === 'optgroup') {
        const gp = child.props as { label?: string; children?: React.ReactNode }
        React.Children.forEach(gp.children, (o) => {
          if (React.isValidElement(o) && o.type === 'option') pushOption(o, gp.label)
        })
      } else if (child.type === 'option') {
        pushOption(child)
      }
    })
  }
  walk(children)

  return { options, placeholder, clearable, emptyLabel }
}

export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(function Select(
  {
    className,
    triggerClassName,
    children,
    value,
    defaultValue,
    onChange,
    placeholder,
    sheetTitle,
    searchPlaceholder,
    searchable,
    disabled,
    required,
    name,
    id,
    'aria-label': ariaLabel,
    ...rest
  },
  ref,
) {
  const innerRef = React.useRef<HTMLSelectElement | null>(null)
  const setRef = React.useCallback(
    (el: HTMLSelectElement | null) => {
      innerRef.current = el
      if (typeof ref === 'function') ref(el)
      else if (ref) (ref as React.MutableRefObject<HTMLSelectElement | null>).current = el
    },
    [ref],
  )

  const isControlled = value !== undefined
  const [uncontrolled, setUncontrolled] = React.useState(
    defaultValue != null ? String(defaultValue) : '',
  )
  const current = isControlled ? String(value ?? '') : uncontrolled

  const parsed = React.useMemo(() => parseChildren(children), [children])

  function handleNativeChange(e: React.ChangeEvent<HTMLSelectElement>) {
    if (!isControlled) setUncontrolled(e.currentTarget.value)
    onChange?.(e)
  }

  // Drive the hidden native <select> so the genuine change event fires (real
  // ChangeEvent for callers, native form value + validation stay intact).
  function pick(v: string) {
    const el = innerRef.current
    if (!el) return
    el.value = v
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }

  const isInvalid = rest['aria-invalid'] === true || rest['aria-invalid'] === 'true'

  // Historically `className` styled the native <select> box itself, so callers
  // express height/text there as well as width/flex. Route it to the trigger
  // (height/text/width) and the wrapper (width/flex/layout) so both land.
  return (
    <span className={cn('relative block w-full', className)}>
      {/* Form/validation/onChange proxy — visually hidden, never tab-focused. */}
      <select
        {...rest}
        ref={setRef}
        name={name}
        required={required}
        disabled={disabled}
        aria-hidden
        tabIndex={-1}
        {...(isControlled ? { value: current } : { defaultValue })}
        onChange={handleNativeChange}
        className="pointer-events-none absolute inset-0 h-full w-full opacity-0"
      >
        {children}
      </select>
      <SearchSelect
        id={id}
        value={current}
        onChange={pick}
        options={parsed.options}
        placeholder={placeholder ?? parsed.placeholder}
        searchPlaceholder={searchPlaceholder}
        sheetTitle={sheetTitle ?? placeholder ?? parsed.placeholder}
        ariaLabel={ariaLabel}
        clearable={parsed.clearable}
        emptyLabel={parsed.emptyLabel}
        disabled={disabled}
        searchable={searchable}
        invalid={isInvalid}
        triggerClassName={cn(className, triggerClassName)}
      />
    </span>
  )
})
Select.displayName = 'Select'
