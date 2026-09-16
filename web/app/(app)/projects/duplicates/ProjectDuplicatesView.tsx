'use client'

import { useCallback, useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { GitMerge, Play } from 'lucide-react'
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  PageHeader,
} from '@openbooks/ui'

type DuplicateProject = {
  id: string
  code: string | null
  name: string
  customerId: string | null
  status: string
  isActive: boolean
}

type DuplicateGroup = {
  kind: 'source_ref' | 'name_customer' | 'job_number'
  key: string
  projects: DuplicateProject[]
}

type Preview = {
  survivorId: string
  duplicateId: string
  moved: { table: string; rows: number }[]
  customRefs: { table: string; key: string; rows: number }[]
  alreadyMerged: boolean
}

export function ProjectDuplicatesView() {
  const t = useTranslations('projects')
  const [groups, setGroups] = useState<DuplicateGroup[] | null>(null)
  const [survivors, setSurvivors] = useState<Record<string, string>>({})
  const [previews, setPreviews] = useState<Record<string, Preview>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)

  const load = useCallback(async () => {
    const response = await fetch('/api/projects/duplicates')
    if (!response.ok) {
      toast.error(t('duplicates.loadFailed'))
      return
    }
    const payload = (await response.json()) as { groups: DuplicateGroup[] }
    setGroups(payload.groups)
    setPreviews({})
  }, [t])

  useEffect(() => {
    let cancelled = false
    void fetch('/api/projects/duplicates')
      .then((r) => (r.ok ? r.json() : null))
      .then((payload: { groups: DuplicateGroup[] } | null) => {
        if (cancelled) return
        if (!payload) {
          setLoadFailed(true)
          return
        }
        setGroups(payload.groups)
        setPreviews({})
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  async function preview(groupKey: string, survivorId: string, duplicateId: string) {
    setBusy(duplicateId)
    try {
      const response = await fetch(
        `/api/projects/merge?survivorId=${encodeURIComponent(survivorId)}&duplicateId=${encodeURIComponent(duplicateId)}`,
      )
      const payload = (await response.json()) as (Preview & { error?: string })
      if (!response.ok) {
        toast.error(payload.error ?? t('duplicates.previewFailed'))
        return
      }
      setPreviews((current) => ({ ...current, [duplicateId]: payload }))
    } finally {
      setBusy(null)
    }
  }

  async function merge(groupKey: string, survivorId: string, duplicateId: string) {
    setBusy(duplicateId)
    try {
      const response = await fetch('/api/projects/merge', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ survivorId, duplicateId }),
      })
      const payload = (await response.json()) as (Preview & { error?: string })
      if (!response.ok) {
        toast.error(payload.error ?? t('duplicates.mergeFailed'))
        return
      }
      toast.success(t('duplicates.merged'))
      setPreviews((current) => {
        const next = { ...current }
        delete next[duplicateId]
        return next
      })
      await load()
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title={t('duplicates.title')}
        description={t('duplicates.description')}
      />
      {loadFailed ? (
        <p className="text-sm text-red-600">{t('duplicates.loadFailed')}</p>
      ) : groups === null ? (
        <p className="text-sm text-slate-500">{t('duplicates.loading')}</p>
      ) : groups.length === 0 ? (
        <p className="text-sm text-slate-500">{t('duplicates.empty')}</p>
      ) : (
        groups.map((group, index) => {
          const groupKey = `${group.kind}:${group.key}:${index}`
          const survivorId = survivors[groupKey] ?? group.projects[0]?.id ?? ''
          return (
            <Card key={groupKey}>
              <CardHeader>
                <CardTitle>{t(`duplicates.kind.${group.kind}`, { key: group.key })}</CardTitle>
                <CardDescription>{t('duplicates.chooseSurvivor')}</CardDescription>
              </CardHeader>
              <CardContent>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-slate-500">
                      <th className="py-1 pr-2">{t('duplicates.survivor')}</th>
                      <th className="py-1 pr-2">{t('duplicates.code')}</th>
                      <th className="py-1 pr-2">{t('duplicates.name')}</th>
                      <th className="py-1 pr-2">{t('duplicates.status')}</th>
                      <th className="py-1">{t('duplicates.action')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {group.projects.map((project) => {
                      const previewResult = previews[project.id]
                      const movedTotal = previewResult
                        ? previewResult.moved.reduce((sum, item) => sum + item.rows, 0)
                        : null
                      return (
                        <tr key={project.id} className="border-t">
                          <td className="py-1 pr-2">
                            <input
                              type="radio"
                              name={groupKey}
                              checked={survivorId === project.id}
                              onChange={() =>
                                setSurvivors((current) => ({ ...current, [groupKey]: project.id }))
                              }
                              aria-label={t('duplicates.survivor')}
                            />
                          </td>
                          <td className="py-1 pr-2 font-mono">{project.code ?? '—'}</td>
                          <td className="py-1 pr-2">{project.name}</td>
                          <td className="py-1 pr-2">
                            {project.isActive ? (
                              <Badge variant="success">{project.status}</Badge>
                            ) : (
                              <Badge variant="warning">{project.status}</Badge>
                            )}
                          </td>
                          <td className="py-1">
                            {project.id !== survivorId ? (
                              <div className="flex items-center gap-2">
                                <Button
                                  size="sm"
                                  variant="outline"
                                  disabled={busy !== null}
                                  onClick={() => preview(groupKey, survivorId, project.id)}
                                >
                                  {t('duplicates.preview')}
                                </Button>
                                {previewResult && !previewResult.alreadyMerged ? (
                                  <Button
                                    size="sm"
                                    disabled={busy !== null}
                                    onClick={() => merge(groupKey, survivorId, project.id)}
                                  >
                                    <GitMerge size={13} />
                                    {t('duplicates.merge', { count: movedTotal ?? 0 })}
                                  </Button>
                                ) : null}
                                {previewResult ? (
                                  <span className="text-xs text-slate-500">
                                    {previewResult.alreadyMerged
                                      ? t('duplicates.alreadyMerged')
                                      : t('duplicates.moveCount', { count: movedTotal ?? 0 })}
                                  </span>
                                ) : null}
                              </div>
                            ) : (
                              <span className="text-xs text-slate-500">{t('duplicates.kept')}</span>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          )
        })
      )}
      <div className="flex items-center gap-2 text-sm text-slate-500">
        <Play size={13} />
        {t('duplicates.impactNote')}
      </div>
    </div>
  )
}
