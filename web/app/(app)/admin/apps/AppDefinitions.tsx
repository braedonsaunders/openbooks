'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import {
  Button,
  Input,
  Label,
  Select,
  Alert,
  AlertDescription,
} from '@openbooks/ui'
import { Plus, Pencil, Trash2 } from 'lucide-react'
import { CodeEditor } from '@/components/code-editor'
import type { AppManifest } from '@/lib/apps/manifest'
import type { AppPackageFile } from '@/lib/apps/package-files'
import {
  extensionContributionsSchema,
  EXTENSION_CONTRIBUTION_PERMISSIONS,
} from '@/lib/apps/contributions'
import { readApiErrorMessage } from '@/lib/api-error'
import { confirmDialog } from '@/lib/confirm'

/** Definitions remain the canonical package objects; the editor never creates tables directly. */
export function AppDefinitions({
  files,
  manifest,
  onFiles,
  onManifest,
  onOpen,
  onPendingChange,
}: {
  files: AppPackageFile[]
  manifest: AppManifest
  onFiles: (files: AppPackageFile[]) => void
  onManifest: (patch: Partial<AppManifest>) => void
  onOpen: (path: string) => void
  onPendingChange: (pending: boolean) => void
}) {
  const t = useTranslations('apps.definitions')
  function setEdit(value: { index: number; source: string } | null) {
    updateEdit(value)
    onPendingChange(value !== null)
  }
  const [error, setError] = useState('')
  const [routes, setRoutes] = useState<string[]>([])
  const [route, setRoute] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    void fetch('/api/apps/vocabulary', { signal: controller.signal })
      .then(async (response) => {
        // Status first: a non-JSON refusal must surface the API message (or
        // status fallback), never a SyntaxError from response.json().
        if (!response.ok)
          throw new Error(await readApiErrorMessage(response, t('invalid')))
        const data = await response.json()
        setRoutes(data.routes)
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setError(error instanceof Error ? error.message : t('invalid'))
      })
    return () => controller.abort()
  }, [t])
  const [kind, setKind] = useState('record_type')
  const [key, setKey] = useState('')
  const [edit, updateEdit] = useState<{ index: number; source: string } | null>(
    null,
  )
  function add() {
    setError('')
    if (!/^[a-z][a-z0-9-]*$/.test(key)) {
      setError(t('invalidKey'))
      return
    }
    const title = key.replaceAll('-', ' ')
    if (kind === 'page' && !routes.includes(route)) {
      setError(t('chooseRoute'))
      return
    }
    if (kind === 'record_type' || kind === 'custom_field') {
      const path = `objects/${key}.json`
      if (files.some((file) => file.path === path)) {
        setError(t('duplicate'))
        return
      }
      const definition =
        kind === 'record_type'
          ? {
              type: kind,
              key,
              name: title,
              pluralName: title,
              showInNav: true,
              fields: [
                {
                  id: 'details',
                  fields: [
                    { id: 'name', type: 'text', label: 'Name', required: true },
                  ],
                },
              ],
            }
          : {
              type: kind,
              targetTable: 'parties',
              key: key.replaceAll('-', '_'),
              label: title,
              fieldType: 'text',
              config: {},
              isRequired: false,
            }
      onFiles([
        ...files,
        { path, content: JSON.stringify(definition, null, 2) },
      ])
      onOpen(path)
      setKey('')
      return
    }
    const definition =
      kind === 'page'
        ? {
            kind,
            route,
            scope: 'org',
            spec: {
              specVersion: 1,
              route,
              layout: 'list',
              header: [{ kind: 'page-header', title }],
              body: [{ kind: 'text', content: title }],
            },
          }
        : kind === 'nav'
          ? {
              kind,
              href: `/apps/${manifest.key}`,
              label: title,
              group: 'my-work',
              iconKey: 'grid',
              sortOrder: 0,
            }
          : kind === 'permission'
            ? {
                kind,
                key: `${manifest.key.replaceAll('-', '_')}.${key.replaceAll('-', '_')}`,
                label: title,
              }
            : {
                kind: 'setting',
                key: key.replaceAll('-', '_'),
                label: title,
                valueType: 'string',
                defaultValue: '',
              }
    setEdit({ index: -1, source: JSON.stringify(definition, null, 2) })
  }
  function apply() {
    if (!edit) return
    try {
      const contribution: unknown = JSON.parse(edit.source)
      const next = [...(manifest.contributions ?? [])]
      const parsed = extensionContributionsSchema.parse([contribution])[0]!
      if (edit.index < 0) next.push(parsed)
      else next[edit.index] = parsed
      extensionContributionsSchema.parse(next)
      const permission = EXTENSION_CONTRIBUTION_PERMISSIONS[parsed.kind]
      onManifest({
        contributions: next,
        permissions: [...new Set([...manifest.permissions, permission])],
      })
      setEdit(null)
      setError('')
      setKey('')
    } catch (error) {
      setError(error instanceof Error ? error.message : t('invalid'))
    }
  }
  return (
    <section className="space-y-3">
      <h3 className="text-sm font-semibold">{t('title')}</h3>
      <p className="text-sm text-slate-500">{t('help')}</p>
      <div className="space-y-2">
        {files
          .filter((file) => /^objects\/[^/]+\.json$/.test(file.path))
          .map((file) => (
            <div
              key={file.path}
              className="flex items-center justify-between gap-2 rounded-lg border p-3 text-sm"
            >
              <span className="break-all">{file.path}</span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => onOpen(file.path)}
              >
                <Pencil size={14} />
                {t('edit')}
              </Button>
            </div>
          ))}
        {(manifest.contributions ?? []).map((item, index) => (
          <div
            key={index}
            className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3 text-sm"
          >
            <span>
              {t(item.kind)} · {item.kind === 'page' ? item.route : item.label}
            </span>
            <div className="flex gap-1">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setError('')
                  setEdit({ index, source: JSON.stringify(item, null, 2) })
                }}
              >
                <Pencil size={14} />
                {t('edit')}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={t('remove')}
                onClick={async () => {
                  if (await confirmDialog(t('removeConfirm')))
                    onManifest({
                      contributions: manifest.contributions?.filter(
                        (_, i) => i !== index,
                      ),
                    })
                }}
              >
                <Trash2 size={14} />
              </Button>
            </div>
          </div>
        ))}
      </div>
      <div className="grid items-end gap-2 sm:grid-cols-[1fr_1fr_auto]">
        <div className="space-y-1">
          <Label htmlFor="definition-type">{t('type')}</Label>
          <Select
            id="definition-type"
            value={kind}
            onChange={(event) => setKind(event.target.value)}
          >
            {[
              'record_type',
              'custom_field',
              'page',
              'nav',
              'setting',
              'permission',
            ].map((value) => (
              <option key={value} value={value}>
                {t(value)}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="definition-key">{t('key')}</Label>
          <Input
            id="definition-key"
            value={key}
            onChange={(event) => setKey(event.target.value)}
          />
        </div>
        <Button type="button" variant="outline" onClick={add}>
          <Plus size={16} />
          {t('add')}
        </Button>
      </div>
      {kind === 'page' ? (
        <div className="space-y-1">
          <Label htmlFor="contribution-route">{t('route')}</Label>
          <Select
            id="contribution-route"
            value={route}
            onChange={(event) => setRoute(event.target.value)}
          >
            <option value="">{t('chooseRoute')}</option>
            {routes.map((value) => (
              <option key={value}>{value}</option>
            ))}
          </Select>
          <p className="text-xs text-slate-500">{t('pageHelp')}</p>
        </div>
      ) : null}
      {edit ? (
        <div className="space-y-2">
          <CodeEditor
            path="definition.json"
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
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
    </section>
  )
}
