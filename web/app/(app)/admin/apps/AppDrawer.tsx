'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import {
  Braces,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  File,
  FileCode2,
  FileImage,
  FileText,
  FilePlus2,
  Folder,
  FolderOpen,
  Palette,
  Plus,
  Trash2,
  Upload,
} from 'lucide-react'
import CodeMirror from '@uiw/react-codemirror'
import { javascript } from '@codemirror/lang-javascript'
import { html } from '@codemirror/lang-html'
import { css } from '@codemirror/lang-css'
import { json } from '@codemirror/lang-json'
import { Badge, Button, Input, Label, Select, Textarea, UrlDrawer, cn } from '@openbooks/ui'
import { promptDialog } from '@/lib/prompt'
import { confirmDialog } from '@/lib/confirm'
import { dateTime } from '@/lib/format'

/**
 * The Apps admin surface: toolbar (New app / Import .zip), the marketplace
 * panel, and the app flyout — Overview (form-driven settings; users never see
 * JSON), Files (a VS Code-style file browser + editor over the app's bundle),
 * and Runs (the backend execution log).
 */

// ---------------------------------------------------------------------------
// Toolbar: New App (scaffold from a name) + Import .zip
// ---------------------------------------------------------------------------

export function AppsToolbar() {
  const router = useRouter()
  const fileRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)

  async function newApp() {
    const name = await promptDialog({ title: 'New app', label: 'App name', placeholder: 'Expense Insights' })
    if (!name) return
    setBusy(true)
    try {
      const res = await fetch('/api/apps/new', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'create failed')
      toast.success(`Created “${name}”`)
      router.push(`/admin/apps?app=${encodeURIComponent(data.key)}`)
      router.refresh()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function importZip(file: globalThis.File) {
    setBusy(true)
    try {
      const form = new FormData()
      form.append('file', file)
      const res = await fetch('/api/apps', { method: 'POST', body: form })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'import failed')
      toast.success(`Imported “${data.key}”`)
      router.push(`/admin/apps?app=${encodeURIComponent(data.key)}`)
      router.refresh()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  return (
    <div className="flex items-center gap-2">
      <input
        ref={fileRef}
        type="file"
        accept=".zip"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) void importZip(f)
        }}
      />
      <Button variant="outline" disabled={busy} onClick={() => fileRef.current?.click()}>
        <Upload size={15} /> Import .zip
      </Button>
      <Button disabled={busy} onClick={newApp}>
        <Plus size={15} /> New app
      </Button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// File tree helpers
// ---------------------------------------------------------------------------

interface FileRow {
  path: string
  kind: 'frontend' | 'backend' | 'asset'
  contentType: string
  isBinary: boolean
  size: number
}

interface TreeFolder {
  name: string
  path: string
  folders: TreeFolder[]
  files: FileRow[]
}

function buildTree(files: FileRow[]): TreeFolder {
  const root: TreeFolder = { name: '', path: '', folders: [], files: [] }
  const folderAt = (segments: string[]): TreeFolder => {
    let node = root
    let prefix = ''
    for (const seg of segments) {
      prefix = prefix ? `${prefix}/${seg}` : seg
      let next = node.folders.find((f) => f.name === seg)
      if (!next) {
        next = { name: seg, path: prefix, folders: [], files: [] }
        node.folders.push(next)
      }
      node = next
    }
    return node
  }
  for (const f of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    const parts = f.path.split('/')
    const dir = folderAt(parts.slice(0, -1))
    dir.files.push(f)
  }
  const sortRec = (n: TreeFolder) => {
    n.folders.sort((a, b) => a.name.localeCompare(b.name))
    n.folders.forEach(sortRec)
  }
  sortRec(root)
  return root
}

function fileIcon(path: string) {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  if (ext === 'js' || ext === 'mjs') return <FileCode2 size={14} className="text-amber-500" />
  if (ext === 'html') return <FileCode2 size={14} className="text-orange-500" />
  if (ext === 'css') return <Palette size={14} className="text-sky-500" />
  if (ext === 'json') return <Braces size={14} className="text-emerald-500" />
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) return <FileImage size={14} className="text-violet-500" />
  if (ext === 'md' || ext === 'txt') return <FileText size={14} className="text-slate-400" />
  return <File size={14} className="text-slate-400" />
}

function editorExtensions(path: string) {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  if (ext === 'js' || ext === 'mjs') return [javascript()]
  if (ext === 'html') return [html()]
  if (ext === 'css') return [css()]
  if (ext === 'json') return [json()]
  return []
}

// ---------------------------------------------------------------------------
// The flyout
// ---------------------------------------------------------------------------

const TABS = ['overview', 'files', 'runs'] as const
type Tab = (typeof TABS)[number]
const TAB_LABELS: Record<Tab, string> = { overview: 'Overview', files: 'Files', runs: 'Runs' }

const CAPABILITIES: { key: string; label: string; help: string }[] = [
  { key: 'records.read', label: 'Read custom records', help: 'Let this app read your custom records' },
  { key: 'gl.post', label: 'Create & post journals', help: 'Let this app create and post journal entries' },
]

interface AppDetail {
  key: string
  name: string
  description: string | null
  iconKey: string
  status: 'installed' | 'disabled'
  showInNav: boolean
  grantedPermissions: string[]
  version: string | null
  manifest: {
    frontend?: { entry: string }
    endpoints?: { name: string; file: string; method: 'GET' | 'POST' | 'ANY' }[]
  } | null
}

interface RunRow {
  endpoint: string
  status: string
  units: number
  logs: string[]
  error_message: string | null
  duration_ms: number | null
  at: string
}

export function AppDrawer({
  app,
  files,
  runs,
  isPublished,
}: {
  app: AppDetail
  files: FileRow[]
  runs: RunRow[]
  isPublished: boolean
}) {
  const router = useRouter()
  const [tab, setTab] = useState<Tab>('overview')
  const [busy, setBusy] = useState(false)

  // -- Overview form state ---------------------------------------------------
  const [name, setName] = useState(app.name)
  const [description, setDescription] = useState(app.description ?? '')
  const [showInNav, setShowInNav] = useState(app.showInNav)
  const [granted, setGranted] = useState<Set<string>>(new Set(app.grantedPermissions))
  const [endpoints, setEndpoints] = useState<{ name: string; file: string; method: 'GET' | 'POST' | 'ANY' }[]>(
    app.manifest?.endpoints ?? [],
  )
  const dirtyMeta =
    name !== app.name ||
    description !== (app.description ?? '') ||
    showInNav !== app.showInNav ||
    JSON.stringify([...granted].sort()) !== JSON.stringify([...app.grantedPermissions].sort()) ||
    JSON.stringify(endpoints) !== JSON.stringify(app.manifest?.endpoints ?? [])

  async function saveMeta() {
    setBusy(true)
    const res = await fetch(`/api/apps/${encodeURIComponent(app.key)}/meta`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name,
        description: description || null,
        showInNav,
        grantedPermissions: [...granted],
        endpoints,
      }),
    })
    const data = await res.json().catch(() => ({}))
    if (res.ok) {
      toast.success('App settings saved')
      router.refresh()
    } else toast.error(data.error || 'Save failed')
    setBusy(false)
  }

  async function setStatus(status: 'installed' | 'disabled') {
    const res = await fetch(`/api/apps/${encodeURIComponent(app.key)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status }),
    })
    if (res.ok) {
      toast.success(status === 'disabled' ? 'App disabled' : 'App enabled')
      router.refresh()
    } else toast.error('Update failed')
  }

  async function publish() {
    const res = await fetch('/api/apps/marketplace', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'publish', key: app.key }),
    })
    const data = await res.json().catch(() => ({}))
    if (res.ok) {
      toast.success('Published to the marketplace')
      router.refresh()
    } else toast.error(data.error || 'Publish failed')
  }

  async function uninstall() {
    const ok = await confirmDialog({
      title: `Uninstall “${app.name}”?`,
      message: 'Removes the app, its files, storage, and run history. Provisioned record types are kept.',
      confirmLabel: 'Uninstall',
      tone: 'danger',
    })
    if (!ok) return
    const res = await fetch(`/api/apps/${encodeURIComponent(app.key)}`, { method: 'DELETE' })
    if (res.ok) {
      toast.success('Uninstalled')
      router.push('/admin/apps')
      router.refresh()
    } else toast.error('Uninstall failed')
  }

  // -- Files state -------------------------------------------------------------
  const tree = useMemo(() => buildTree(files), [files])
  const [selected, setSelected] = useState<string | null>(files.find((f) => !f.isBinary)?.path ?? null)
  const [openDirs, setOpenDirs] = useState<Set<string>>(() => new Set(tree.folders.map((f) => f.path)))
  const [content, setContent] = useState<string>('')
  const [loadedPath, setLoadedPath] = useState<string | null>(null)
  const [fileDirty, setFileDirty] = useState(false)
  const [savingFile, setSavingFile] = useState(false)
  const uploadRef = useRef<HTMLInputElement>(null)
  const selectedRow = files.find((f) => f.path === selected) ?? null

  useEffect(() => {
    let cancelled = false
    if (!selected || selectedRow?.isBinary) {
      setLoadedPath(null)
      return
    }
    setLoadedPath(null)
    fetch(`/api/apps/${encodeURIComponent(app.key)}/files/${selected.split('/').map(encodeURIComponent).join('/')}`)
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'load failed')
        return r.json()
      })
      .then((d) => {
        if (cancelled) return
        setContent(d.file.content)
        setLoadedPath(selected)
        setFileDirty(false)
      })
      .catch((e) => !cancelled && toast.error((e as Error).message))
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, app.key])

  async function saveFile() {
    if (!loadedPath) return
    setSavingFile(true)
    const res = await fetch(
      `/api/apps/${encodeURIComponent(app.key)}/files/${loadedPath.split('/').map(encodeURIComponent).join('/')}`,
      { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content }) },
    )
    const data = await res.json().catch(() => ({}))
    if (res.ok) {
      setFileDirty(false)
      toast.success(`Saved ${loadedPath}`)
      router.refresh()
    } else toast.error(data.error || 'Save failed')
    setSavingFile(false)
  }

  const selectedDir = selected ? selected.split('/').slice(0, -1).join('/') : ''

  async function newFile() {
    const suggestion = selectedDir ? `${selectedDir}/` : 'frontend/'
    const path = await promptDialog({ title: 'New file', label: 'Path', initialValue: suggestion })
    if (!path) return
    const res = await fetch(`/api/apps/${encodeURIComponent(app.key)}/files`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path, content: '' }),
    })
    const data = await res.json().catch(() => ({}))
    if (res.ok) {
      toast.success(`Created ${path}`)
      setSelected(path)
      router.refresh()
    } else toast.error(data.error || 'Create failed')
  }

  async function uploadFile(file: globalThis.File) {
    const form = new FormData()
    form.append('file', file)
    form.append('dir', selectedDir)
    const res = await fetch(`/api/apps/${encodeURIComponent(app.key)}/files`, { method: 'POST', body: form })
    const data = await res.json().catch(() => ({}))
    if (res.ok) {
      toast.success(`Uploaded ${data.path}`)
      router.refresh()
    } else toast.error(data.error || 'Upload failed')
    if (uploadRef.current) uploadRef.current.value = ''
  }

  async function deleteFile() {
    if (!selected) return
    const ok = await confirmDialog({ message: `Delete ${selected}?`, confirmLabel: 'Delete', tone: 'danger' })
    if (!ok) return
    const res = await fetch(
      `/api/apps/${encodeURIComponent(app.key)}/files/${selected.split('/').map(encodeURIComponent).join('/')}`,
      { method: 'DELETE' },
    )
    const data = await res.json().catch(() => ({}))
    if (res.ok) {
      toast.success('Deleted')
      setSelected(null)
      router.refresh()
    } else toast.error(data.error || 'Delete failed')
  }

  function toggleDir(path: string) {
    setOpenDirs((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  function renderFolder(node: TreeFolder, depth: number) {
    return (
      <div key={node.path || 'root'}>
        {node.path ? (
          <button
            type="button"
            onClick={() => toggleDir(node.path)}
            className="flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-[13px] text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
            style={{ paddingLeft: `${depth * 14 + 8}px` }}
          >
            {openDirs.has(node.path) ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            {openDirs.has(node.path) ? (
              <FolderOpen size={14} className="text-teal-600 dark:text-teal-400" />
            ) : (
              <Folder size={14} className="text-teal-600 dark:text-teal-400" />
            )}
            <span className="truncate">{node.name}</span>
          </button>
        ) : null}
        {(!node.path || openDirs.has(node.path)) && (
          <>
            {node.folders.map((f) => renderFolder(f, depth + (node.path ? 1 : 0)))}
            {node.files.map((f) => (
              <button
                key={f.path}
                type="button"
                onClick={() => setSelected(f.path)}
                className={cn(
                  'flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-[13px] transition-colors',
                  selected === f.path
                    ? 'bg-teal-50 text-teal-800 dark:bg-teal-950/50 dark:text-teal-200'
                    : 'text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800',
                )}
                style={{ paddingLeft: `${(depth + (node.path ? 1 : 0)) * 14 + 26}px` }}
              >
                {fileIcon(f.path)}
                <span className="truncate">{f.path.split('/').pop()}</span>
              </button>
            ))}
          </>
        )}
      </div>
    )
  }

  return (
    <UrlDrawer
      open
      closeHref="/admin/apps"
      size="xl"
      title={app.name}
      description={`${app.key}${app.version ? ` · v${app.version}` : ''}`}
      headerActions={
        <>
          {app.status === 'installed' && (
            <Button asChild variant="outline" size="sm">
              <Link href={`/apps/${encodeURIComponent(app.key)}`}>
                <ExternalLink size={14} /> Open
              </Link>
            </Button>
          )}
          {tab === 'overview' && (
            <Button size="sm" disabled={busy || !dirtyMeta || !name.trim()} onClick={saveMeta}>
              {busy ? 'Saving…' : 'Save settings'}
            </Button>
          )}
          {tab === 'files' && (
            <Button size="sm" disabled={savingFile || !fileDirty || !loadedPath} onClick={saveFile}>
              {savingFile ? 'Saving…' : fileDirty ? 'Save file' : 'Saved'}
            </Button>
          )}
        </>
      }
    >
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex shrink-0 gap-1 border-b border-slate-200 px-1 dark:border-slate-800">
          {TABS.map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setTab(k)}
              className={cn(
                '-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors',
                tab === k
                  ? 'border-teal-500 text-teal-700 dark:text-teal-300'
                  : 'border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200',
              )}
            >
              {TAB_LABELS[k]}
              {k === 'runs' && runs.length > 0 ? (
                <span className="ml-1.5 rounded-full bg-slate-100 px-1.5 text-[11px] text-slate-500 dark:bg-slate-800">
                  {runs.length}
                </span>
              ) : null}
            </button>
          ))}
        </div>

        <div key={tab} className="min-h-0 flex-1 overflow-y-auto p-1 pt-4">
          {tab === 'overview' ? (
            <div className="space-y-6">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label>Name</Label>
                  <Input value={name} onChange={(e) => setName(e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label>Status</Label>
                  <div className="flex items-center gap-2 pt-1.5">
                    <Badge variant={app.status === 'installed' ? 'success' : 'outline'}>{app.status}</Badge>
                    {isPublished && <Badge variant="secondary">on marketplace</Badge>}
                  </div>
                </div>
                <div className="space-y-1.5 sm:col-span-2">
                  <Label>Description</Label>
                  <Textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
                </div>
              </div>

              <div className="space-y-2">
                <Label>Capabilities</Label>
                <p className="text-xs text-slate-500">
                  Everything else is denied by default; the app's backend and bridge calls are checked against these
                  grants (always intersected with the calling user's own permissions).
                </p>
                <div className="space-y-2 rounded-lg border border-slate-200 p-3 dark:border-slate-800">
                  {CAPABILITIES.map((c) => (
                    <label key={c.key} className="flex items-start gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={granted.has(c.key)}
                        onChange={(e) =>
                          setGranted((prev) => {
                            const next = new Set(prev)
                            if (e.target.checked) next.add(c.key)
                            else next.delete(c.key)
                            return next
                          })
                        }
                        className="mt-0.5 h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500"
                      />
                      <span>
                        {c.label} <span className="text-xs text-slate-400">— {c.help}</span>
                      </span>
                    </label>
                  ))}
                  <label className="flex items-start gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={showInNav}
                      onChange={(e) => setShowInNav(e.target.checked)}
                      className="mt-0.5 h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500"
                    />
                    <span>
                      Show in navigation <span className="text-xs text-slate-400">— list this app on the Apps page</span>
                    </span>
                  </label>
                </div>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label>Backend endpoints</Label>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      setEndpoints((prev) => [
                        ...prev,
                        { name: `endpoint-${prev.length + 1}`, file: files.find((f) => f.kind === 'backend')?.path ?? 'backend/hello.js', method: 'ANY' },
                      ])
                    }
                  >
                    <Plus size={14} /> Add endpoint
                  </Button>
                </div>
                <p className="text-xs text-slate-500">
                  The frontend calls these with <code>openbooks.callBackend(name, payload)</code>; each runs its file's{' '}
                  <code>handler(request)</code> in the sandbox.
                </p>
                {endpoints.length === 0 ? (
                  <p className="rounded-lg border border-dashed border-slate-200 p-4 text-sm text-slate-500 dark:border-slate-800">
                    No endpoints — this app is frontend-only.
                  </p>
                ) : (
                  <div className="space-y-2">
                    {endpoints.map((e, i) => (
                      <div key={i} className="flex items-center gap-2">
                        <Input
                          value={e.name}
                          onChange={(ev) =>
                            setEndpoints((prev) => prev.map((x, j) => (j === i ? { ...x, name: ev.target.value } : x)))
                          }
                          className="w-40 font-mono text-[13px]"
                          placeholder="name"
                        />
                        <Select
                          value={e.file}
                          onChange={(ev) =>
                            setEndpoints((prev) => prev.map((x, j) => (j === i ? { ...x, file: ev.target.value } : x)))
                          }
                          className="min-w-0 flex-1 font-mono text-[13px]"
                        >
                          {files
                            .filter((f) => !f.isBinary)
                            .map((f) => (
                              <option key={f.path} value={f.path}>
                                {f.path}
                              </option>
                            ))}
                        </Select>
                        <Select
                          value={e.method}
                          onChange={(ev) =>
                            setEndpoints((prev) =>
                              prev.map((x, j) => (j === i ? { ...x, method: ev.target.value as 'GET' | 'POST' | 'ANY' } : x)),
                            )
                          }
                          className="w-24"
                        >
                          <option value="ANY">ANY</option>
                          <option value="GET">GET</option>
                          <option value="POST">POST</option>
                        </Select>
                        <Button size="sm" variant="ghost" onClick={() => setEndpoints((prev) => prev.filter((_, j) => j !== i))}>
                          <Trash2 size={14} />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-2 border-t border-slate-200 pt-4 dark:border-slate-800">
                <Button variant="outline" size="sm" onClick={publish}>
                  {isPublished ? 'Republish to marketplace' : 'Publish to marketplace'}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setStatus(app.status === 'installed' ? 'disabled' : 'installed')}>
                  {app.status === 'installed' ? 'Disable' : 'Enable'}
                </Button>
                <Button variant="ghost" size="sm" className="text-red-600 hover:text-red-700 dark:text-red-400" onClick={uninstall}>
                  <Trash2 size={14} /> Uninstall
                </Button>
              </div>
            </div>
          ) : null}

          {tab === 'files' ? (
            <div className="flex h-[calc(100vh-16rem)] min-h-[420px] overflow-hidden rounded-lg border border-slate-200 dark:border-slate-800">
              {/* Tree pane */}
              <div className="flex w-60 shrink-0 flex-col border-r border-slate-200 bg-slate-50/60 dark:border-slate-800 dark:bg-slate-900/40">
                <div className="flex items-center gap-1 border-b border-slate-200 px-2 py-1.5 dark:border-slate-800">
                  <input
                    ref={uploadRef}
                    type="file"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0]
                      if (f) void uploadFile(f)
                    }}
                  />
                  <Button size="sm" variant="ghost" title="New file" onClick={newFile}>
                    <FilePlus2 size={14} />
                  </Button>
                  <Button size="sm" variant="ghost" title="Upload file" onClick={() => uploadRef.current?.click()}>
                    <Upload size={14} />
                  </Button>
                  <Button size="sm" variant="ghost" title="Delete file" disabled={!selected} onClick={deleteFile}>
                    <Trash2 size={14} />
                  </Button>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto p-1">{renderFolder(tree, 0)}</div>
              </div>

              {/* Editor pane */}
              <div className="min-w-0 flex-1 bg-white dark:bg-slate-950">
                {!selected ? (
                  <div className="grid h-full place-items-center text-sm text-slate-400">Select a file to edit.</div>
                ) : selectedRow?.isBinary ? (
                  <div className="grid h-full place-items-center">
                    <div className="text-center text-sm text-slate-500">
                      <FileImage size={32} className="mx-auto mb-2 text-slate-300" />
                      <p className="font-mono text-xs">{selected}</p>
                      <p className="mt-1 text-xs">Binary file · {selectedRow.contentType} · {selectedRow.size.toLocaleString()} bytes</p>
                    </div>
                  </div>
                ) : loadedPath !== selected ? (
                  <div className="grid h-full place-items-center text-sm text-slate-400">Loading…</div>
                ) : (
                  <div className="flex h-full flex-col">
                    <div className="flex shrink-0 items-center justify-between border-b border-slate-200 px-3 py-1.5 dark:border-slate-800">
                      <span className="font-mono text-xs text-slate-500">
                        {selected}
                        {fileDirty ? <span className="ml-1 text-amber-500">●</span> : null}
                      </span>
                      <span className="text-[11px] text-slate-400">{selectedRow?.kind}</span>
                    </div>
                    <div className="min-h-0 flex-1 overflow-auto">
                      <CodeMirror
                        value={content}
                        onChange={(v) => {
                          setContent(v)
                          setFileDirty(true)
                        }}
                        extensions={editorExtensions(selected)}
                        theme="dark"
                        height="100%"
                        basicSetup={{ lineNumbers: true, foldGutter: true, autocompletion: true }}
                        onKeyDown={(e) => {
                          if ((e.metaKey || e.ctrlKey) && e.key === 's') {
                            e.preventDefault()
                            void saveFile()
                          }
                        }}
                      />
                    </div>
                  </div>
                )}
              </div>
            </div>
          ) : null}

          {tab === 'runs' ? (
            runs.length === 0 ? (
              <p className="rounded-lg border border-dashed border-slate-200 p-6 text-sm text-slate-500 dark:border-slate-800">
                No runs yet — the backend has never been called.
              </p>
            ) : (
              <div className="divide-y divide-slate-100 rounded-lg border border-slate-200 dark:divide-slate-800 dark:border-slate-800">
                {runs.map((r, i) => (
                  <div key={i} className="flex items-start gap-3 px-3 py-2 text-sm">
                    <Badge variant={r.status === 'ok' ? 'success' : 'destructive'}>{r.status}</Badge>
                    <div className="min-w-0 flex-1">
                      <p className="text-xs text-slate-500 dark:text-slate-400">
                        {dateTime(r.at)} · <code>{r.endpoint}</code> · {r.units} units · {r.duration_ms}ms
                      </p>
                      {r.error_message ? (
                        <p className="text-xs text-red-600 dark:text-red-400">{r.error_message}</p>
                      ) : null}
                      {Array.isArray(r.logs) && r.logs.length > 0 ? (
                        <pre className="mt-1 overflow-x-auto font-mono text-[11px] text-slate-600 dark:text-slate-300">
                          {r.logs.join('\n')}
                        </pre>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            )
          ) : null}
        </div>
      </div>
    </UrlDrawer>
  )
}
