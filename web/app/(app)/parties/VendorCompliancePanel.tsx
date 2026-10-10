'use client'

import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { useId, useState } from 'react'
import { fetchAction } from '@braedonsaunders/appkit-errors'
import { ActionAlert } from '@braedonsaunders/appkit-errors/react'
import { Label, Select } from '@openbooks/ui'
import { useAppAction } from '../../../lib/use-app-action'
import { useRecordSaveParticipant } from '../../../components/record-save-participants'

export interface ComplianceClassOption {
  id: string
  code: string
  name: string
}

/**
 * The vendor drawer's Compliance tab: assigning a compliance
 * class is the only path that brings a vendor into the
 * /compliance/vendors matrix (membership = an active vendor_roles row with
 * compliance_class_id set), and the matrix empty state already points here.
 * The class edits with the record — read-only until the drawer is in edit
 * mode, saved by the drawer's single Save — through
 * PATCH /api/compliance/vendors/[partyId], which owns the permission
 * (`compliance.manage`), subsidiary fence, and audit trail.
 */
export function VendorCompliancePanel({
  partyId,
  initialClassId,
  classes,
  editable,
}: {
  partyId: string
  initialClassId: string | null
  classes: ComplianceClassOption[]
  /** The drawer is in edit mode and the viewer holds compliance.manage. */
  editable: boolean
}) {
  const classFieldId = useId()
  const t = useTranslations('parties.drawer')
  const { refusal, execute, clearRefusal } = useAppAction()
  const [savedClassId, setSavedClassId] = useState(initialClassId ?? '')
  const [classId, setClassId] = useState(initialClassId ?? '')
  const assigned = classes.find((option) => option.id === savedClassId)

  useRecordSaveParticipant('compliance', {
    dirty: classId !== savedClassId,
    save: async () => {
      const submitted = classId
      const ok = await execute(
        () => fetchAction(`/api/compliance/vendors/${partyId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ complianceClassId: submitted || null }),
        }),
        { fallbackMessage: t('compliance.saveFailed') },
      )
      if (ok) setSavedClassId(submitted)
      return ok
    },
    reset: () => {
      setClassId(savedClassId)
      clearRefusal()
    },
  })

  return (
    <section className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t('compliance.heading')}</h3>
        <p className="text-xs text-slate-500 dark:text-slate-400">{t('compliance.description')}</p>
      </div>
      <ActionAlert error={refusal} fallbackMessage={t('compliance.saveFailed')} />
      {editable ? (
        <div className="max-w-md space-y-1.5">
          <Label id={`${classFieldId}-label`} htmlFor={classFieldId}>{t('compliance.classLabel')}</Label>
          <Select id={classFieldId} aria-labelledby={`${classFieldId}-label`} value={classId} onChange={(event) => setClassId(event.target.value)}>
            <option value="">{t('compliance.noClass')}</option>
            {classes.map((option) => (
              <option key={option.id} value={option.id}>{`${option.code} — ${option.name}`}</option>
            ))}
          </Select>
        </div>
      ) : assigned ? (
        <p className="text-sm text-slate-700 dark:text-slate-300">
          {assigned.code} — {assigned.name}
        </p>
      ) : (
        <p className="text-sm text-slate-500 dark:text-slate-400">
          {t('compliance.untrackedHint')}
        </p>
      )}
      <p className="text-xs">
        <Link href="/compliance/vendors" className="text-teal-700 underline dark:text-teal-300">
          {t('compliance.viewMatrix')}
        </Link>
      </p>
    </section>
  )
}
