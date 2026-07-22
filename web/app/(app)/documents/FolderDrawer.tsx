'use client'

import { useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Download, Loader2, Trash2 } from 'lucide-react'
import { Button, Input, Label, Select, UrlDrawer } from '@openbooks/ui'
import { confirmDialog } from '../../../lib/confirm'
import { SharePanel } from './SharePanel'
import { ActivityLog } from './ActivityLog'
import { DrawerTabs, type DrawerTab } from './DrawerTabs'

interface TreeFolder {
  id: string
  name: string
  parentId: string | null
  isSystem: boolean
  systemKind: string | null
  isPrivate: boolean
  isInactive: boolean
  recordTable: string | null
  recordId: string | null
  childCount: number
  fileCount: number
}

function buildPath(folders: TreeFolder[], id: string): string {
  const map = new Map(folders.map((f) => [f.id, f]))
  const parts: string[] = []
  let current = map.get(id)
  while (current) {
    parts.unshift(current.name)
    current = current.parentId ? map.get(current.parentId) : undefined
  }
  return parts.join(' / ')
}

export function FolderDrawer({
  mode,
  folder,
  folders,
  parentId,
  canManage,
}: {
  mode: 'create' | 'edit'
  folder?: TreeFolder
  folders: TreeFolder[]
  parentId?: string
  canManage?: boolean
}) {
  const t = useTranslations('documents.folder')
  const tt = useTranslations('documents.toasts')
  const tc = useTranslations('common')
  const router = useRouter()
  const search = useSearchParams()

  const [name, setName] = useState(folder?.name ?? '')
  const [parent, setParent] = useState(folder?.parentId ?? parentId ?? '')
  const [isPrivate, setIsPrivate] = useState(folder?.isPrivate ?? false)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)

  // Subtabs (existing folders only) — Details / Sharing / Activity.
  const tabs: DrawerTab[] = [
    { key: 'details', label: t('tabs.details') },
    ...(canManage ? [{ key: 'sharing', label: t('tabs.sharing') }] : []),
    { key: 'activity', label: t('tabs.activity') },
  ]
  const initialTab = search.get('folderTab') ?? 'details'
  const [tab, setTab] = useState(tabs.some((x) => x.key === initialTab) ? initialTab : 'details')

  // source platform-style record model: an EXISTING folder ALWAYS opens READ-ONLY
  // (view mode) with an Edit button in the header; Save/Cancel replace it while
  // editing. The create variant is a plain creation form (footer submit).
  const [uiMode, setUiMode] = useState<'view' | 'edit'>(mode === 'create' ? 'edit' : 'view')
  const editing = uiMode === 'edit'

  function cancelEdit() {
    setName(folder?.name ?? '')
    setParent(folder?.parentId ?? parentId ?? '')
    setIsPrivate(folder?.isPrivate ?? false)
    setUiMode('view')
  }

  function closeHref(): string {
    const params = new URLSearchParams(search.toString())
    params.delete('folder')
    const qs = params.toString()
    return qs ? `/documents?${qs}` : '/documents'
  }

  // Folders available as move targets (exclude self + descendants for edit mode)
  function availableParents(): { id: string; path: string }[] {
    if (mode === 'create') {
      return folders
        .filter((f) => !f.isInactive)
        .map((f) => ({ id: f.id, path: buildPath(folders, f.id) }))
    }
    // Edit mode: exclude self and descendants
    const excluded = new Set<string>([folder!.id])
    let changed = true
    while (changed) {
      changed = false
      for (const f of folders) {
        if (f.parentId && excluded.has(f.parentId) && !excluded.has(f.id)) {
          excluded.add(f.id)
          changed = true
        }
      }
    }
    return folders
      .filter((f) => !excluded.has(f.id) && !f.isInactive)
      .map((f) => ({ id: f.id, path: buildPath(folders, f.id) }))
  }

  async function handleSave() {
    if (!name.trim()) return
    setSaving(true)
    try {
      if (mode === 'create') {
        const res = await fetch('/api/file-cabinet/folders', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: name.trim(),
            parentId: parent || null,
            isPrivate,
          }),
        })
        if (res.ok) {
          toast.success(tt('folderCreated'))
          router.push(closeHref())
          router.refresh()
        } else {
          toast.error(tt('folderCreateFailed'))
        }
      } else if (folder) {
        const body: Record<string, any> = {
          name: name.trim(),
          parentId: parent || null,
          isPrivate,
        }
        const res = await fetch(`/api/file-cabinet/folders/${folder.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        if (res.ok) {
          toast.success(tt('folderRenamed'))
          setUiMode('view')
          router.refresh()
        } else {
          toast.error(tt('folderRenameFailed'))
        }
      }
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete() {
    if (!folder) return
    if (!(await confirmDialog({ title: t('delete.title'), message: t('delete.body'), tone: 'danger' }))) return
    setDeleting(true)
    try {
      const res = await fetch(`/api/file-cabinet/folders/${folder.id}`, { method: 'DELETE' })
      if (res.ok) {
        toast.success(tt('folderDeleted'))
        router.push(closeHref())
        router.refresh()
      } else {
        const err = (await res.json().catch(() => ({}))) as { error?: string }
        toast.error(err.error ?? tt('folderDeleteFailed'))
      }
    } finally {
      setDeleting(false)
    }
  }

  const isSystem = folder?.isSystem ?? false
  const title = mode === 'create' ? t('create.title') : t('edit.title')

  return (
    <UrlDrawer
      open
      closeHref={closeHref()}
      title={title}
      size="md"
      subtabs={
        mode === 'edit' ? <DrawerTabs tabs={tabs} active={tab} onSelect={setTab} /> : undefined
      }
      headerActions={
        mode === 'edit' ? (
          editing ? (
            <div className="flex items-center gap-2">
              <Button disabled={saving || !name.trim()} onClick={handleSave}>
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                {tc('actions.save')}
              </Button>
              <Button variant="outline" disabled={saving} onClick={cancelEdit}>
                {tc('actions.cancel')}
              </Button>
            </div>
          ) : canManage && !isSystem ? (
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                onClick={() => {
                  setTab('details')
                  setUiMode('edit')
                }}
              >
                {tc('actions.edit')}
              </Button>
              <Button variant="ghost" size="icon" disabled={deleting} onClick={handleDelete}>
                {deleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
              </Button>
            </div>
          ) : null
        ) : null
      }
      footer={
        mode === 'create' ? (
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => router.push(closeHref())}>
              {tc('actions.cancel')}
            </Button>
            <Button disabled={saving || !name.trim()} onClick={handleSave}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {t('create.submit')}
            </Button>
          </div>
        ) : undefined
      }
    >
      <div className="space-y-4">
        {/* DETAILS TAB (also the whole body in create mode) */}
        {mode === 'create' || tab === 'details' ? (
          <>
            {isSystem ? (
              <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-950/30 dark:text-amber-400">
                {t('systemNoDelete')}
              </p>
            ) : null}

            <div className="space-y-1.5">
              <Label htmlFor="folder-name">{t('edit.nameLabel')}</Label>
              {editing ? (
                <Input
                  id="folder-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={t('create.namePlaceholder')}
                  disabled={isSystem}
                  autoFocus={mode === 'create'}
                />
              ) : (
                <p className="text-sm">{name || '—'}</p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="folder-parent">{t('edit.parentLabel')}</Label>
              {editing ? (
                <Select
                  id="folder-parent"
                  value={parent}
                  onChange={(e) => setParent(e.target.value)}
                  disabled={isSystem}
                >
                  <option value="">—</option>
                  {availableParents().map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.path}
                    </option>
                  ))}
                </Select>
              ) : (
                <p className="text-sm">{parent ? buildPath(folders, parent) : '—'}</p>
              )}
            </div>

            {mode === 'edit' && !isSystem ? (
              <label className="flex items-start gap-2">
                <input
                  type="checkbox"
                  checked={isPrivate}
                  onChange={(e) => setIsPrivate(e.target.checked)}
                  disabled={!editing}
                  className="mt-0.5 h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500"
                />
                <div>
                  <span className="text-sm font-medium text-slate-900 dark:text-slate-100">
                    {t('edit.private')}
                  </span>
                  <p className="text-xs text-slate-500 dark:text-slate-400">{t('edit.privateHint')}</p>
                </div>
              </label>
            ) : null}

            {/* Download the whole folder */}
            {mode === 'edit' && folder ? (
              <div className="pt-2">
                <Button variant="outline" size="sm" asChild>
                  <a href={`/api/file-cabinet/folders/${folder.id}/download-zip`}>
                    <Download className="h-4 w-4" />
                    {t('downloadZip')}
                  </a>
                </Button>
              </div>
            ) : null}
          </>
        ) : null}

        {/* SHARING TAB — Manager access only */}
        {mode === 'edit' && tab === 'sharing' && folder && canManage ? (
          <SharePanel resourceType="folder" resourceId={folder.id} />
        ) : null}

        {/* ACTIVITY TAB */}
        {mode === 'edit' && tab === 'activity' && folder ? (
          <ActivityLog resourceType="folder" resourceId={folder.id} />
        ) : null}
      </div>
    </UrlDrawer>
  )
}
