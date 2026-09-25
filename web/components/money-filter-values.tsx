'use client'

import { useState } from 'react'
import { Button, Input } from '@openbooks/ui'
import { parseLocalizedMoneyValue } from './money-input'

/** Structured exact-decimal list editor; separators are never list delimiters. */
export function MoneyFilterValues({
  values,
  onChange,
  valueLabel,
  addLabel,
  removeLabel,
  placeholder,
}: {
  values: string[]
  onChange: (values: string[]) => void
  valueLabel: (index: number) => string
  addLabel: string
  removeLabel: (index: number) => string
  placeholder: string
}) {
  const [saved, setSaved] = useState(values)
  const [drafts, setDrafts] = useState<string[]>(values.length ? values : [''])

  function commit(index: number) {
    const raw = drafts[index] ?? ''
    if (raw.trim() === '') {
      const next = saved.filter((_, i) => i !== index)
      setSaved(next)
      setDrafts((current) => {
        const remaining = current.filter((_, i) => i !== index)
        return remaining.length ? remaining : ['']
      })
      onChange(next)
      return
    }
    const parsed = parseLocalizedMoneyValue(valueLabel(index), raw)
    if (parsed.value === null) return
    const next = [...saved]
    if (index < next.length) next[index] = parsed.value
    else next.push(parsed.value)
    setSaved(next)
    setDrafts((current) => current.map((value, i) => i === index ? parsed.value : value))
    onChange(next)
  }

  function remove(index: number) {
    const next = saved.filter((_, i) => i !== index)
    setSaved(next)
    setDrafts((current) => {
      const remaining = current.filter((_, i) => i !== index)
      return remaining.length ? remaining : ['']
    })
    onChange(next)
  }

  return (
    <div className="space-y-2">
      {drafts.map((draft, index) => {
        const parsed = draft.trim() === ''
          ? { error: null as string | null }
          : parseLocalizedMoneyValue(valueLabel(index), draft)
        const errorId = `money-filter-value-${index}-error`
        return (
          <div key={index} className="flex items-start gap-2">
            <div>
              <Input
                aria-label={valueLabel(index)}
                aria-invalid={parsed.error !== null}
                aria-describedby={parsed.error ? errorId : undefined}
                inputMode="decimal"
                className="h-8 w-40"
                value={draft}
                placeholder={placeholder}
                onChange={(event) => setDrafts((current) => current.map((value, i) => i === index ? event.target.value : value))}
                onBlur={() => commit(index)}
              />
              {parsed.error ? (
                <p id={errorId} className="mt-1 max-w-sm text-xs text-red-600 dark:text-red-400" role="alert">
                  {parsed.error}
                </p>
              ) : null}
            </div>
            <Button type="button" variant="ghost" size="sm" aria-label={removeLabel(index)} onClick={() => remove(index)}>
              −
            </Button>
          </div>
        )
      })}
      <Button type="button" variant="outline" size="sm" onClick={() => setDrafts((current) => [...current, ''])}>
        {addLabel}
      </Button>
    </div>
  )
}
