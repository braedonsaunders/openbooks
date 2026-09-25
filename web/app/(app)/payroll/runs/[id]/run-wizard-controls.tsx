'use client'

/** Split from RunWizard.tsx (ARCH-FILE-SPLIT; pure moves only). */
import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@openbooks/ui'

/* ------------------------------------------------------------------ */

export function HeaderFact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-[11px] font-medium tracking-wide text-slate-400 uppercase dark:text-slate-500">
        {label}
      </dt>
      <dd className="font-medium whitespace-nowrap text-slate-800 tabular-nums dark:text-slate-100">
        {children}
      </dd>
    </div>
  )
}

/**
 * Entity pick + one-click legacy attribution of a subsidiary-less run.
 * Same shape as RecordPaymentControl: a labelled select composed with the
 * action button, so the picker never drifts from the house control pattern.
 */
export function AttributeEntityControl({
  entityOptions,
  busy,
  onAttribute,
}: {
  entityOptions: { id: string; label: string }[]
  busy: boolean
  onAttribute: (subsidiaryId: string) => void
}) {
  const t = useTranslations('payroll')
  const [subsidiaryId, setSubsidiaryId] = useState(entityOptions[0]?.id ?? '')
  return (
    <span className="flex items-center gap-2">
      <select
        aria-label={t('wizard.finish.entityTarget')}
        value={subsidiaryId}
        onChange={(e) => setSubsidiaryId(e.target.value)}
        className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-900"
      >
        {entityOptions.map((option) => (
          <option key={option.id} value={option.id}>{option.label}</option>
        ))}
      </select>
      <Button size="sm" disabled={busy || !subsidiaryId} onClick={() => onAttribute(subsidiaryId)}>
        {t('wizard.finish.attributeEntity')}
      </Button>
    </span>
  )
}

/** Bank pick + one-click settlement of the run's net-pay open items. */
export function RecordPaymentControl({
  bankAccounts,
  busy,
  onRecord,
}: {
  bankAccounts: { id: string; label: string }[]
  busy: boolean
  onRecord: (bankAccountId: string) => void
}) {
  const t = useTranslations('payroll')
  const [bankAccountId, setBankAccountId] = useState(bankAccounts[0]?.id ?? '')
  return (
    <span className="flex items-center gap-2">
      <select
        aria-label={t('wizard.finish.bankAccount')}
        value={bankAccountId}
        onChange={(e) => setBankAccountId(e.target.value)}
        className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-900"
      >
        {bankAccounts.map((account) => (
          <option key={account.id} value={account.id}>{account.label}</option>
        ))}
      </select>
      <Button size="sm" disabled={busy || !bankAccountId} onClick={() => onRecord(bankAccountId)}>
        {t('wizard.finish.recordPayment')}
      </Button>
    </span>
  )
}
