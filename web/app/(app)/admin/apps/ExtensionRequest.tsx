'use client'

import Link from 'next/link'
import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import {
  Alert,
  AlertDescription,
  Button,
  Label,
  Textarea,
  UrlDrawer,
} from '@openbooks/ui'
import { Code2, Sparkles, Upload, LayoutTemplate } from 'lucide-react'
import { AppPackageEditor } from './AppPackageEditor'
import { readApiErrorMessage } from '@/lib/api-error'
import { confirmDialog } from '@/lib/confirm'
import { createAppStarter } from '@/lib/apps/starter'
import type { EditableAppPackage } from '@/lib/apps/package-files'

export function ExtensionRequest() {
  const t = useTranslations('admin.extensions.request')
  const ui = useTranslations('apps.create')
  const router = useRouter()
  const upload = useRef<HTMLInputElement>(null)
  const [dirty, setDirty] = useState(false)
  const [brief, setBrief] = useState('')
  const [bundle, setBundle] = useState<EditableAppPackage | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function importPackage(file?: File) {
    if (!file) return
    setBusy(true)
    setError('')
    try {
      if (file.size > 10 * 1024 * 1024) throw new Error(ui('tooLarge'))
      const response = file.name.toLowerCase().endsWith('.zip')
        ? await fetch('/api/apps/import', {
            method: 'POST',
            headers: { 'Content-Type': 'application/zip' },
            body: file,
          })
        : await fetch('/api/apps/drafts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              action: 'draft',
              bundle: JSON.parse(await file.text()),
              reason: ui('importReason'),
            }),
          })
      // Status first: a non-JSON 413/415/500 from ZIP or draft import must
      // surface the refusal (or fallback + status), never a SyntaxError.
      if (!response.ok)
        throw new Error(await readApiErrorMessage(response, ui('failed')))
      const data = await response.json()
      router.push(data.reviewUrl)
      router.refresh()
    } catch (error) {
      setError(error instanceof Error ? error.message : ui('failed'))
    } finally {
      setBusy(false)
    }
  }
  return (
    <UrlDrawer
      open
      closeHref="/admin/apps"
      size="2xl"
      title={ui('title')}
      beforeClose={() => !dirty || confirmDialog(ui('discardEdits'))}
    >
      {bundle ? (
        <AppPackageEditor
          bundle={bundle}
          baseVersionId={null}
          onDirtyChange={setDirty}
        />
      ) : (
        <div className="w-full min-w-0 space-y-6">
          <form
            className="w-full space-y-4"
            onSubmit={(event) => {
              event.preventDefault()
              if (brief.trim())
                router.push(
                  `/assistant?q=${encodeURIComponent(`${t('agentInstruction')}\n\n${brief.trim()}`)}`,
                )
            }}
          >
            <p className="text-sm text-slate-500">{t('help')}</p>
            <div className="w-full space-y-2">
              <Label htmlFor="app-build-brief">{t('brief')}</Label>
              <Textarea
                id="app-build-brief"
                className="w-full"
                rows={6}
                maxLength={4000}
                value={brief}
                onChange={(event) => setBrief(event.target.value)}
                placeholder={t('placeholder')}
              />
            </div>
            <Button type="submit" disabled={!brief.trim()}>
              <Sparkles size={16} />
              {t('start')}
            </Button>
          </form>
          <section className="space-y-3 border-t pt-5">
            <h3 className="text-sm font-semibold">{ui('ownPackage')}</h3>
            <p className="text-sm text-slate-500">{ui('help')}</p>
            <div className="flex flex-wrap gap-3">
              <Button
                type="button"
                variant="outline"
                onClick={() => setBundle(createAppStarter('native'))}
              >
                <LayoutTemplate size={16} />
                {ui('native')}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => setBundle(createAppStarter('sandbox'))}
              >
                <Code2 size={16} />
                {ui('files')}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => upload.current?.click()}
              >
                <Upload size={16} />
                {busy ? ui('importing') : ui('import')}
              </Button>
              <input
                ref={upload}
                type="file"
                accept=".zip,.json"
                className="hidden"
                onChange={(event) => {
                  void importPackage(event.target.files?.[0])
                  event.target.value = ''
                }}
              />
            </div>
          </section>
          {error ? (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          <p className="text-sm text-slate-500">
            {t('reviewHelp')}{' '}
            <Link className="underline" href="/docs/app-authoring">
              {t('agentHelp')}
            </Link>
          </p>
        </div>
      )}
    </UrlDrawer>
  )
}
