'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Plus, Trash2 } from 'lucide-react'
import { Button, EmptyState } from '@openbooks/ui'
import { TagInput } from '@openbooks/ui'
import { confirmDialog } from '@/lib/confirm'

export interface EditableOption {
  id: string | null
  name: string
  values: string[]
}

export interface OptionRename {
  optionName: string
  from: string
  to: string
}

/**
 * Ordered options with TagInput values. A one-for-one value swap is treated
 * as a rename (variant names follow, codes never change) and confirmed with
 * the affected count; anything else travels as plain remove/add, and the
 * engine refuses removals that variants still use, naming them.
 */
export function FamilyOptionsEditor({
  initial,
  variantValues,
  disabled = false,
  onSave,
  onOptionsChange,
  hideSave = false,
}: {
  initial: EditableOption[]
  /** option name → value → variants carrying it, for rename confirmations. */
  variantValues: Record<string, Record<string, number>>
  disabled?: boolean
  onSave: (options: { id: string | null; name: string; values: Array<string | { value: string; previousValue: string }> }[]) => Promise<void>
  /** Live copy of the draft for hosts that derive a preview (create flow). */
  onOptionsChange?: (options: EditableOption[]) => void
  /** Hide the save button when the host drives continuation (create flow). */
  hideSave?: boolean
}) {
  const t = useTranslations('items.families')
  const [options, setOptions] = useState<EditableOption[]>(initial)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function update(next: EditableOption[]): void {
    setOptions(next)
    onOptionsChange?.(next)
  }

  function setName(index: number, name: string): void {
    update(options.map((option, i) => (i === index ? { ...option, name } : option)))
  }

  function setValues(index: number, values: string[]): void {
    update(options.map((option, i) => (i === index ? { ...option, values } : option)))
  }

  async function save(): Promise<void> {
    setError(null)
    const payload = options.map((option) => ({ id: option.id, name: option.name.trim(), values: option.values as Array<string | { value: string; previousValue: string }> }))
    // Detect one-for-one swaps per stored option and confirm them as renames.
    for (let index = 0; index < options.length; index += 1) {
      const current = options[index]!
      const before = initial[index]?.id === current.id ? (initial[index]?.values ?? []) : null
      if (current.id === null || before === null) continue
      const removed = before.filter((value) => !current.values.includes(value))
      const added = current.values.filter((value) => !before.includes(value))
      if (removed.length === 1 && added.length === 1) {
        const affected = variantValues[current.name]?.[removed[0]!] ?? 0
        if (affected > 0) {
          const confirmed = await confirmDialog({
            title: t('options.renameTitle', { from: removed[0]!, to: added[0]! }),
            message: t('options.renameBody', { count: affected }),
            confirmLabel: t('options.renameConfirm'),
          })
          if (!confirmed) return
          payload[index] = {
            id: current.id,
            name: current.name.trim(),
            values: current.values.map((value) =>
              value === added[0] ? { value, previousValue: removed[0]! } : value,
            ),
          }
        }
      }
    }
    setSaving(true)
    try {
      await onSave(payload)
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  if (options.length === 0) {
    return (
      <EmptyState
        title={t('options.empty')}
        description={t('options.emptyHint')}
        action={disabled ? undefined : (
          <Button type="button" variant="outline" size="sm" onClick={() => update([{ id: null, name: '', values: [] }])}>
            <Plus size={14} /> {t('options.addOption')}
          </Button>
        )}
      />
    )
  }

  return (
    <div className="space-y-4">
      {options.map((option, index) => (
        <div key={option.id ?? `new-${index}`} className="rounded-lg border border-slate-200 p-3 dark:border-slate-800">
          <div className="mb-2 flex items-center gap-2">
            <input
              type="text"
              value={option.name}
              disabled={disabled || saving}
              onChange={(event) => setName(index, event.target.value)}
              placeholder={t('options.namePlaceholder')}
              aria-label={t('options.nameLabel', { position: index + 1 })}
              className="w-40 rounded border border-slate-200 bg-transparent px-2 py-1 text-sm dark:border-slate-700"
            />
            <span className="text-xs text-slate-400">{t('options.position', { position: index + 1 })}</span>
            <span className="flex-1" />
            {!disabled ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={saving}
                aria-label={t('options.removeOption', { name: option.name || t('options.unnamed') })}
                onClick={() => update(options.filter((_, i) => i !== index))}
              >
                <Trash2 size={14} />
              </Button>
            ) : null}
          </div>
          <TagInput
            value={option.values}
            onChange={(values) => setValues(index, values)}
            disabled={disabled || saving}
            ariaLabel={t('options.valuesLabel', { name: option.name || t('options.unnamed') })}
            placeholder={t('options.valuesPlaceholder')}
          />
        </div>
      ))}
      {error ? <p role="alert" className="text-sm text-red-600">{error}</p> : null}
      <div className="flex items-center gap-2">
        {!disabled ? (
          <Button type="button" variant="outline" size="sm" disabled={saving} onClick={() => update([...options, { id: null, name: '', values: [] }])}>
            <Plus size={14} /> {t('options.addOption')}
          </Button>
        ) : null}
        {!disabled && !hideSave ? (
          <Button type="button" size="sm" disabled={saving} onClick={() => void save()}>
            {saving ? t('options.saving') : t('options.saveOptions')}
          </Button>
        ) : null}
      </div>
    </div>
  )
}
