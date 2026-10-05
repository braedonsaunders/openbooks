'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import {
  Button,
  Card,
  Input,
  Label,
  SearchSelect,
  Select,
  Table as SharedTable,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@openbooks/ui'
import { ActionError, kindForStatus, transportError } from '@braedonsaunders/appkit-errors'
import { DrawerTabStrip } from '../../../components/drawer-tab-strip'
import { useAppAction } from '@/lib/use-app-action'
import { confirmDialog } from '@/lib/confirm'
import { toast } from 'sonner'

type Relationship = {
  id: string
  billToPartyId: string
  billToName: string
  payerPartyId: string
  payerName: string
  groupId: string | null
  groupCode: string | null
  groupName: string | null
  effectiveFrom: string
  effectiveTo: string | null
}

type ChildRow = {
  childPartyId: string
  childName: string
  billToPartyId: string
  payerPartyId: string
  effectiveFrom: string
  effectiveTo: string | null
  groupCode: string | null
}

type Group = {
  id: string
  code: string
  name: string
  payerPartyId: string
  cadence: 'weekly' | 'monthly'
  cutoffDay: number
  grouping: 'by_child' | 'by_subscription' | 'by_product'
  billingSubsidiaryName: string | null
}

type Summary = {
  billToPartyId: string
  billToName: string
  payerPartyId: string
  payerName: string
  consolidationGroupId: string | null
  groupCode: string | null
  groupName: string | null
  groupCadence: string | null
}

type Payload = {
  summary: Summary
  relationships: Relationship[]
  children: ChildRow[]
  groups: Group[]
  parties: { id: string; name: string }[]
  canManage: boolean
}

type Draft = {
  id?: string
  billTo: string
  payer: string
  group: string
  from: string
  to: string
}

const EMPTY_DRAFT: Draft = { billTo: '', payer: '', group: '', from: '', to: '' }

const GROUPING_KEYS = {
  by_child: 'byChild',
  by_subscription: 'bySubscription',
  by_product: 'byProduct',
} as const

/**
 * Customer drawer Billing tab: who the invoices go to, who owns the
 * receivable, and the effective-dated edges between them. Everyday state is
 * the summary line; the child accounts, the relationship rows with their
 * form, and the consolidation mechanics each ride their own sub-tab, so no
 * two concept tables share a body. Every body stays mounted, so an open
 * draft survives switching.
 */
export function BillingRelationshipsSection({
  partyId,
  editable,
}: {
  partyId: string
  editable: boolean
}) {
  const t = useTranslations('parties.billingRelationships')
  const tc = useTranslations('common')
  const ta = useTranslations('admin')
  const [payload, setPayload] = useState<Payload | null>(null)
  const [hidden, setHidden] = useState(false)
  const [loadError, setLoadError] = useState(false)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [panel, setPanel] = useState<'children' | 'relationships' | 'groups'>('relationships')
  const { busy, execute } = useAppAction()
  const loadGeneration = useRef(0)

  async function relationshipAction(url: string, init: RequestInit) {
    try {
      const res = await fetch(url, init)
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { errorCode?: unknown; error?: unknown }
        const code = typeof body.errorCode === 'string' ? body.errorCode : 'save'
        const serverMessage = typeof body.error === 'string' && body.error ? body.error : t('errors.save')
        return {
          ok: false as const,
          error: new ActionError({
            kind: kindForStatus(res.status),
            status: res.status,
            code,
            serverMessage: t.has(`errors.${code}` as never) ? t(`errors.${code}` as never) : serverMessage,
          }),
        }
      }
      return { ok: true as const, status: res.status, data: await res.json().catch(() => ({})) }
    } catch (err) {
      return { ok: false as const, error: transportError(err instanceof Error ? err.message : String(err)) }
    }
  }

  const load = useCallback(async () => {
    const generation = ++loadGeneration.current
    try {
      const res = await fetch(`/api/billing-relationships?childPartyId=${encodeURIComponent(partyId)}`)
      if (generation !== loadGeneration.current) return
      // A refused read is a refused tab, not stale data: an unconfigured
      // feature answers 404 and a missing grant 403, and neither may render
      // the previous customer's billing here.
      if (res.status === 403 || res.status === 404) {
        setPayload(null)
        setHidden(true)
        setLoadError(false)
        return
      }
      if (!res.ok) throw new Error('billing relationships could not be loaded')
      const data = (await res.json()) as Payload
      if (generation !== loadGeneration.current) return
      setPayload(data)
      setHidden(false)
      setLoadError(false)
    } catch {
      if (generation === loadGeneration.current) setLoadError(true)
    }
  }, [partyId])

  useEffect(() => {
    // Deferred like the pricing section's load: setting state synchronously
    // in the effect body trips the hooks lint and a second fetch on
    // party switches would race the first without the generation guard.
    const timer = window.setTimeout(() => void load(), 0)
    return () => window.clearTimeout(timer)
  }, [load])

  const canManage = editable && (payload?.canManage ?? false)

  // A read-only viewer must never hold the form open. Adjusted during render
  // (same committed value, no extra render).
  if (!canManage && draft !== null) setDraft(null)
  // A panel whose rows just emptied falls back to relationships, so the
  // strip never strands the reader on a hollow body.
  if (payload && panel === 'children' && payload.children.length === 0) setPanel('relationships')
  if (payload && panel === 'groups' && payload.groups.length === 0) setPanel('relationships')

  // A refused read hides the panel rather than rendering another
  // customer's billing; any other load failure says so in plain language.
  if (hidden) return null
  if (loadError || !payload) {
    return loadError ? <p className="text-sm text-destructive">{t('loadFailed')}</p> : null
  }

  const { summary } = payload
  const consolidated = summary.consolidationGroupId != null
  const partyOptions = payload.parties.map((p) => ({ value: p.id, label: p.name }))
  const partyName = (id: string) => payload.parties.find((p) => p.id === id)?.name ?? id

  const save = async () => {
    if (!draft) return
    const wasEdit = draft.id != null
    const fallbackMessage = t('errors.save')
    await execute(() => relationshipAction('/api/billing-relationships', {
      method: draft.id ? 'PATCH' : 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...(draft.id ? { id: draft.id } : {}),
        childPartyId: partyId,
        billToPartyId: draft.billTo,
        payerPartyId: draft.payer,
        effectiveFrom: draft.from,
        effectiveTo: draft.to || null,
        consolidationGroupId: draft.group || null,
      }),
    }), {
      fallbackMessage,
      onRefused: (err) => setError(err.displayMessage(fallbackMessage)),
      onOk: () => {
        setDraft(null)
        setError(null)
        toast.success(t(wasEdit ? 'updated' : 'created'))
        load()
      },
    })
  }

  const remove = (row: Relationship) => {
    confirmDialog({
      title: t('confirmTitle'),
      message: t('confirmDelete'),
      confirmLabel: tc('actions.remove'),
      tone: 'danger',
    }).then((confirmed) => {
      if (!confirmed) return
      const fallbackMessage = t('errors.save')
      execute(
        () => relationshipAction(`/api/billing-relationships?id=${encodeURIComponent(row.id)}`, { method: 'DELETE' }),
        {
          fallbackMessage,
          onRefused: (err) => setError(err.displayMessage(fallbackMessage)),
          onOk: () => {
            toast.success(t('removed'))
            load()
          },
        },
      )
    })
  }

  const billToName = draft?.billTo ? partyName(draft.billTo) : ''
  const eligibleGroups = payload.groups.filter((g) => !draft?.payer || g.payerPartyId === draft.payer)

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold">{t('heading')}</h3>
        {consolidated ? (
          <div className="mt-1 text-sm">
            <p>{t('invoicesGoTo', { name: summary.billToName })}</p>
            <p className="text-muted-foreground">
              {t('consolidatedLine', {
                cadence: summary.groupCadence
                  ? ta(`setup.options.consolidationCadence.${summary.groupCadence}`)
                  : '',
                payer: summary.payerName,
              })}
            </p>
          </div>
        ) : (
          <p className="mt-1 text-sm text-muted-foreground">{t('standalone')}</p>
        )}
      </div>

      <DrawerTabStrip
        tabs={[
          ...(payload.children.length > 0
            ? [{
                key: 'children' as const,
                label: t('childrenHeading'),
                count: payload.children.length,
              }]
            : []),
          {
            key: 'relationships' as const,
            label: t('relationshipsHeading'),
            count: payload.relationships.length,
          },
          ...(payload.groups.length > 0
            ? [{
                key: 'groups' as const,
                label: t('advancedHeading'),
                count: payload.groups.length,
              }]
            : []),
        ]}
        activeKey={panel}
        onSelect={(key) => setPanel(key)}
        ariaLabel={t('heading')}
      />

      <div hidden={panel !== 'children'} className="space-y-2">
      {payload.children.length > 0 ? (
        <div>
          <h4 className="text-sm font-semibold">{t('childrenHeading')}</h4>
          <SharedTable>
            <TableHeader>
              <TableRow>
                <TableHead>{t('child')}</TableHead>
                <TableHead>{t('window')}</TableHead>
                <TableHead>{t('group')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {payload.children.map((child) => (
                <TableRow key={`${child.childPartyId}-${child.effectiveFrom}`}>
                  <TableCell>{child.childName}</TableCell>
                  <TableCell>
                    {child.effectiveFrom} → {child.effectiveTo ?? t('openEnded')}
                  </TableCell>
                  <TableCell>{child.groupCode ?? '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </SharedTable>
        </div>
      ) : null}
      </div>

      <div hidden={panel !== 'relationships'} className="space-y-2">
      <div>
        <div className="flex items-center justify-between">
          <h4 className="text-sm font-semibold">{t('relationshipsHeading')}</h4>
          {canManage && !draft ? (
            <Button size="sm" variant="outline" onClick={() => { setDraft(EMPTY_DRAFT); setError(null) }}>
              {t('new')}
            </Button>
          ) : null}
        </div>
        {payload.relationships.length === 0 && !draft ? (
          <p className="mt-2 text-sm text-muted-foreground">{t('empty')}</p>
        ) : (
          <SharedTable>
            <TableHeader>
              <TableRow>
                <TableHead>{t('billTo')}</TableHead>
                <TableHead>{t('payer')}</TableHead>
                <TableHead>{t('group')}</TableHead>
                <TableHead>{t('window')}</TableHead>
                {canManage ? <TableHead>{tc('labels.actions')}</TableHead> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {payload.relationships.map((row) => (
                <TableRow key={row.id}>
                  <TableCell>{row.billToName}</TableCell>
                  <TableCell>{row.payerName}</TableCell>
                  <TableCell>{row.groupCode ?? '—'}</TableCell>
                  <TableCell>
                    {row.effectiveFrom} → {row.effectiveTo ?? t('openEnded')}
                  </TableCell>
                  {canManage ? (
                    <TableCell>
                      <div className="flex gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={() => {
                            setDraft({
                              id: row.id,
                              billTo: row.billToPartyId,
                              payer: row.payerPartyId,
                              group: row.groupId ?? '',
                              from: row.effectiveFrom,
                              to: row.effectiveTo ?? '',
                            })
                            setError(null)
                          }}
                        >
                          {tc('actions.edit')}
                        </Button>
                        <Button size="sm" variant="ghost" disabled={busy} onClick={() => remove(row)}>
                          {tc('actions.remove')}
                        </Button>
                      </div>
                    </TableCell>
                  ) : null}
                </TableRow>
              ))}
            </TableBody>
          </SharedTable>
        )}
      </div>

      {draft && canManage ? (
        <Card className="space-y-3 p-4">
          <div className="grid gap-3 md:grid-cols-2">
            <div>
              <Label>{t('billTo')}</Label>
              <SearchSelect
                value={draft.billTo}
                onChange={(billTo) => setDraft({ ...draft, billTo })}
                options={partyOptions}
                sheetTitle={t('billTo')}
                ariaLabel={t('billTo')}
              />
            </div>
            <div>
              <Label>{t('payer')}</Label>
              <SearchSelect
                value={draft.payer}
                onChange={(payer) => setDraft({
                  ...draft,
                  payer,
                  group: draft.group && payload.groups.some((g) => g.id === draft.group && g.payerPartyId === payer)
                    ? draft.group
                    : '',
                })}
                options={partyOptions}
                sheetTitle={t('payer')}
                ariaLabel={t('payer')}
              />
            </div>
            <div>
              <Label>{t('group')}</Label>
              <Select
                value={draft.group}
                onChange={(e) => setDraft({ ...draft, group: e.target.value })}
                aria-label={t('group')}
              >
                <option value="">{t('groupNone')}</option>
                {eligibleGroups.map((g) => (
                  <option key={g.id} value={g.id}>{`${g.code} · ${g.name}`}</option>
                ))}
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>{t('effectiveFrom')}</Label>
                <Input type="date" value={draft.from} onChange={(e) => setDraft({ ...draft, from: e.target.value })} />
              </div>
              <div>
                <Label>{t('effectiveTo')}</Label>
                <Input type="date" value={draft.to} onChange={(e) => setDraft({ ...draft, to: e.target.value })} />
              </div>
            </div>
          </div>
          {draft.billTo && draft.from ? (
            <p className="text-sm text-muted-foreground">
              {t('consequence', { from: draft.from, billTo: billToName })}
            </p>
          ) : null}
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          <div className="flex justify-end gap-2">
            <Button variant="outline" disabled={busy} onClick={() => { setDraft(null); setError(null) }}>
              {tc('actions.cancel')}
            </Button>
            <Button disabled={busy || !draft.billTo || !draft.payer || !draft.from} onClick={save}>
              {busy ? tc('actions.saving') : tc('actions.save')}
            </Button>
          </div>
        </Card>
      ) : null}

      </div>

      <div hidden={panel !== 'groups'} className="space-y-2">
      {payload.groups.length > 0 ? (
        <div>
          <h4 className="text-sm font-semibold">{t('advancedHeading')}</h4>
          <p className="text-sm text-muted-foreground">{t('advancedSummary')}</p>
          <dl className="mt-2 grid grid-cols-1 gap-x-4 gap-y-3 text-sm">
            {payload.groups.map((group) => (
              <div key={group.id}>
                <dt className="font-medium">
                  {t('groupDetail', { code: group.code, name: group.name, day: group.cutoffDay })}
                </dt>
                <dd className="text-muted-foreground">
                  {ta(`setup.options.consolidationGrouping.${GROUPING_KEYS[group.grouping]}`)}
                  {' · '}
                  {group.billingSubsidiaryName
                    ? t('billingEntity', { name: group.billingSubsidiaryName })
                    : t('billingEntityFallback')}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}
      </div>
    </div>
  )
}
