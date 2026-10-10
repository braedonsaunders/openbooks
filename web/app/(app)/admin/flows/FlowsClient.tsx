'use client'

import { useRef, useState } from 'react'
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from 'next-intl'
import { Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button, Drawer, Input, Label, SearchSelect, Select, cn } from '@openbooks/ui'
import { ApiResponseError, apiJson } from '../../../../lib/api-error'
import { confirmDialog } from '../../../../lib/confirm'

/**
 * Client bits of the flows list: the New Flow drawer (name + subject kind
 * from the profiles API) and per-row enable/delete controls.
 */

type ProfileOption = { subjectKind: string; label?: string; labelKey?: string; group?: string; supportsUngatedSubmission?: boolean }

export function NewFlowButton() {
  const t = useTranslations('admin.flows')
  const tSubjects = useTranslations('customization.recordTypes')
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const params = useSearchParams();
  const [subjectKind, setSubjectKind] = useState(params.get("subject") ?? "");
  const [ungatedOutcome, setUngatedOutcome] = useState<"apply" | undefined>();
  const [weekdayPreset, setWeekdayPreset] = useState(false);
  const [profiles, setProfiles] = useState<ProfileOption[] | null>(null)
  const [busy, setBusy] = useState(false)
  const supportsDirect =
    profiles?.find((profile) => profile.subjectKind === subjectKind)
      ?.supportsUngatedSubmission === true;

  function openDrawer() {
    setOpen(true)
    if (profiles === null) {
      fetch('/api/admin/flows/profiles')
        .then((r) => (r.ok ? r.json() : { profiles: [] }))
        .then((d) =>
          setProfiles(
            (d.profiles ?? []).map((p: ProfileOption) => ({
              subjectKind: p.subjectKind,
              label: p.label,
              labelKey: p.labelKey,
              group: p.group,
              supportsUngatedSubmission: p.supportsUngatedSubmission,
            })),
          ),
        )
        .catch(() => setProfiles([]))
    }
  }

  async function create() {
    setBusy(true)
    try {
      const data = await apiJson<{ id: string }>(
        '/api/admin/flows',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: name.trim(),
            subjectKind,
            ...(subjectKind === "schedule_board" && params.get("board")
              ? {
                  boardId: params.get("board"),
                  ...(weekdayPreset
                    ? { schedulePreset: "weekday-morning-afternoon" }
                    : {}),
                }
              : {}),
            ...(supportsDirect && ungatedOutcome ? { ungatedOutcome } : {}),
          }),
        },
        t('new.failed'),
      )
      router.push(`/admin/flows/${data.id}`)
    } catch (error) {
      toast.error(error instanceof ApiResponseError ? error.message : t('new.failed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Button onClick={openDrawer}>
        <Plus size={15} /> {t('new.button')}
      </Button>
      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        size="sm"
        title={t('new.title')}
        description={t('new.description')}
        footer={
          <div className="flex w-full justify-end gap-2">
            <Button disabled={busy || !name.trim() || !subjectKind} onClick={create}>
              {t('new.create')}
            </Button>
          </div>
        }
      >
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>{t('new.name')}</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('new.namePlaceholder')}
              autoFocus
            />
          </div>
          {subjectKind === "schedule_board" && params.get("board") ? (
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={weekdayPreset}
                onChange={(event) => setWeekdayPreset(event.target.checked)}
              />
              {t("new.scheduleWeekdayPreset")}
            </label>
          ) : null}
          <div className="space-y-1.5">
            <Label>{t('new.subject')}</Label>
            <SearchSelect
              value={subjectKind}
              options={(profiles ?? [])
                .map((p) => {
                  const groupKey = `new.groups.${p.group ?? 'other'}` as const
                  return {
                    value: p.subjectKind,
                    label: p.labelKey && tSubjects.has(p.labelKey as never)
                      ? tSubjects(p.labelKey as never)
                      : (p.label ?? p.subjectKind),
                    // Unknown future groups fall back to Other so the picker
                    // never renders an ungrouped row.
                    group: t.has(groupKey as never) ? t(groupKey as never) : t('new.groups.other'),
                  }
                })
                .sort((a, b) => a.group.localeCompare(b.group) || a.label.localeCompare(b.label))}
              placeholder={t('new.subjectPlaceholder')}
              loading={profiles === null}
              onChange={(value) => { setSubjectKind(value); setUngatedOutcome(undefined) }}
            />
          </div>
          {supportsDirect && (
            <div className="space-y-1.5">
              <Label htmlFor="new-flow-ungated">
                {t("builder.ungatedOutcomeLabel")}
              </Label>
            <Select id="new-flow-ungated" value={ungatedOutcome ?? ''} onChange={(event) => setUngatedOutcome(event.target.value === 'apply' ? 'apply' : undefined)}>
              <option value="">{t('builder.ungatedRequireApproval')}</option>
              <option value="apply">{t('builder.ungatedApply')}</option>
            </Select>
            </div>
          )}
        </div>
      </Drawer>
    </>
  )
}

export function FlowRowActions({
  id,
  name,
  enabled,
  updatedAt,
}: {
  id: string
  name: string
  enabled: boolean
  updatedAt: string
}) {
  const t = useTranslations('admin.flows')
  const router = useRouter()
  const [isEnabled, setIsEnabled] = useState(enabled)
  const [revision, setRevision] = useState(updatedAt)
  const [busy, setBusy] = useState(false)
  const saving = useRef(false)

  async function toggle() {
    if (saving.current) return
    saving.current = true
    setBusy(true)
    const next = !isEnabled
    try {
      const data = await apiJson<{ updatedAt: string }>(
        `/api/admin/flows/${id}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: next, expectedUpdatedAt: revision }),
        },
        t('actions.updateFailed'),
      )
      setIsEnabled(next)
      setRevision(data.updatedAt)
      router.refresh()
    } catch (error) {
      toast.error(error instanceof ApiResponseError ? error.message : t('actions.updateFailed'))
    } finally {
      saving.current = false
      setBusy(false)
    }
  }

  async function remove() {
    if (saving.current) return
    saving.current = true
    setBusy(true)
    try {
      const ok = await confirmDialog({
        title: t('actions.deleteConfirmTitle'),
        message: t('actions.deleteConfirm', { name }),
        confirmLabel: t('actions.delete'),
        tone: 'danger',
      })
      if (!ok) return
      await apiJson<unknown>(
        `/api/admin/flows/${id}`,
        {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ expectedUpdatedAt: revision }),
        },
        t('actions.deleteFailed'),
      )
      toast.success(t('actions.deleted'))
      router.refresh()
    } catch (error) {
      toast.error(error instanceof ApiResponseError ? error.message : t('actions.deleteFailed'))
    } finally {
      saving.current = false
      setBusy(false)
    }
  }

  return (
    <div className="flex items-center justify-end gap-2">
      <button
        type="button"
        role="switch"
        disabled={busy}
        aria-checked={isEnabled}
        title={isEnabled ? t('actions.disable') : t('actions.enable')}
        onClick={toggle}
        className={cn(
          'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition',
          isEnabled ? 'bg-teal-500' : 'bg-slate-300 dark:bg-slate-600',
        )}
      >
        <span
          className={cn(
            'inline-block h-4 w-4 transform rounded-full bg-white shadow transition',
            isEnabled ? 'translate-x-4' : 'translate-x-0.5',
          )}
        />
      </button>
      <button
        type="button"
        title={t('actions.delete')}
        disabled={busy}
        onClick={remove}
        className="rounded p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950 dark:hover:text-red-400"
      >
        <Trash2 size={15} />
      </button>
    </div>
  )
}
