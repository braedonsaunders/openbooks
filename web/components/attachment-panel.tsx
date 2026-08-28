'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useSearchParams } from 'next/navigation'
import {
  Download,
  ExternalLink,
  FileImage,
  FileText,
  Loader2,
  Maximize2,
  Minimize2,
  Paperclip,
  Trash2,
  UploadCloud,
} from 'lucide-react'
import { toast } from 'sonner'
import { useTranslations } from 'next-intl'
import { Badge, Button, cn } from '@openbooks/ui'
import { dateTime } from '../lib/format'
import { SearchInput } from './search-input'
import { FilterChips } from './filter-bar'
import { Pagination } from './pagination'
type AttachedFile = {
  id: string
  name: string
  fileType: string
  contentType: string
  sizeBytes: number
  createdAt: string
  createdBy: string | null
  attachmentId: string
};

const MAX_BYTES = 25 * 1024 * 1024
const PAGE_SIZE = 12
const ACCEPT =
  '.pdf,.png,.jpg,.jpeg,.gif,.csv,.xlsx,.docx,.txt,' +
  'application/pdf,image/png,image/jpeg,image/gif,text/csv,text/plain,' +
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,' +
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function previewable(file: AttachedFile): boolean {
  return file.contentType === 'application/pdf' || file.contentType.startsWith('image/')
}

function groupOf(file: AttachedFile): 'pdf' | 'image' | 'other' {
  if (file.contentType === 'application/pdf') return 'pdf'
  if (file.contentType.startsWith('image/')) return 'image'
  return 'other'
}

export function AttachmentPanel({
  targetTable,
  targetId,
  canEdit,
}: {
  targetTable: string
  targetId: string
  canEdit: boolean
}) {
  const t = useTranslations('ui.attachments')
  const tCommon = useTranslations('common')
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [items, setItems] = useState<AttachedFile[]>([])
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(0)
  const [dragOver, setDragOver] = useState(false)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [previewExpanded, setPreviewExpanded] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const loadGeneration = useRef(0)

  const query = (searchParams.get('attq') ?? '').trim().toLocaleLowerCase()
  const group = searchParams.get('atttype') ?? ''
  const parsedPage = Number.parseInt(searchParams.get('attpage') ?? '1', 10)
  const page = Number.isFinite(parsedPage) && parsedPage > 0 ? parsedPage : 1
  const currentParams = useMemo(
    () => Object.fromEntries(searchParams.entries()),
    [searchParams],
  )

  const load = useCallback(async (signal: AbortSignal, generation: number) => {
    setLoading(true)
    try {
      const res = await fetch(
        `/api/file-cabinet/attachments?targetTable=${encodeURIComponent(targetTable)}&targetId=${targetId}`,
        { signal },
      )
      if (!res.ok) throw new Error('load failed')
      const data = (await res.json()) as { attachments: AttachedFile[] }
      if (signal.aborted || generation !== loadGeneration.current) return
      setItems(data.attachments)
      setSelectedId((current) => {
        if (current && data.attachments.some((item) => item.id === current)) return current
        return data.attachments.find(previewable)?.id ?? data.attachments[0]?.id ?? null
      })
    } catch {
      if (signal.aborted || generation !== loadGeneration.current) return
      toast.error(t('loadFailed'))
    } finally {
      if (generation === loadGeneration.current) setLoading(false)
    }
  }, [targetTable, targetId, t])

  useEffect(() => {
    const controller = new AbortController()
    const generation = ++loadGeneration.current
    setItems([])
    setSelectedId(null)
    setPreviewExpanded(false)
    void load(controller.signal, generation)
    return () => {
      controller.abort()
      // Invalidate the request before the next effect starts, including fetch
      // implementations that resolve despite an abort signal.
      if (loadGeneration.current === generation) loadGeneration.current += 1
    }
  }, [load])

  const counts = useMemo(() => ({
    pdf: items.filter((item) => groupOf(item) === 'pdf').length,
    image: items.filter((item) => groupOf(item) === 'image').length,
    other: items.filter((item) => groupOf(item) === 'other').length,
  }), [items])

  const filtered = useMemo(() => items.filter((item) => {
    if (group && groupOf(item) !== group) return false
    return !query || item.name.toLocaleLowerCase().includes(query)
  }), [group, items, query])
  const pageItems = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)
  const selected = items.find((item) => item.id === selectedId) ?? null

  const uploadOne = useCallback(
    async (file: File) => {
      if (file.size > MAX_BYTES) {
        toast.error(t('tooLarge', { name: file.name }))
        return
      }
      const form = new FormData()
      form.append('file', file)
      form.append('targetTable', targetTable)
      form.append('targetId', targetId)
      setUploading((n) => n + 1)
      try {
        const res = await fetch('/api/file-cabinet/attachments', { method: 'POST', body: form })
        if (res.ok) {
          const data = (await res.json()) as { attachment: AttachedFile }
          setItems((prev) => [data.attachment, ...prev])
          setSelectedId(data.attachment.id)
          toast.success(t('attached', { name: file.name }))
        } else {
          const err = (await res.json().catch(() => ({}))) as { error?: string }
          toast.error(err.error ?? t('attachFailed', { name: file.name }))
        }
      } catch {
        toast.error(t('attachFailed', { name: file.name }))
      } finally {
        setUploading((n) => n - 1)
      }
    },
    [targetTable, targetId, t],
  )

  const handleFiles = useCallback(
    (files: FileList | null) => {
      if (!files || files.length === 0) return
      for (const file of Array.from(files)) void uploadOne(file)
    },
    [uploadOne],
  )

  async function remove(attachmentId: string, fileId: string, name: string) {
    setDeleting(attachmentId)
    try {
      const res = await fetch(`/api/file-cabinet/attachments/${attachmentId}`, { method: 'DELETE' })
      if (res.ok) {
        setItems((prev) => prev.filter((item) => item.attachmentId !== attachmentId))
        if (selectedId === fileId) {
          setSelectedId(items.find((item) => item.id !== fileId && previewable(item))?.id ?? null)
          setPreviewExpanded(false)
        }
        toast.success(t('removed', { name }))
      } else {
        const err = (await res.json().catch(() => ({}))) as { error?: string }
        toast.error(err.error ?? t('removeFailed'))
      }
    } catch {
      toast.error(t('removeFailed'))
    } finally {
      setDeleting(null)
    }
  }

  return (
    <div className="min-h-[36rem] p-1">
      <div className={cn('grid gap-4', !previewExpanded && 'xl:grid-cols-[22rem_minmax(0,1fr)]')}>
        {!previewExpanded ? (
          <aside className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-2">
                <span className="grid h-8 w-8 place-items-center rounded-lg bg-teal-50 text-teal-700 dark:bg-teal-950/50 dark:text-teal-300">
                  <Paperclip className="h-4 w-4" />
                </span>
                <div className="min-w-0">
                  <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                    {tCommon('labels.attachments')}
                  </h3>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    {t('fileCount', { count: items.length })}
                  </p>
                </div>
              </div>
              {canEdit ? (
                <Button size="sm" className="h-8 gap-1.5" onClick={() => inputRef.current?.click()}>
                  <UploadCloud className="h-3.5 w-3.5" />
                  {t('addFiles')}
                </Button>
              ) : null}
            </div>

            <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
              <SearchInput
                className="min-w-0 sm:w-full"
                placeholder={t('searchPlaceholder')}
                paramKey="attq"
                pageParamKey="attpage"
              />
              <FilterChips
                basePath={pathname}
                currentParams={currentParams}
                paramKey="atttype"
                pageParamKey="attpage"
                label={t('typeFilter')}
                options={([
                  ['pdf', t('types.pdf'), counts.pdf],
                  ['image', t('types.image'), counts.image],
                  ['other', t('types.other'), counts.other],
                ] as const).map(([value, label, count]) => ({ value, label, count }))}
              />
            </div>

            <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-950">
              {loading ? (
                <div className="flex min-h-40 items-center justify-center gap-2 text-sm text-slate-500 dark:text-slate-400">
                  <Loader2 className="h-4 w-4 animate-spin" /> {tCommon('feedback.loading')}
                </div>
              ) : pageItems.length === 0 ? (
                <div className="flex min-h-40 flex-col items-center justify-center gap-2 px-6 text-center">
                  <Paperclip className="h-7 w-7 text-slate-300 dark:text-slate-700" />
                  <p className="text-sm text-slate-500 dark:text-slate-400">
                    {items.length === 0 ? t('empty') : t('noMatches')}
                  </p>
                </div>
              ) : (
                <div className="divide-y divide-slate-100 dark:divide-slate-800">
                  {pageItems.map((item) => {
                    const active = item.id === selectedId
                    const canPreview = previewable(item)
                    const Icon = item.contentType.startsWith('image/') ? FileImage : FileText
                    return (
                      <div
                        key={item.id}
                        className={cn(
                          'group flex items-center gap-2.5 px-2 py-2 transition-colors',
                          active ? 'bg-teal-50/80 dark:bg-teal-950/35' : 'hover:bg-slate-50 dark:hover:bg-slate-900',
                        )}
                      >
                        <button
                          type="button"
                          disabled={!canPreview}
                          onClick={() => {
                            setSelectedId(item.id)
                            setPreviewExpanded(false)
                          }}
                          className="flex min-w-0 flex-1 items-center gap-2.5 text-left disabled:cursor-default"
                        >
                          <span className={cn(
                            'grid h-9 w-9 shrink-0 place-items-center rounded-lg',
                            active
                              ? 'bg-white text-teal-700 shadow-sm dark:bg-slate-900 dark:text-teal-300'
                              : 'bg-slate-100 text-slate-500 dark:bg-slate-900 dark:text-slate-400',
                          )}>
                            <Icon className="h-4 w-4" />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-medium text-slate-900 dark:text-slate-100" title={item.name}>
                              {item.name}
                            </span>
                            <span className="block truncate text-xs text-slate-500 dark:text-slate-400">
                              {formatSize(item.sizeBytes)} · {dateTime(item.createdAt)}
                            </span>
                          </span>
                        </button>
                        <Button asChild variant="ghost" size="icon" className="h-8 w-8 shrink-0">
                          <a
                            href={`/api/file-cabinet/files/${item.id}/download`}
                            download
                            aria-label={t('downloadAria', { name: item.name })}
                          >
                            <Download className="h-4 w-4" />
                          </a>
                        </Button>
                        {canEdit ? (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 shrink-0 text-slate-400 hover:text-red-600 dark:hover:text-red-400"
                            disabled={deleting === item.attachmentId}
                            onClick={() => remove(item.attachmentId, item.id, item.name)}
                            aria-label={t('removeAria', { name: item.name })}
                          >
                            {deleting === item.attachmentId ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              <Trash2 className="h-4 w-4" />
                            )}
                          </Button>
                        ) : null}
                      </div>
                    )
                  })}
                </div>
              )}
              {!loading && filtered.length > 0 ? (
                <Pagination
                  basePath={pathname}
                  currentParams={currentParams}
                  total={filtered.length}
                  page={page}
                  perPage={PAGE_SIZE}
                  pageParamKey="attpage"
                />
              ) : null}
            </div>

            {canEdit ? (
              <div
                role="button"
                tabIndex={0}
                onClick={() => inputRef.current?.click()}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    inputRef.current?.click()
                  }
                }}
                onDragOver={(event) => {
                  event.preventDefault()
                  setDragOver(true)
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(event) => {
                  event.preventDefault()
                  setDragOver(false)
                  handleFiles(event.dataTransfer.files)
                }}
                className={cn(
                  'flex cursor-pointer items-center justify-center gap-2 rounded-xl border border-dashed px-4 py-4 text-center text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500',
                  dragOver
                    ? 'border-teal-500 bg-teal-50 text-teal-800 dark:bg-teal-950/30 dark:text-teal-200'
                    : 'border-slate-300 bg-slate-50/70 text-slate-600 hover:border-slate-400 dark:border-slate-700 dark:bg-slate-900/40 dark:text-slate-300 dark:hover:border-slate-600',
                )}
              >
                {uploading > 0 ? (
                  <><Loader2 className="h-4 w-4 animate-spin" /> {t('uploading', { count: uploading })}</>
                ) : (
                  <><UploadCloud className="h-4 w-4" /> {t('dropShort')}</>
                )}
              </div>
            ) : null}
          </aside>
        ) : null}

        <section className={cn(
          'overflow-hidden rounded-xl border border-slate-200 bg-slate-100 shadow-sm dark:border-slate-800 dark:bg-slate-950',
          previewExpanded ? 'h-[calc(100dvh-12rem)]' : 'min-h-[36rem] xl:h-[calc(100dvh-15rem)]',
        )}>
          {selected && previewable(selected) ? (
            <div className="flex h-full min-h-0 flex-col">
              <div className="flex h-12 shrink-0 items-center gap-3 border-b border-slate-200 bg-white px-3 dark:border-slate-800 dark:bg-slate-950">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-slate-900 dark:text-slate-100">{selected.name}</p>
                  <p className="text-xs text-slate-500 dark:text-slate-400">{formatSize(selected.sizeBytes)}</p>
                </div>
                <Badge variant="outline">{t(`types.${groupOf(selected)}`)}</Badge>
                <Button asChild variant="ghost" size="icon" className="h-8 w-8">
                  <a
                    href={`/api/file-cabinet/files/${selected.id}/download`}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={t('openAria', { name: selected.name })}
                  >
                    <ExternalLink className="h-4 w-4" />
                  </a>
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  onClick={() => setPreviewExpanded((value) => !value)}
                  aria-label={previewExpanded ? t('restorePreviewAria') : t('expandPreviewAria')}
                >
                  {previewExpanded ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
                </Button>
              </div>
              <div className="min-h-0 flex-1 bg-slate-200/60 p-2 dark:bg-slate-900">
                {selected.contentType === 'application/pdf' ? (
                  <iframe
                    src={`/api/file-cabinet/files/${selected.id}/download#view=FitH`}
                    title={t('previewTitle', { name: selected.name })}
                    className="h-full min-h-[30rem] w-full rounded-lg bg-white shadow-inner"
                  />
                ) : (
                  <div className="grid h-full min-h-[30rem] place-items-center overflow-auto rounded-lg bg-[radial-gradient(circle_at_center,_rgba(148,163,184,0.18)_0,_rgba(148,163,184,0.05)_42%,_transparent_70%)] p-4">
                    {/* Authenticated, same-origin file route; source bytes are never exposed cross-tenant. */}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={`/api/file-cabinet/files/${selected.id}/download`}
                      alt={selected.name}
                      className="max-h-full max-w-full rounded-md object-contain shadow-xl"
                    />
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="flex h-full min-h-[36rem] flex-col items-center justify-center gap-3 px-8 text-center">
              <span className="grid h-14 w-14 place-items-center rounded-2xl bg-white text-slate-400 shadow-sm dark:bg-slate-900 dark:text-slate-500">
                <FileText className="h-6 w-6" />
              </span>
              <div>
                <p className="text-sm font-semibold text-slate-800 dark:text-slate-200">{t('previewEmptyTitle')}</p>
                <p className="mt-1 max-w-sm text-sm text-slate-500 dark:text-slate-400">
                  {selected ? t('previewUnavailable') : t('previewEmptyDescription')}
                </p>
              </div>
            </div>
          )}
        </section>
      </div>

      <input
        ref={inputRef}
        type="file"
        multiple
        accept={ACCEPT}
        className="hidden"
        onChange={(event) => {
          handleFiles(event.target.files)
          event.target.value = ''
        }}
      />
    </div>
  )
}
