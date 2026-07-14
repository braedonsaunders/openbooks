'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Badge, Button, Drawer, Input, Label, Textarea } from '@openbooks/ui'
import { confirmDialog } from '@/lib/confirm'
import {
  PERMISSION_GROUPS,
  type CataloguePermission,
} from '@/lib/permissions'

export type RoleRow = {
  id: string
  key: string
  name: string
  description: string | null
  isBuiltIn: boolean
  permissions: string[]
}

export function NewRoleButton() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button onClick={() => setOpen(true)}>New role</Button>
      {open ? <RoleDrawer role={null} onClose={() => setOpen(false)} /> : null}
    </>
  )
}

export function EditRoleButton({ role }: { role: RoleRow }) {
  const [open, setOpen] = useState(false)
  const locked = role.isBuiltIn && role.key === 'admin'
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        {locked ? 'View' : 'Edit'}
      </Button>
      {open ? <RoleDrawer role={role} onClose={() => setOpen(false)} /> : null}
    </>
  )
}

/**
 * Create/edit drawer with the catalogue as grouped checkboxes. Built-in roles
 * allow only permission changes; the built-in Administrator role is read-only
 * (it always carries the full catalogue so an org can't lock itself out).
 */
function RoleDrawer({ role, onClose }: { role: RoleRow | null; onClose: () => void }) {
  const isEdit = role !== null
  const locked = isEdit && role.isBuiltIn && role.key === 'admin'
  const fieldsLocked = isEdit && role.isBuiltIn
  const [name, setName] = useState(role?.name ?? '')
  const [key, setKey] = useState(role?.key ?? '')
  const [keyTouched, setKeyTouched] = useState(isEdit)
  const [description, setDescription] = useState(role?.description ?? '')
  const [selected, setSelected] = useState<Set<string>>(new Set(role?.permissions ?? []))
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

  async function save() {
    if (!isEdit && !name.trim()) {
      toast.error('Role name is required')
      return
    }
    setBusy(true)
    const payload = isEdit
      ? role.isBuiltIn
        ? { id: role.id, permissions: [...selected] }
        : {
            id: role.id,
            name: name.trim(),
            description: description.trim(),
            permissions: [...selected],
          }
      : {
          name: name.trim(),
          key: key.trim() || undefined,
          description: description.trim(),
          permissions: [...selected],
        }
    const res = await fetch('/api/admin/roles', {
      method: isEdit ? 'PATCH' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    setBusy(false)
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      toast.error(data.error ?? 'Saving the role failed')
      return
    }
    toast.success(isEdit ? 'Role updated' : 'Role created')
    onClose()
    router.refresh()
  }

  async function remove() {
    if (!isEdit || role.isBuiltIn) return
    const ok = await confirmDialog({
      message: `Delete the "${role.name}" role? Users holding it lose its permissions immediately.`,
      tone: 'danger',
      confirmLabel: 'Delete role',
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
      toast.error(data.error ?? 'Deleting the role failed')
      return
    }
    toast.success('Role deleted')
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
            {role.isBuiltIn ? <Badge variant="secondary">Built-in</Badge> : null}
          </span>
        ) : (
          'New role'
        )
      }
      description={
        locked
          ? 'The Administrator role always carries every permission and cannot be edited.'
          : fieldsLocked
            ? 'Built-in role: the name and key are fixed, but you can adjust its permissions.'
            : 'Name the role, then pick the permissions it grants.'
      }
      footer={
        <>
          {isEdit && !role.isBuiltIn ? (
            <Button variant="destructive" disabled={busy} onClick={remove} className="mr-auto">
              Delete role
            </Button>
          ) : null}
          <Button variant="outline" disabled={busy} onClick={onClose}>
            {locked ? 'Close' : 'Cancel'}
          </Button>
          {!locked ? (
            <Button disabled={busy} onClick={save}>
              {isEdit ? 'Save changes' : 'Create role'}
            </Button>
          ) : null}
        </>
      }
    >
      <div className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="role-name">Name</Label>
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
              placeholder="AP clerk"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="role-key">Key</Label>
            <Input
              id="role-key"
              value={key}
              disabled={isEdit}
              onChange={(e) => {
                setKeyTouched(true)
                setKey(e.target.value)
              }}
              placeholder="ap_clerk"
              className="font-mono"
            />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="role-description">Description</Label>
          <Textarea
            id="role-description"
            value={description}
            disabled={fieldsLocked}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            placeholder="What is this role for?"
          />
        </div>

        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              Permissions
            </h3>
            <span className="text-xs text-slate-500 dark:text-slate-400">
              {selectedCount} selected
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
                <legend className="sr-only">{group.label}</legend>
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
                    {group.label}
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
                          {perm.label}
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
      </div>
    </Drawer>
  )
}
