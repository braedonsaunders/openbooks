'use client'

import { useCallback, useEffect, useId, useState } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { FileCode } from 'lucide-react'
import { Button, Input, Label, Popover, Select } from '@openbooks/ui'

type Finding = { ruleId: string; severity: 'fatal' | 'warning'; message: string }
type EInvoiceMetadata = {
  profiles: { key: string; label: string; hybridPdf: boolean }[]
  configuredProfile: string | null
  buyerReference: string | null
  canIssue: boolean
  archives: { id: string; profile: string; fileName: string; issuedAt: string; sha256: string; buyerReference: string | null }[]
  valid?: boolean
  findings?: Finding[]
  error?: string
}

/** One composer keeps validation refusals, retries and archived originals visible. */
export function EInvoiceButton({ documentId }: { documentId: string }) {
  const t = useTranslations('pdfTemplates.einvoice')
  const id = useId()
  const base = `/api/documents/${encodeURIComponent(documentId)}/einvoice`
  const [metadata, setMetadata] = useState<EInvoiceMetadata | null>(null)
  const [open, setOpen] = useState(false)
  const [available, setAvailable] = useState(false)
  const [profile, setProfile] = useState('')
  const [reference, setReference] = useState('')
  const [preview, setPreview] = useState<{ valid: boolean; findings: Finding[] } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch(base, { signal })
    if (!response.ok) {
      if (response.status === 403 || response.status === 404) { setAvailable(false); return }
      setAvailable(true)
      const failure = await response.json().catch(() => null) as { error?: string } | null
      throw new Error(failure?.error || t('failed'))
    }
    const data = await response.json() as EInvoiceMetadata
    setMetadata(data)
    setAvailable(true)
    return data
  }, [base, t])

  useEffect(() => {
    const controller = new AbortController()
    refresh(controller.signal).then(data => {
      if (!data || controller.signal.aborted) return
      setProfile(data.configuredProfile ?? '')
      setReference(data.buyerReference ?? '')
    }).catch(cause => { if (!controller.signal.aborted) { setAvailable(true); setError(cause instanceof Error ? cause.message : t('failed')) } })
    return () => controller.abort()
  }, [refresh])

  async function validate() {
    setBusy(true)
    setError(null)
    setPreview(null)
    try {
      const query = new URLSearchParams({ profile, validate: '1', buyerReference: reference.trim() })
      const response = await fetch(`${base}?${query}`)
      if (!response.ok) {
        const failure = await response.json().catch(() => null) as { error?: string } | null
        throw new Error(failure?.error || t('failed'))
      }
      const data = await response.json() as EInvoiceMetadata
      setMetadata(data)
      setPreview({ valid: data.valid === true, findings: data.findings ?? [] })
      setError(data.error ?? null)
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : t('failed'))
    } finally { setBusy(false) }
  }

  async function issue() {
    setBusy(true)
    setError(null)
    try {
      const response = await fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile, buyerReference: reference.trim() || null }) })
      if (!response.ok) {
        const failure = await response.json().catch(() => null) as { error?: string; findings?: Finding[] } | null
        setPreview({ valid: false, findings: failure?.findings ?? [] })
        throw new Error(failure?.error || t('failed'))
      }
      const issued = await response.json() as { id: string }
      await refresh()
      const anchor = document.createElement('a')
      anchor.href = `${base}?issued=${encodeURIComponent(issued.id)}`
      anchor.download = ''
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : t('failed'))
    } finally { setBusy(false) }
  }

  if (!available) return null
  const selectedArchive = metadata?.archives.find(archive => archive.profile === profile)
  return <Popover open={open} onOpenChange={setOpen} trigger={
    <Button variant="outline" onClick={() => setOpen(true)}><FileCode size={15} className="mr-1.5" />{t('label')}</Button>
  }>
    <div className="w-[min(28rem,calc(100vw-2rem))] max-h-[70vh] overflow-y-auto space-y-3 p-4">
      <p className="text-sm text-muted-foreground">{t('help')}</p>
      {!metadata && <Button variant="outline" disabled={busy} onClick={async () => {
        setBusy(true); setError(null)
        try { const data = await refresh(); if (data) { setProfile(data.configuredProfile ?? ''); setReference(data.buyerReference ?? '') } }
        catch (cause) { setError(cause instanceof Error ? cause.message : t('failed')) }
        finally { setBusy(false) }
      }}>{t('validate')}</Button>}
      <div className="space-y-1.5">
        <Label htmlFor={`${id}-profile`}>{t('profile')}</Label>
        <Select id={`${id}-profile`} value={profile} disabled={busy} onChange={event => { setProfile(event.target.value); setPreview(null); setError(null) }}>
          <option value="">{t('chooseProfile')}</option>
          {metadata?.profiles.map(option => <option key={option.key} value={option.key}>{option.label}</option>)}
        </Select>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${id}-reference`}>{t('buyerReference')}</Label>
        <Input id={`${id}-reference`} value={selectedArchive ? selectedArchive.buyerReference ?? '' : reference} maxLength={200} disabled={busy || !!selectedArchive}
          onChange={event => { setReference(event.target.value); setPreview(null); setError(null) }} />
      </div>
      {selectedArchive ? <p className="text-sm text-muted-foreground">{t('archivedHelp')}</p> : <>
        <Button variant="outline" disabled={!profile || busy} onClick={validate}>{busy ? t('working') : t('validate')}</Button>
        {preview?.valid && <p className="text-sm text-emerald-700 dark:text-emerald-400" role="status">{t('valid')}</p>}
      </>}
      {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
      {!!preview?.findings.length && <ul className="space-y-2 text-sm" aria-label={t('findings')}>
        {preview.findings.map((finding, index) => <li key={`${finding.ruleId}-${index}`} className={finding.severity === 'fatal' ? 'text-destructive' : 'text-amber-700 dark:text-amber-400'}>
          <strong>{finding.ruleId}</strong> — {finding.message}
        </li>)}
      </ul>}
      {!selectedArchive && metadata?.canIssue && <Button disabled={busy || !preview?.valid} onClick={issue}>{t('issue')}</Button>}
      {!metadata?.canIssue && <p className="text-sm text-muted-foreground">{t('issueUnavailable')}</p>}
      <Link href="/admin/setup/einvoice-settings" className="block text-sm underline">{t('setup')}</Link>
      {!!metadata?.archives.length && <div className="border-t pt-3 space-y-2">
        <p className="text-sm font-medium">{t('originals')}</p>
        {metadata.archives.map(archive => <a key={archive.id} href={`${base}?issued=${encodeURIComponent(archive.id)}`} download
          className="block text-sm underline" title={`SHA-256 ${archive.sha256}`}>{archive.fileName} · {metadata.profiles.find(option => option.key === archive.profile)?.label ?? archive.profile}</a>)}
      </div>}
    </div>
  </Popover>
}
