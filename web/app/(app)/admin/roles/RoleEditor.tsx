'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Badge, Button, Drawer, Input, Label, SearchSelect, Select, Textarea } from '@openbooks/ui'
import { confirmDialog } from '@/lib/confirm'
import {
  PERMISSION_GROUPS,
  type CataloguePermission,
} from '@/lib/permissions'
import type { SubsidiaryRestriction } from '@openbooks/schema'

export type RoleRow = {
  id: string
  key: string
  name: string
  description: string | null
  isBuiltIn: boolean
  permissions: string[]
  subsidiaryRestriction: SubsidiaryRestriction
}

/** Depth-first subsidiary tree flattened for pickers (subsidiaryOptions()). */
export type SubsidiaryPickerOption = { id: string; name: string; depth: number }

export function NewRoleButton({ subsidiaries }: { subsidiaries: SubsidiaryPickerOption[] | null }) {
  const t = useTranslations('admin.roles')
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button onClick={() => setOpen(true)}>{t('newRole')}</Button>
      {open ? (
        <RoleDrawer role={null} subsidiaries={subsidiaries} onClose={() => setOpen(false)} />
      ) : null}
    </>
  )
}

export function EditRoleButton({
  role,
  subsidiaries,
}: {
  role: RoleRow
  subsidiaries: SubsidiaryPickerOption[] | null
}) {
  const tCommon = useTranslations('common')
  const [open, setOpen] = useState(false)
  const locked = role.isBuiltIn && role.key === 'admin'
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        {locked ? tCommon('actions.view') : tCommon('actions.edit')}
      </Button>
      {open ? (
        <RoleDrawer role={role} subsidiaries={subsidiaries} onClose={() => setOpen(false)} />
      ) : null}
    </>
  )
}

/**
 * Create/edit drawer with the catalogue as grouped checkboxes. Built-in roles
 * allow only permission changes; the built-in Administrator role is read-only
 * (it always carries the full catalogue so an org can't lock itself out).
 */
function RoleDrawer({
  role,
  subsidiaries,
  onClose,
}: {
  role: RoleRow | null
  /** null = single-subsidiary org: the whole subsidiary-access section is hidden. */
  subsidiaries: SubsidiaryPickerOption[] | null
  onClose: () => void
}) {
  const t = useTranslations('admin.roles')
  const tCommon = useTranslations('common')
  // Permission group/label keys in PERMISSION_GROUPS are relative to `admin`.
  const tAdmin = useTranslations('admin')
  const isEdit = role !== null
  const locked = isEdit && role.isBuiltIn && role.key === 'admin'
  const fieldsLocked = isEdit && role.isBuiltIn
  const [name, setName] = useState(role?.name ?? '')
  const [key, setKey] = useState(role?.key ?? '')
  const [keyTouched, setKeyTouched] = useState(isEdit)
  const [description, setDescription] = useState(role?.description ?? '')
  const [selected, setSelected] = useState<Set<string>>(new Set(role?.permissions ?? []))
  const restriction = role?.subsidiaryRestriction ?? { mode: 'all' as const }
  const [subMode, setSubMode] = useState<SubsidiaryRestriction['mode']>(restriction.mode)
  const [subtreeId, setSubtreeId] = useState(
    restriction.mode === 'subtree' ? restriction.subsidiaryId : '',
  )
  const [subList, setSubList] = useState<Set<string>>(
    new Set(restriction.mode === 'list' ? restriction.subsidiaryIds : []),
  )
  const [busy, setBusy] = useState(false)
  const router = useRouter()

  const selectedCount = useMemo(
    () =>
      PERMISSION_GROUPS.reduce(
        (n, g) => n + g.permissions.filter((p) => selected.has(p.key)).length,
        0,
      ),
    [selected],
  )

  function togglePermission(permKey: CataloguePermission) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(permKey)) next.delete(permKey)
      else next.add(permKey)
      return next
    })
  }

  function toggleGroup(groupKey: string) {
    const group = PERMISSION_GROUPS.find((g) => g.key === groupKey)
    if (!group) return
    setSelected((prev) => {
      const next = new Set(prev)
      const allOn = group.permissions.every((p) => next.has(p.key))
      for (const p of group.permissions) {
        if (allOn) next.delete(p.key)
        else next.add(p.key)
      }
      return next
    })
  }

  /** The restriction the form currently describes, or a validation error. */
  function buildRestriction(): SubsidiaryRestriction | { error: string } {
    if (subMode === 'subtree') {
      if (!subtreeId) return { error: t('drawer.subsidiaryRequired') }
      return { mode: 'subtree', subsidiaryId: subtreeId }
    }
    if (subMode === 'list') {
      if (subList.size === 0) return { error: t('drawer.subsidiaryListRequired') }
      return { mode: 'list', subsidiaryIds: [...subList] }
    }
    return { mode: 'all' }
  }

  async function save() {
    if (!isEdit && !name.trim()) {
      toast.error(t('drawer.nameRequired'))
      return
    }
    // Only multi-subsidiary orgs (subsidiaries != null) send a restriction.
    let subsidiaryRestriction: SubsidiaryRestriction | undefined
    if (subsidiaries) {
      const built = buildRestriction()
      if ('error' in built) {
        toast.error(built.error)
        return
      }
      subsidiaryRestriction = built
    }
    setBusy(true)
    const payload = isEdit
      ? role.isBuiltIn
        ? { id: role.id, permissions: [...selected], subsidiaryRestriction }
        : {
            id: role.id,
            name: name.trim(),
            description: description.trim(),
            permissions: [...selected],
            subsidiaryRestriction,
          }
      : {
          name: name.trim(),
          key: key.trim() || undefined,
          description: description.trim(),
          permissions: [...selected],
          subsidiaryRestriction,
        }
    const res = await fetch('/api/admin/roles', {
      method: isEdit ? 'PATCH' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    setBusy(false)
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      toast.error(data.error ?? t('drawer.saveFailed'))
      return
    }
    toast.success(isEdit ? t('drawer.updated') : t('drawer.created'))
    onClose()
    router.refresh()
  }

  async function remove() {
    if (!isEdit || role.isBuiltIn) return
    const ok = await confirmDialog({
      message: t('drawer.deleteConfirm', { name: role.name }),
      tone: 'danger',
      confirmLabel: t('drawer.deleteRole'),
    })
    if (!ok) return
    setBusy(true)
    const res = await fetch('/api/admin/roles', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: role.id }),
    })
    setBusy(false)
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      toast.error(data.error ?? t('drawer.deleteFailed'))
      return
    }
    toast.success(t('drawer.deleted'))
    onClose()
    router.refresh()
  }

  return (
    <Drawer
      open
      onClose={onClose}
      size="lg"
      title={
        isEdit ? (
          <span className="inline-flex items-center gap-2">
            {role.name}
            {role.isBuiltIn ? <Badge variant="secondary">{t('builtIn')}</Badge> : null}
          </span>
        ) : (
          t('drawer.newTitle')
        )
      }
      description={
        locked
          ? t('drawer.lockedDescription')
          : fieldsLocked
            ? t('drawer.builtInDescription')
            : t('drawer.newDescription')
      }
      headerActions={
        <>
          {isEdit && !role.isBuiltIn ? (
            <Button variant="destructive" disabled={busy} onClick={remove} className="mr-auto">
              {t('drawer.deleteRole')}
            </Button>
          ) : null}
          <Button variant="outline" disabled={busy} onClick={onClose}>
            {locked ? tCommon('actions.close') : tCommon('actions.cancel')}
          </Button>
          {!locked ? (
            <Button disabled={busy} onClick={save}>
              {isEdit ? t('drawer.saveChanges') : t('drawer.createRole')}
            </Button>
          ) : null}
        </>
      }
    >
      <div className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="role-name">{tCommon('labels.name')}</Label>
            <Input
              id="role-name"
              value={name}
              disabled={fieldsLocked}
              onChange={(e) => {
                setName(e.target.value)
                if (!keyTouched) {
                  setKey(
                    e.target.value
                      .toLowerCase()
                      .replace(/[^a-z0-9]+/g, '_')
                      .replace(/^_+|_+$/g, '')
                      .slice(0, 64),
                  )
                }
              }}
              placeholder={t('drawer.namePlaceholder')}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="role-key">{t('table.key')}</Label>
            <Input
              id="role-key"
              value={key}
              disabled={isEdit}
              onChange={(e) => {
                setKeyTouched(true)
                setKey(e.target.value)
              }}
              placeholder={t('drawer.keyPlaceholder')}
              className="font-mono"
            />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="role-description">{tCommon('labels.description')}</Label>
          <Textarea
            id="role-description"
            value={description}
            disabled={fieldsLocked}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            placeholder={t('drawer.descriptionPlaceholder')}
          />
        </div>

        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              {t('drawer.permissionsHeading')}
            </h3>
            <span className="text-xs text-slate-500 dark:text-slate-400">
              {t('drawer.selectedCount', { count: selectedCount })}
            </span>
          </div>
          {PERMISSION_GROUPS.map((group) => {
            const allOn = group.permissions.every((p) => selected.has(p.key))
            const someOn = group.permissions.some((p) => selected.has(p.key))
            return (
              <fieldset
                key={group.key}
                className="rounded-lg border border-slate-200 dark:border-slate-800"
              >
                <legend className="sr-only">{tAdmin(group.labelKey)}</legend>
                <label className="flex cursor-pointer items-center gap-2.5 border-b border-slate-100 bg-slate-50/60 px-3 py-2 dark:border-slate-800 dark:bg-slate-900/60">
                  <input
                    type="checkbox"
                    checked={allOn}
                    ref={(el) => {
                      if (el) el.indeterminate = !allOn && someOn
                    }}
                    disabled={locked}
                    onChange={() => toggleGroup(group.key)}
                    className="h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500 dark:border-slate-600 dark:bg-slate-800"
                  />
                  <span className="text-sm font-medium text-slate-900 dark:text-slate-100">
                    {tAdmin(group.labelKey)}
                  </span>
                </label>
                <div className="grid gap-x-4 px-3 py-2 sm:grid-cols-2">
                  {group.permissions.map((perm) => (
                    <label
                      key={perm.key}
                      className="flex cursor-pointer items-start gap-2.5 py-1.5"
                    >
                      <input
                        type="checkbox"
                        checked={selected.has(perm.key)}
                        disabled={locked}
                        onChange={() => togglePermission(perm.key)}
                        className="mt-0.5 h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500 dark:border-slate-600 dark:bg-slate-800"
                      />
                      <span className="min-w-0">
                        <span className="block text-sm text-slate-800 dark:text-slate-200">
                          {tAdmin(perm.labelKey)}
                        </span>
                        <span className="block font-mono text-[11px] text-slate-400 dark:text-slate-500">
                          {perm.key}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>
            )
          })}
        </div>

        {subsidiaries ? (
          <div className="space-y-3">
            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              {t('drawer.subsidiaryHeading')}
            </h3>
            <Select
              value={subMode}
              disabled={locked}
              onChange={(e) => setSubMode(e.target.value as SubsidiaryRestriction['mode'])}
            >
              <option value="all">{t('drawer.subsidiaryModeAll')}</option>
              <option value="subtree">{t('drawer.subsidiaryModeSubtree')}</option>
              <option value="list">{t('drawer.subsidiaryModeList')}</option>
            </Select>
            {subMode === 'subtree' ? (
              <SearchSelect
                value={subtreeId}
                onChange={setSubtreeId}
                options={subsidiaries.map((s) => ({
                  value: s.id,
                  label: `${'— '.repeat(s.depth)}${s.name}`,
                }))}
                placeholder={t('drawer.subsidiaryPlaceholder')}
                searchPlaceholder={t('drawer.subsidiarySearchPlaceholder')}
                sheetTitle={t('drawer.subsidiaryHeading')}
                ariaLabel={t('drawer.subsidiaryHeading')}
              />
            ) : null}
            {subMode === 'list' ? (
              <div className="rounded-lg border border-slate-200 px-3 py-2 dark:border-slate-800">
                {subsidiaries.map((s) => (
                  <label key={s.id} className="flex cursor-pointer items-center gap-2.5 py-1.5">
                    <input
                      type="checkbox"
                      checked={subList.has(s.id)}
                      disabled={locked}
                      onChange={(e) =>
                        setSubList((prev) => {
                          const next = new Set(prev)
                          if (e.target.checked) next.add(s.id)
                          else next.delete(s.id)
                          return next
                        })
                      }
                      className="h-4 w-4 rounded border-slate-300 text-teal-600 focus:ring-teal-500 dark:border-slate-600 dark:bg-slate-800"
                    />
                    <span
                      className="text-sm text-slate-800 dark:text-slate-200"
                      style={{ paddingLeft: `${s.depth * 16}px` }}
                    >
                      {s.name}
                    </span>
                  </label>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </Drawer>
  )
}
