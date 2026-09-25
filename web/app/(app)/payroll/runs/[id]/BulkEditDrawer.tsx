'use client'

/** Split from RunWizard.tsx (ARCH-FILE-SPLIT; pure moves only). */
import { type ComponentOption } from './run-wizard-model'
import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Loader2 } from 'lucide-react'
import { Button, Drawer, FieldHelp } from '@openbooks/ui'
import { MoneyInput, moneyFieldError } from '../../../../../components/money-input'
import { confirmDialog } from '../../../../../lib/confirm'

/** One component amount applied across every selected employee at once. */
/**
 * Bulk adjustment drawer, exported for the amount-refusal test: the amount
 * is refused with a named cause and remedy through the shared money input
 * instead of a naive regex with a silently disabled Apply.
 */
export function BulkEditDrawer({
  count,
  components,
  busy,
  onClose,
  onApply,
}: {
  count: number
  components: ComponentOption[]
  /** Parent in-flight mutation state: Apply disables and shows progress while it runs. */
  busy: boolean
  onClose: () => void
  onApply: (body: Record<string, unknown>) => Promise<void>
}) {
  const t = useTranslations('payroll')
  const tCommon = useTranslations('common')
  const [componentId, setComponentId] = useState('')
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')
  const [replace, setReplace] = useState(false)
  // One stable idempotency key per drawer session: a double-clicked Apply (or
  // a retried request) reuses it and replays instead of writing twice. The
  // drawer unmounts on close, so the next Apply mints a fresh key.
  const [requestKey] = useState(() => crypto.randomUUID())
  // The amount reads through the shared decimal classifier (scale 4, like
  // the server): every unreadable value names its cause and remedy under
  // the field, so a disabled Apply is never silent.
  const amountError = moneyFieldError(t('wizard.adjust.amount'), 'a money amount', amount, 4, {
    required: true,
  })
  const valid = componentId !== '' && amountError === null
  // A half-typed bulk adjustment never closes silently: Esc, the backdrop and
  // the X button all funnel through onClose, and Cancel asks too, so typed
  // work survives a stray click. A clean drawer still closes without prompting.
  const dirty = componentId !== '' || amount !== '' || note !== '' || replace
  async function confirmDiscard(): Promise<boolean> {
    if (!dirty) return true
    return confirmDialog({
      message: tCommon('feedback.unsavedChanges'),
      confirmLabel: tCommon('confirm.discardChanges'),
      tone: 'danger',
    })
  }
  function closeWithConfirm() {
    void confirmDiscard().then((ok) => {
      if (ok) onClose()
    })
  }
  return (
    <Drawer
      open
      onClose={closeWithConfirm}
      size="sm"
      title={t('wizard.review.bulkEdit')}
      description={t('wizard.review.bulkDescription', { count })}
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={closeWithConfirm}>{tCommon('actions.cancel')}</Button>
          <Button
            disabled={!valid || busy}
            onClick={() => void onApply({ componentId, amount, note: note || undefined, replaceComponent: replace, idempotencyKey: requestKey })}
          >
            {busy ? <Loader2 size={14} className="animate-spin" aria-hidden /> : null}
            {busy ? tCommon('actions.saving') : t('wizard.review.bulkApply', { count })}
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <select
          aria-label={t('wizard.adjust.component')}
          value={componentId}
          onChange={(e) => setComponentId(e.target.value)}
          className="w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-900"
        >
          <option value="">{t('wizard.adjust.component')}</option>
          <optgroup label={t('wizard.adjust.earnings')}>
            {components.filter((c) => c.kind === 'earning').map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </optgroup>
          <optgroup label={t('wizard.adjust.deductions')}>
            {components.filter((c) => c.kind === 'deduction').map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </optgroup>
        </select>
        <MoneyInput
          ariaLabel={t('wizard.adjust.amount')}
          value={amount}
          onChange={setAmount}
          field={t('wizard.adjust.amount')}
          noun="a money amount"
          maxScale={4}
          required
          placeholder={t('wizard.adjust.amount')}
          className="w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-right text-sm tabular-nums dark:border-slate-700 dark:bg-slate-900"
        />
        <input
          aria-label={t('wizard.adjust.note')}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={t('wizard.adjust.note')}
          className="w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-900"
        />
        <span className="flex items-center gap-1.5">
          <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
            <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} />
            {t('wizard.adjust.replace')}
          </label>
          <FieldHelp help={t('wizard.adjust.replaceHelp')} />
        </span>
      </div>
    </Drawer>
  )
}
