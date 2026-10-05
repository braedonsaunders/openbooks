'use client'

import { useState, useSyncExternalStore } from 'react'
import { useTranslations } from 'next-intl'
import { Download } from 'lucide-react'
import { toast } from 'sonner'
import { Button, Drawer } from '@openbooks/ui'
import { installServerSnapshot, installSnapshot, requestInstallation, subscribeInstallation } from '../../../lib/pwa-install'

/** The /me header uses the same Button and Drawer as other native workspace actions. */
export function InstallEmployeeApp() {
  const t = useTranslations('hrm.me.installApp')
  const installation = useSyncExternalStore(subscribeInstallation, installSnapshot, installServerSnapshot)
  const [instructions, setInstructions] = useState(false)
  if (!installation.visible) return null

  async function install() {
    try {
      const result = await requestInstallation()
      if (result === 'instructions') setInstructions(true)
    } catch {
      toast.error(t('failed'))
      setInstructions(true)
    }
  }

  return <>
    <Button variant="outline" size="sm" disabled={installation.busy} onClick={install}>
      <Download size={16} aria-hidden="true" />{t('action')}
    </Button>
    <Drawer open={instructions} onClose={() => setInstructions(false)} title={t('title')}
      footer={<Button onClick={() => setInstructions(false)}>{t('close')}</Button>}>
      <div className="space-y-4 p-6 text-sm text-slate-700 dark:text-slate-300">
        <p>{t(installation.platform)}</p>
        <p>{t('online')}</p>
      </div>
    </Drawer>
  </>
}
