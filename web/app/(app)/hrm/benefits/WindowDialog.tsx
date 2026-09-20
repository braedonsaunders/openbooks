'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Button, Drawer, Input, Label, Select } from '@openbooks/ui'
import { readApiErrorMessage } from '../../../../lib/api-error'

/**
 * New-window dialog, opened from the page header through the `window=new`
 * search param; closing navigates the param away. The form uses the shared
 * @openbooks/ui primitives and POSTs the enrollment-windows collection
 * route; the API's refusal surfaces intact when the server rejects.
 */
export function WindowDialog({
  closeHref,
  subsidiaryOptions,
  departmentOptions,
}: {
  closeHref: string
  subsidiaryOptions: { value: string; label: string }[]
  departmentOptions: { value: string; label: string }[]
}) {
  const t = useTranslations('hrm')
  const router = useRouter()
  const [saving, setSaving] = useState(false)
  const [name, setName] = useState('')
  const [kind, setKind] = useState('open_enrollment')
  const [opensOn, setOpensOn] = useState('')
  const [closesOn, setClosesOn] = useState('')
  const [planYearStartOn, setPlanYearStartOn] = useState('')
  const [subsidiary, setSubsidiary] = useState('')
  const [department, setDepartment] = useState('')

  function close() {
    router.push(closeHref as never)
    router.refresh()
  }

  async function save() {
    if (!name.trim() || !opensOn || !closesOn || !planYearStartOn) {
      toast.error(t('benefits.windowRequired'))
      return
    }
    setSaving(true)
    const res = await fetch('/api/hrm/enrollment-windows', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: name.trim(),
        kind,
        opensOn,
        closesOn,
        planYearStartOn,
        employerSubsidiaryId: subsidiary || null,
        departmentId: department || null,
      }),
    })
    setSaving(false)
    if (!res.ok) {
      toast.error(await readApiErrorMessage(res, t('benefits.windowFailed')))
      return
    }
    close()
  }

  return (
    <Drawer open onClose={close} title={t('benefits.newWindowTitle')} size="md">
      <div className="flex flex-col gap-4 p-4">
        <div>
          <Label htmlFor="benefits-window-name">{t('benefits.windowName')}</Label>
          <Input id="benefits-window-name" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="benefits-window-kind">{t('benefits.windowKind')}</Label>
          <Select id="benefits-window-kind" value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="open_enrollment">{t('benefits.windowKinds.open_enrollment')}</option>
            <option value="new_hire">{t('benefits.windowKinds.new_hire')}</option>
            <option value="life_event">{t('benefits.windowKinds.life_event')}</option>
          </Select>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="benefits-window-opens">{t('benefits.windowOpens')}</Label>
            <Input id="benefits-window-opens" type="date" value={opensOn} onChange={(e) => setOpensOn(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="benefits-window-closes">{t('benefits.windowCloses')}</Label>
            <Input id="benefits-window-closes" type="date" value={closesOn} onChange={(e) => setClosesOn(e.target.value)} />
          </div>
        </div>
        <div>
          <Label htmlFor="benefits-window-year">{t('benefits.windowPlanYear')}</Label>
          <Input
            id="benefits-window-year"
            type="date"
            value={planYearStartOn}
            onChange={(e) => setPlanYearStartOn(e.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="benefits-window-subsidiary">{t('benefits.windowSubsidiary')}</Label>
          <Select id="benefits-window-subsidiary" value={subsidiary} onChange={(e) => setSubsidiary(e.target.value)}>
            <option value="">{t('benefits.windowAll')}</option>
            {subsidiaryOptions.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label htmlFor="benefits-window-department">{t('benefits.windowDepartment')}</Label>
          <Select id="benefits-window-department" value={department} onChange={(e) => setDepartment(e.target.value)}>
            <option value="">{t('benefits.windowAll')}</option>
            {departmentOptions.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={close}>
            {t('benefits.cancel')}
          </Button>
          <Button disabled={saving} onClick={save}>
            {t('benefits.createWindow')}
          </Button>
        </div>
      </div>
    </Drawer>
  )
}
