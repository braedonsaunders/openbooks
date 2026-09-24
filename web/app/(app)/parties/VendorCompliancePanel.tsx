'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useState } from 'react'
import { toast } from 'sonner'
import { Button, Label, Select } from '@openbooks/ui'
import { readApiErrorMessage } from '../../../lib/api-error'

export interface ComplianceClassOption {
  id: string
  code: string
  name: string
}

/**
 * The vendor drawer's Compliance tab (F-t04-003): assigning a compliance
 * class is the only path that brings a vendor into the
 * /compliance/vendors matrix (membership = an active vendor_roles row with
 * compliance_class_id set), and the matrix empty state already points here.
 * Saves through PATCH /api/compliance/vendors/[partyId], which owns the
 * permission (`compliance.manage`), subsidiary fence, and audit trail.
 */
export function VendorCompliancePanel({
  partyId,
  initialClassId,
  classes,
  canManage,
}: {
  partyId: string
  initialClassId: string | null
  classes: ComplianceClassOption[]
  canManage: boolean
}) {
  const t = useTranslations('parties.drawer')
  const tc = useTranslations('common')
  const router = useRouter()
  const [classId, setClassId] = useState(initialClassId ?? '')
  const [busy, setBusy] = useState(false)
  const assigned = classes.find((option) => option.id === (initialClassId ?? ''))

  async function save() {
    setBusy(true)
    try {
      const response = await fetch(`/api/compliance/vendors/${partyId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ complianceClassId: classId || null }),
      })
      // The status is checked before the body is read: `result.error` is
      // unguarded here, so an object payload toasted '[object Object]'.
      if (!response.ok) throw new Error(await readApiErrorMessage(response, t('compliance.saveFailed')))
      toast.success(t('compliance.saved'))
      router.refresh()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('compliance.saveFailed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t('compliance.heading')}</h3>
        <p className="text-xs text-slate-500 dark:text-slate-400">{t('compliance.description')}</p>
      </div>
      {assigned ? (
        <p className="text-sm text-slate-700 dark:text-slate-300">
          {assigned.code} — {assigned.name}
        </p>
      ) : (
        <p className="text-sm text-slate-500 dark:text-slate-400">
          {t('compliance.untrackedHint')}
        </p>
      )}
      {canManage ? (
        <div className="max-w-md space-y-3">
          <div className="space-y-1.5">
            <Label>{t('compliance.classLabel')}</Label>
            <Select value={classId} onChange={(event) => setClassId(event.target.value)}>
              <option value="">{t('compliance.noClass')}</option>
              {classes.map((option) => (
                <option key={option.id} value={option.id}>{`${option.code} — ${option.name}`}</option>
              ))}
            </Select>
          </div>
          <Button disabled={busy} onClick={save}>{busy ? tc('actions.saving') : tc('actions.save')}</Button>
        </div>
      ) : null}
      <p className="text-xs">
        <Link href="/compliance/vendors" className="text-teal-700 underline dark:text-teal-300">
          {t('compliance.viewMatrix')}
        </Link>
      </p>
    </section>
  )
}
