'use client'

import { useState } from 'react'
import { Printer } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Button } from '@openbooks/ui'

/**
 * Print the statement's PDF directly: fetch the same PDF the export produces,
 * load it into a hidden iframe, and open the browser print dialog on it. This
 * prints the paper-style PDF (not the on-screen app chrome), so what prints
 * matches what downloads.
 */
export function PrintButton({ href }: { href: string }) {
  const t = useTranslations('reports.export')
  const [busy, setBusy] = useState(false)

  async function print() {
    setBusy(true)
    try {
      const res = await fetch(href)
      if (!res.ok) throw new Error('print failed')
      const url = URL.createObjectURL(await res.blob())
      const iframe = document.createElement('iframe')
      iframe.style.position = 'fixed'
      iframe.style.right = '0'
      iframe.style.bottom = '0'
      iframe.style.width = '0'
      iframe.style.height = '0'
      iframe.style.border = '0'
      iframe.src = url
      iframe.onload = () => {
        iframe.contentWindow?.focus()
        iframe.contentWindow?.print()
        // Revoke after the print dialog has had time to read the document.
        setTimeout(() => {
          URL.revokeObjectURL(url)
          iframe.remove()
        }, 60_000)
      }
      document.body.appendChild(iframe)
    } catch {
      toast.error(t('printFailed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Button variant="outline" onClick={print} disabled={busy}>
      <Printer size={15} /> {t('print')}
    </Button>
  )
}
