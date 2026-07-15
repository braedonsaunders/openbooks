'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { useTranslations } from 'next-intl'
import { Button } from '@openbooks/ui'

export function CloseButtons({
  periodId,
  module,
  moduleLabel,
  closed,
}: {
  periodId: string
  module: string
  moduleLabel: string
  closed: boolean
}) {
  const t = useTranslations('close.buttons')
  const [busy, setBusy] = useState(false)
  const router = useRouter()

  async function act(action: 'close' | 'reopen') {
    if (action === 'reopen' && !confirm(t('reopenConfirm', { module: moduleLabel }))) return
    setBusy(true)
    const res = await fetch('/api/close', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ periodId, module, action }),
    })
    const data = await res.json()
    if (!res.ok) toast.error(data.error ?? t('actionFailed'))
    else
      toast.success(
        action === 'close'
          ? t('closedToast', { module: moduleLabel })
          : t('reopenedToast', { module: moduleLabel }),
      )
    setBusy(false)
    router.refresh()
  }

  return (
    <Button
      variant="ghost"
      size="sm"
      className="h-6 px-2 text-xs"
      disabled={busy}
      onClick={() => act(closed ? 'reopen' : 'close')}
    >
      {closed ? t('reopen') : t('close')}
    </Button>
  )
}
