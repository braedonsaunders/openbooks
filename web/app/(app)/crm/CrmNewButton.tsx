'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Plus } from 'lucide-react'
import { Button } from '@openbooks/ui'
import { toast } from 'sonner'
import { readApiErrorMessage } from '../../../lib/api-error'

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
      if (!response.ok) throw new Error(await readApiErrorMessage(response, failed))
      const result = (await response.json().catch(() => null)) as { id?: unknown } | null
      if (typeof result?.id !== 'string' || !result.id) throw new Error(failed)
      router.push(`${basePath}?${param}=${result.id}`)
    } catch (error) { toast.error(error instanceof Error ? error.message : failed); setBusy(false) }
  }
  return <Button onClick={create} disabled={busy}><Plus size={16} />{label}</Button>
}
