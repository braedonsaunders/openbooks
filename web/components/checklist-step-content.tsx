'use client'

import { useTranslations } from 'next-intl'
import type { ChecklistStepDesign } from '@openbooks/forms-core'
import { ChatMarkdown } from './assistant/markdown'
import { RecordFields } from './record-fields'
import type { ReactNode } from 'react'

/** The same instructions and form render in the designer preview and live work. */
export function ChecklistStepContent({
  step,
  values,
  onChange,
  acknowledged,
  onAcknowledge,
  disabled,
  attachment,
}: {
  step: { description: string | null; evidenceKind: string; design?: ChecklistStepDesign }
  values: Record<string, unknown>
  onChange: (key: string, value: unknown) => void
  acknowledged?: boolean
  onAcknowledge?: (value: boolean) => void
  disabled?: boolean
  attachment?: ReactNode
}) {
  const t = useTranslations('hrm.processes.designer')
  return (
    <div className="space-y-5">
      {step.description ? <ChatMarkdown>{step.description}</ChatMarkdown> : null}
      {step.design?.resources
        .filter((r) => /^https?:\/\//i.test(r.url))
        .map((r, i) => (
          <a
            key={i}
            href={r.url}
            target="_blank"
            rel="noreferrer"
            className="block text-sm font-medium text-teal-600 underline dark:text-teal-300"
          >
            {r.label || r.url}
          </a>
        ))}
      {step.design?.form ? (
        <RecordFields
          sections={step.design.form.sections}
          values={values}
          onChange={onChange}
          disabled={disabled}
        />
      ) : null}
      {step.evidenceKind === 'acknowledgement' && onAcknowledge ? (
        <label className="flex items-start gap-3 rounded-lg border border-teal-200 bg-teal-50/40 p-4 text-sm dark:border-teal-900 dark:bg-teal-950/30">
          <input
            type="checkbox"
            disabled={disabled}
            checked={acknowledged ?? false}
            onChange={(e) => onAcknowledge(e.target.checked)}
            className="mt-0.5"
          />
          {t('acknowledge')}
        </label>
      ) : null}
      {attachment}
    </div>
  )
}
