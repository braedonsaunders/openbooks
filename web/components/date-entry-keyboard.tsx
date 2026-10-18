'use client'

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { useBusinessToday } from './business-date-provider'
import { formatCivilDate } from '../lib/format'
import {
  applyDateEntryCommand,
  dateEntryCommand,
  expandTypedShortYear,
  firstDayOfWeekForLocale,
  parseTypedDate,
  regionalViewerLocale,
} from '../lib/date-entry'

const INVALID_FLAG = 'dateEntryInvalid'
const OWNED_ARIA_FLAG = 'dateEntryAria'

/** The focused native date field a key or paste is aimed at, if it accepts edits. */
function editableDateInput(target: EventTarget | null): HTMLInputElement | null {
  if (!(target instanceof HTMLInputElement) || target.type !== 'date') return null
  if (target.disabled || target.readOnly || target.dataset.dateEntry === 'off') return null
  return target
}

function markInvalid(input: HTMLInputElement) {
  input.dataset[INVALID_FLAG] = 'true'
  // A field whose owner already states its validity keeps that statement;
  // otherwise the shared Input styling reads aria-invalid.
  if (!input.hasAttribute('aria-invalid')) {
    input.setAttribute('aria-invalid', 'true')
    input.dataset[OWNED_ARIA_FLAG] = 'true'
  }
}

function clearInvalid(input: HTMLInputElement) {
  if (input.dataset[INVALID_FLAG] === undefined) return
  delete input.dataset[INVALID_FLAG]
  if (input.dataset[OWNED_ARIA_FLAG] !== undefined) {
    input.removeAttribute('aria-invalid')
    delete input.dataset[OWNED_ARIA_FLAG]
  }
}

/**
 * Write a value the way typing does, so React's onChange and any native
 * listener observe it. Returns whether the field now holds the value.
 */
function writeValue(input: HTMLInputElement, iso: string): boolean {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  if (!setter) return false
  setter.call(input, iso)
  const EventType = input.ownerDocument.defaultView?.Event ?? Event
  input.dispatchEvent(new EventType('input', { bubbles: true }))
  input.dispatchEvent(new EventType('change', { bubbles: true }))
  return input.value === iso
}

/**
 * Keyboard grammar for native date inputs, installed once in the shell.
 * Product date entry renders DateField (and a static check refuses native
 * date inputs in product code); this behaviour covers the native inputs that
 * embedded third-party surfaces render, such as the scheduling package's
 * task editor and filters, so every date control accepts the same keys. A
 * focused native date input accepts:
 *
 * - `+`/`=` and `-` for the next and previous day; T for the business date;
 *   W/K, M/H and Y/R for the first/last day of the week, month and year
 *   (repeating a key steps a further period);
 * - pasted dates in the viewer's order, ISO, month names, two-digit or
 *   missing years;
 * - a one- or two-digit typed year, moved to the nearest century on blur or
 *   Enter.
 *
 * Text that is not exactly one real date is refused and the field keeps its
 * previous value; an incomplete entry is marked invalid instead of passing
 * as blank. Changes are announced through a polite live region.
 */
export function DateEntryKeyboard() {
  const today = useBusinessToday()
  const viewerLocale = useLocale()
  const t = useTranslations('shell.dateEntry')
  const [announcement, setAnnouncement] = useState('')
  const settings = useRef({ today, viewerLocale, t })
  useLayoutEffect(() => {
    settings.current = { today, viewerLocale, t }
  })

  useEffect(() => {
    const valueAtFocus = new WeakMap<HTMLInputElement, string>()

    function context() {
      const { today: businessToday, viewerLocale: viewer } = settings.current
      const locale = regionalViewerLocale(viewer, typeof navigator === 'undefined' ? [] : navigator.languages ?? [])
      return { today: businessToday, locale, weekStartsOn: firstDayOfWeekForLocale(locale) }
    }

    function announce(message: string) {
      // Clearing first makes a repeated message (two refusals in a row) speak again.
      setAnnouncement('')
      window.setTimeout(() => setAnnouncement(message), 0)
    }

    function commit(input: HTMLInputElement, iso: string | null): boolean {
      const translate = settings.current.t
      if (iso === null) {
        announce(translate('outsideCalendar'))
        return false
      }
      if ((input.min && iso < input.min) || (input.max && iso > input.max)) {
        announce(translate('outsideAllowed'))
        return false
      }
      if (!writeValue(input, iso)) {
        announce(translate('notAccepted'))
        return false
      }
      clearInvalid(input)
      announce(translate('changed', { date: formatCivilDate(iso, context().locale) }))
      return true
    }

    /** Settle a typed year: expand a short year, flag one that cannot be meant. */
    function settleTypedYear(input: HTMLInputElement) {
      if (input.validity?.badInput) {
        markInvalid(input)
        announce(settings.current.t('incomplete'))
        return
      }
      // Only a value edited during this visit is settled: tabbing through a
      // stored historical date never rewrites it.
      if (input.value === '' || input.value === valueAtFocus.get(input)) return
      const year = Number(input.value.slice(0, 4))
      if (year >= 1000) return
      const expanded = expandTypedShortYear(input.value, context().today)
      if (expanded) {
        commit(input, expanded)
        valueAtFocus.set(input, expanded)
        return
      }
      markInvalid(input)
      announce(settings.current.t('checkYear'))
    }

    function onFocusIn(event: FocusEvent) {
      const input = editableDateInput(event.target)
      if (input) valueAtFocus.set(input, input.value)
    }

    function onFocusOut(event: FocusEvent) {
      const input = editableDateInput(event.target)
      if (input) settleTypedYear(input)
    }

    function onInput(event: Event) {
      const input = editableDateInput(event.target)
      if (input && !input.validity?.badInput) clearInvalid(input)
    }

    function onKeyDown(event: KeyboardEvent) {
      const input = editableDateInput(event.target)
      if (!input || event.defaultPrevented || event.isComposing) return
      if (event.ctrlKey || event.metaKey || event.altKey) return
      if (event.key === 'Enter') {
        settleTypedYear(input)
        return
      }
      const command = dateEntryCommand(event.key)
      if (!command) return
      // While a segment is half typed the browser's own editor reads `-` and
      // `+` as separators; the day step applies to a complete or empty field.
      if ((command === 'nextDay' || command === 'previousDay') && input.validity?.badInput) return
      event.preventDefault()
      commit(input, applyDateEntryCommand(command, input.value, context()))
    }

    function onPaste(event: ClipboardEvent) {
      const input = editableDateInput(event.target)
      if (!input) return
      const text = event.clipboardData?.getData('text/plain') ?? ''
      event.preventDefault()
      const parsed = parseTypedDate(text, context())
      if (parsed.ok) {
        commit(input, parsed.iso)
        return
      }
      if (parsed.reason === 'empty') return
      const message = settings.current.t(parsed.reason === 'impossible' ? 'pasteImpossible' : 'pasteUnreadable', { text: text.trim().slice(0, 40) })
      toast.error(message)
      announce(message)
    }

    document.addEventListener('focusin', onFocusIn, true)
    document.addEventListener('focusout', onFocusOut, true)
    document.addEventListener('input', onInput, true)
    document.addEventListener('keydown', onKeyDown, true)
    document.addEventListener('paste', onPaste, true)
    return () => {
      document.removeEventListener('focusin', onFocusIn, true)
      document.removeEventListener('focusout', onFocusOut, true)
      document.removeEventListener('input', onInput, true)
      document.removeEventListener('keydown', onKeyDown, true)
      document.removeEventListener('paste', onPaste, true)
    }
  }, [])

  return (
    <div role="status" aria-live="polite" className="sr-only">
      {announcement}
    </div>
  )
}
