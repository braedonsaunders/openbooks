'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Plus } from 'lucide-react'
import { Button } from '@openbooks/ui'
import { toast } from 'sonner'

export function CrmNewButton({ apiPath, basePath, param, label, failed, body }: {
  apiPath: string
  basePath: string
  param: string
  label: string
  failed: string
  body?: Record<string, unknown>
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  async function create() {
    setBusy(true)
    try {
      const response = await fetch(apiPath, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) })
      const result = await response.json()
      if (!response.ok || !result.id) throw new Error()
      router.push(`${basePath}?${param}=${result.id}`)
    } catch { toast.error(failed); setBusy(false) }
  }
  return <Button onClick={create} disabled={busy}><Plus size={16} />{label}</Button>
}
