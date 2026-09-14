'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import {
  Alert,
  AlertDescription,
  Button,
  Input,
  Label,
  Select,
} from '@openbooks/ui'
import { Plus, Pencil, Trash2 } from 'lucide-react'
import { CodeEditor } from '@/components/code-editor'
import { confirmDialog } from '@/lib/confirm'
import {
  parseNativeExtension,
  type NativeExtension,
} from '@/lib/apps/native-ui'
import type { AppManifest } from '@/lib/apps/manifest'
import type { AppPackageFile } from '@/lib/apps/package-files'

/** Screens use the runtime's schema and the same package file edited in Files. */
export function AppScreens({
  files,
  manifest,
  onFiles,
  onOpen,
  onPendingChange,
}: {
  files: AppPackageFile[]
  manifest: AppManifest
  onFiles: (files: AppPackageFile[]) => void
  onOpen: (path: string) => void
  onPendingChange: (pending: boolean) => void
}) {
  const t = useTranslations('apps.screens')
  const [kind, setKind] = useState('page')
  const [key, setKey] = useState('')
  const [edit, updateEdit] = useState<{ index: number; source: string } | null>(
    null,
  )
  function setEdit(value: { index: number; source: string } | null) {
    updateEdit(value)
    onPendingChange(value !== null)
  }
  const [error, setError] = useState('')
  const entry = files.find((file) => file.path === manifest.frontend.entry)
  let ui: NativeExtension | null = null
  try {
    if (entry) ui = parseNativeExtension(entry.content, manifest)
  } catch {
    /* Open the original source to repair an invalid document. */
  }
  function write(screens: NativeExtension['screens']) {
    const content = JSON.stringify({ screens }, null, 2)
    parseNativeExtension(content, manifest)
    onFiles(
      files.map((file) =>
        file.path === manifest.frontend.entry ? { ...file, content } : file,
      ),
    )
  }
  function add() {
    if (!/^[a-z][a-z0-9-]*$/.test(key)) {
      setError(t('invalidKey'))
      return
    }
    const title = key.replaceAll('-', ' ')
    const screen =
      kind === 'page'
        ? {
            key,
            title,
            kind,
            spec: {
              specVersion: 1,
              layout: 'list',
              header: [{ kind: 'page-header', title }],
              body: [{ kind: 'text', content: title }],
            },
          }
        : kind === 'records'
          ? { key, title, kind, typeKey: key }
          : {
              key,
              title,
              kind: 'action',
              endpoint:
                manifest.endpoints.find((endpoint) => endpoint.method !== 'GET')
                  ?.name ?? key,
              submitLabel: title,
              fields: [
                {
                  id: 'details',
                  fields: [
                    { id: 'name', type: 'text', label: 'Name', required: true },
                  ],
                },
              ],
            }
    setError('')
    setEdit({ index: -1, source: JSON.stringify(screen, null, 2) })
  }
  function apply() {
    if (!edit || !ui) return
    try {
      const candidate: unknown = JSON.parse(edit.source)
      const parsed = parseNativeExtension(
        JSON.stringify({ screens: [candidate] }),
        manifest,
      ).screens[0]!
      const next = [...ui.screens]
      if (edit.index < 0) next.push(parsed)
      else next[edit.index] = parsed
      write(next)
      setEdit(null)
      setKey('')
      setError('')
    } catch (error) {
      setError(error instanceof Error ? error.message : t('invalid'))
    }
  }
  return (
    <section className="space-y-3">
      <h3 className="text-sm font-semibold">{t('title')}</h3>
      <p className="text-sm text-slate-500">{t('help')}</p>
      {ui ? (
        <>
          {ui.screens.map((screen, index) => (
            <div
              key={screen.key}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3 text-sm"
            >
              <span>
                {screen.title} · {t(screen.kind)}
              </span>
              <div className="flex gap-1">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    setEdit({ index, source: JSON.stringify(screen, null, 2) })
                  }
                >
                  <Pencil size={14} />
                  {t('edit')}
                </Button>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  disabled={ui.screens.length === 1}
                  aria-label={t('remove')}
                  onClick={async () => {
                    if (ui && (await confirmDialog(t('removeConfirm')))) {
                      write(ui.screens.filter((_, i) => i !== index))
                      setEdit(null)
                    }
                  }}
                >
                  <Trash2 size={14} />
                </Button>
              </div>
            </div>
          ))}
          <div className="grid items-end gap-2 sm:grid-cols-[1fr_1fr_auto]">
            <div className="space-y-1">
              <Label htmlFor="screen-kind">{t('type')}</Label>
              <Select
                id="screen-kind"
                value={kind}
                onChange={(event) => setKind(event.target.value)}
              >
                {['page', 'records', 'action'].map((value) => (
                  <option key={value} value={value}>
                    {t(value)}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="screen-key">{t('key')}</Label>
              <Input
                id="screen-key"
                value={key}
                onChange={(event) => setKey(event.target.value)}
              />
            </div>
            <Button type="button" variant="outline" onClick={add}>
              <Plus size={16} />
              {t('add')}
            </Button>
          </div>
          {edit ? (
            <div className="space-y-2">
              <CodeEditor
                path="screen.json"
                value={edit.source}
                onChange={(source) => setEdit({ ...edit, source })}
              />
              <div className="flex gap-2">
                <Button type="button" onClick={apply}>
                  {t('apply')}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setEdit(null)
                    setError('')
                  }}
                >
                  {t('cancel')}
                </Button>
              </div>
            </div>
          ) : null}
        </>
      ) : (
        <Alert variant="destructive">
          <AlertDescription>
            {t('invalid')}{' '}
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpen(manifest.frontend.entry)}
            >
              {t('openSource')}
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
    </section>
  )
}
