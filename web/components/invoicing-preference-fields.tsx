'use client'

import { useTranslations } from 'next-intl'
import { Label, Select } from '@openbooks/ui'

export interface InvoicingPref {
  defaultBasis?: string | null
  backupRequired?: boolean | null
  backupType?: string | null
}

const BASES = ['date_range', 'draw_amount', 'time_selection', 'milestone']
const BACKUP_TYPES = ['costed_timesheets', 'timesheets_purchases', 'purchases', 'purchases_shop_time', 'quote_only', 'none']
const humanize = (v: string) => v.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())

/**
 * The overridable invoicing/backup preference layer, shared by the customer and
 * project surfaces. Every field offers "Inherit" (empty) so the cascade
 * (type ← customer ← project) applies. `inheritedHint` shows what would apply
 * if left on Inherit.
 */
export function InvoicingPreferenceFields({
  value,
  onChange,
  disabled,
  inherited,
}: {
  value: InvoicingPref
  onChange: (next: InvoicingPref) => void
  disabled?: boolean
  /** The effective values from the lower layers (for the "inherits: X" hint). */
  inherited?: { defaultBasis?: string; backupRequired?: boolean; backupType?: string }
}) {
  const t = useTranslations('projects.invoicingPref')
  const set = (patch: InvoicingPref) => onChange({ ...value, ...patch })
  const inh = (label: string | undefined) => (label ? ` (${t('inheritsHint', { value: label })})` : '')

  return (
    <div className="grid gap-4 sm:grid-cols-3">
      <div className="space-y-1.5">
        <Label>{t('defaultBasis')}</Label>
        <Select value={value.defaultBasis ?? ''} disabled={disabled} onChange={(e) => set({ defaultBasis: e.target.value || null })}>
          <option value="">{t('inherit') + inh(inherited?.defaultBasis && humanize(inherited.defaultBasis))}</option>
          {BASES.map((b) => <option key={b} value={b}>{humanize(b)}</option>)}
        </Select>
      </div>
      <div className="space-y-1.5">
        <Label>{t('backupRequired')}</Label>
        <Select value={value.backupRequired == null ? '' : value.backupRequired ? 'yes' : 'no'} disabled={disabled}
          onChange={(e) => set({ backupRequired: e.target.value === '' ? null : e.target.value === 'yes' })}>
          <option value="">{t('inherit') + inh(inherited?.backupRequired == null ? undefined : inherited.backupRequired ? t('yes') : t('no'))}</option>
          <option value="yes">{t('yes')}</option>
          <option value="no">{t('no')}</option>
        </Select>
      </div>
      <div className="space-y-1.5">
        <Label>{t('backupType')}</Label>
        <Select value={value.backupType ?? ''} disabled={disabled} onChange={(e) => set({ backupType: e.target.value || null })}>
          <option value="">{t('inherit') + inh(inherited?.backupType && humanize(inherited.backupType))}</option>
          {BACKUP_TYPES.map((b) => <option key={b} value={b}>{humanize(b)}</option>)}
        </Select>
      </div>
    </div>
  )
}
