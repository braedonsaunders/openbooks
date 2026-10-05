'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { ArrowLeft, Copy, MoreHorizontal, ShieldAlert } from 'lucide-react'
import { toast } from 'sonner'
import {
  Badge,
  Button,
  ContextMenu,
  DisclosureSection,
  Input,
  Label,
  Textarea,
  UrlDrawer,
  useContextMenu,
} from '@openbooks/ui'
import { fetchAction } from '@braedonsaunders/appkit-errors'
import { ActionAlert } from '@braedonsaunders/appkit-errors/react'
import { useAppAction } from '@/lib/use-app-action'
import { confirmDialog } from '@/lib/confirm'
import { DrawerTabStrip } from '@/components/drawer-tab-strip'
import { PagedTable } from '@/components/paged-table'

export type EndpointDelivery = {
  id: string
  status: string
  attemptCount: number
  nextAttemptAt: string | null
  lastAttemptAt: string | null
  lastResponseCode: number | null
  lastResponseExcerpt: string | null
  lastLatencyMs: number | null
  lastError: string | null
  deliveredAt: string | null
  createdAt: string
  eventType: string
  occurredAt: string
  payload: unknown
}

export type EndpointRow = {
  id: string
  key: string
  url: string
  description: string
  events: string[]
  status: string
  consecutiveFailures: number
  autoDisableAfter: number
  disabledAt: string | null
  disabledReason: string | null
  secretRotatedAt: string | null
  lastDeliveryAt: string | null
  lastDeliveryStatus: string | null
  lastError: string | null
  deliveryCount: number
  pendingCount: number
  failedCount: number
  deliveries?: EndpointDelivery[]
}

export type WebhookEndpointDrawerProps = {
  /** Null while creating: the drawer edits blanks and posts them once. */
  endpoint: EndpointRow | null
  closeHref: string
  canManage: boolean
  /** Subscribable event types from the engine catalog, grouped by prefix below. */
  eventTypes: string[]
}

type DrawerTab = 'settings' | 'deliveries' | 'security'

const DELIVERY_VARIANT: Record<string, 'success' | 'secondary' | 'warning' | 'destructive' | 'outline'> = {
  delivered: 'success',
  pending: 'secondary',
  failed: 'warning',
  dead: 'destructive',
}

function eventGroup(type: string): string {
  if (type.startsWith('document.') || type.startsWith('payment.') || type.startsWith('invoice.')) return 'documents'
  if (type.startsWith('item.') || type.startsWith('inventory.')) return 'catalog'
  return 'customers'
}

export function NewEndpointButton({ label }: { label?: string } = {}) {
  const t = useTranslations('admin.webhooks')
  const router = useRouter()
  return (
    <Button onClick={() => router.push('/admin/webhooks?endpoint=new')}>
      {label ?? t('list.newButton')}
    </Button>
  )
}

export function WebhookEndpointDrawer({ endpoint, closeHref, canManage, eventTypes }: WebhookEndpointDrawerProps) {
  const t = useTranslations('admin.webhooks')
  const tCommon = useTranslations('common')
  const router = useRouter()
  const creating = !endpoint
  const [tab, setTab] = useState<DrawerTab>('settings')
  const [key, setKey] = useState(endpoint?.key ?? '')
  const [url, setUrl] = useState(endpoint?.url ?? '')
  const [description, setDescription] = useState(endpoint?.description ?? '')
  const [selected, setSelected] = useState<Set<string>>(new Set(endpoint?.events ?? ['document.posted', 'document.voided', 'payment.received']))
  const [active, setActive] = useState((endpoint?.status ?? 'active') === 'active')
  const [createdSecret, setCreatedSecret] = useState<string | null>(null)
  const [selectedDeliveryId, setSelectedDeliveryId] = useState<string | null>(null)
  const { busy, refusal, execute } = useAppAction()
  const menu = useContextMenu()
  const [menuDelivery, setMenuDelivery] = useState<EndpointDelivery | null>(null)

  const deliveries = useMemo(() => endpoint?.deliveries ?? [], [endpoint])
  const selectedDelivery = useMemo(
    () => deliveries.find((d) => d.id === selectedDeliveryId) ?? null,
    [deliveries, selectedDeliveryId],
  )
  const groups = useMemo(() => {
    const byGroup = new Map<string, string[]>()
    for (const type of eventTypes) {
      const group = eventGroup(type)
      if (!byGroup.has(group)) byGroup.set(group, [])
      byGroup.get(group)!.push(type)
    }
    return [...byGroup.entries()]
  }, [eventTypes])
  const failing = (endpoint?.consecutiveFailures ?? 0) > 0
  const healthLine = !endpoint
    ? t('drawer.healthNew')
    : endpoint.status !== 'active'
      ? t('drawer.healthDisabled')
      : failing
        ? t('drawer.healthFailing', { count: endpoint.consecutiveFailures })
        : t('drawer.healthOk', { count: endpoint.deliveryCount })

  function toggleEvent(type: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(type)) next.delete(type)
      else next.add(type)
      return next
    })
  }

  async function save() {
    if (!key.trim()) {
      toast.error(t('drawer.keyRequired'))
      return
    }
    if (!url.trim()) {
      toast.error(t('drawer.urlRequired'))
      return
    }
    await execute(() => fetchAction<{ id: string; secret: string }>('/api/admin/webhooks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: key.trim(), url: url.trim(), description: description.trim(), events: [...selected] }),
    }), {
      fallbackMessage: t('drawer.saveFailed'),
      successMessage: t('drawer.created'),
      onOk: (data) => { setCreatedSecret(data.secret); router.refresh() },
    })
  }

  async function saveChanges() {
    if (!endpoint) return
    await execute(() => fetchAction('/api/admin/webhooks', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: endpoint.id, url: url.trim(), description: description.trim(), events: [...selected] }),
    }), {
      fallbackMessage: t('drawer.saveFailed'),
      successMessage: t('drawer.updated'),
      onOk: () => { router.refresh() },
    })
  }

  async function toggleActive() {
    if (!endpoint) return
    const next = endpoint.status !== 'active'
    const ok = await confirmDialog(next ? t('drawer.enableConfirm') : t('drawer.disableConfirm'))
    if (!ok) return
    await execute(() => fetchAction('/api/admin/webhooks', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: endpoint.id, op: next ? 'enable' : 'disable' }),
    }), {
      fallbackMessage: t('drawer.saveFailed'),
      successMessage: next ? t('drawer.enabled') : t('drawer.disabled'),
      onOk: () => { setActive(next); router.refresh() },
    })
  }

  async function rotate() {
    if (!endpoint) return
    const ok = await confirmDialog(t('security.rotateConfirm'))
    if (!ok) return
    await execute(() => fetchAction<{ secret: string }>('/api/admin/webhooks', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: endpoint.id, op: 'rotate' }),
    }), {
      fallbackMessage: t('drawer.saveFailed'),
      successMessage: t('security.rotated'),
      onOk: (data) => { setCreatedSecret(data.secret); router.refresh() },
    })
  }

  async function ping() {
    if (!endpoint) return
    await execute(() => fetchAction('/api/admin/webhooks', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: endpoint.id, op: 'ping' }),
    }), {
      fallbackMessage: t('security.pingFailed'),
      successMessage: t('security.pingOk'),
      onOk: () => { router.refresh() },
    })
  }

  async function redeliver(deliveryId: string) {
    if (!endpoint) return
    await execute(() => fetchAction('/api/admin/webhooks', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: endpoint.id, op: 'redeliver', deliveryId }),
    }), {
      fallbackMessage: t('deliveries.redeliverFailed'),
      successMessage: t('deliveries.redelivered'),
      onOk: () => { setSelectedDeliveryId(null); router.refresh() },
    })
  }

  function copySecret() {
    if (createdSecret) {
      navigator.clipboard.writeText(createdSecret)
      toast.success(t('drawer.copied'))
    }
  }

  const title = creating ? t('drawer.newTitle') : (endpoint?.key ?? '')
  return (
    <UrlDrawer
      open
      closeHref={closeHref}
      size="2xl"
      title={title}
      description={creating ? t('drawer.newDescription') : healthLine}
      headerActions={
        <>
          {!creating && canManage && endpoint?.status === 'active' ? (
            <Button variant="ghost" size="sm" disabled={busy} onClick={toggleActive} className="text-red-600 hover:text-red-700 dark:text-red-400">
              {t('drawer.disable')}
            </Button>
          ) : null}
          {!creating && canManage && endpoint?.status !== 'active' ? (
            <Button variant="outline" size="sm" disabled={busy} onClick={toggleActive}>
              {t('drawer.enable')}
            </Button>
          ) : null}
          <Button variant="outline" disabled={busy} onClick={() => router.push(closeHref)}>
            {createdSecret ? tCommon('actions.close') : tCommon('actions.cancel')}
          </Button>
          {canManage && !createdSecret && !selectedDelivery ? (
            <Button disabled={busy || !key.trim() || !url.trim()} onClick={creating ? save : saveChanges}>
              {busy ? tCommon('actions.saving') : creating ? t('drawer.create') : t('drawer.saveChanges')}
            </Button>
          ) : null}
        </>
      }
    >
      <ActionAlert error={refusal} fallbackMessage={t('drawer.saveFailed')} />
      {createdSecret ? (
        <div className="space-y-4 p-1">
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950/40">
            <div className="flex items-start gap-3">
              <ShieldAlert size={20} className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" />
              <div className="min-w-0 flex-1">
                <h3 className="text-sm font-semibold text-amber-900 dark:text-amber-200">
                  {t('drawer.secretCreated')}
                </h3>
                <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">
                  {t('drawer.secretCreatedHint')}
                </p>
                <div className="mt-3 flex items-center gap-2">
                  <code className="flex-1 truncate rounded-md border border-amber-300 bg-white px-3 py-2 font-mono text-[13px] text-slate-900 dark:border-amber-700 dark:bg-slate-900 dark:text-slate-100">
                    {createdSecret}
                  </code>
                  <Button size="sm" variant="outline" onClick={copySecret}>
                    <Copy size={14} /> {t('drawer.copy')}
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : selectedDelivery ? (
        <DeliveryDetail
          delivery={selectedDelivery}
          canManage={canManage}
          busy={busy}
          onBack={() => setSelectedDeliveryId(null)}
          onRedeliver={() => redeliver(selectedDelivery.id)}
        />
      ) : (
        <div className="space-y-5 p-1">
          {!creating ? (
            <DrawerTabStrip
              tabs={[
                { key: 'settings', label: t('tabs.settings') },
                { key: 'deliveries', label: t('tabs.deliveries', { count: endpoint?.deliveryCount ?? 0 }) },
                { key: 'security', label: t('tabs.security') },
              ]}
              activeKey={tab}
              onSelect={(key) => setTab(key as DrawerTab)}
              ariaLabel={t('tabs.ariaLabel')}
            />
          ) : null}
          {tab === 'settings' || creating ? (
            <SettingsTab
              creating={creating}
              endpointKey={key}
              setKey={setKey}
              url={url}
              setUrl={setUrl}
              description={description}
              setDescription={setDescription}
              selected={selected}
              toggleEvent={toggleEvent}
              groups={groups}
              active={active}
              canManage={canManage}
              endpoint={endpoint}
            />
          ) : null}
          {tab === 'deliveries' && !creating ? (
            <DeliveriesTab
              deliveries={deliveries}
              busy={busy}
              onOpen={(id) => setSelectedDeliveryId(id)}
              onMenu={(delivery, el) => { setMenuDelivery(delivery); menu.openBelow(el) }}
              onRedeliver={redeliver}
            />
          ) : null}
          {tab === 'security' && !creating && endpoint ? (
            <SecurityTab
              endpoint={endpoint}
              canManage={canManage}
              busy={busy}
              onRotate={rotate}
              onPing={ping}
            />
          ) : null}
        </div>
      )}
      <ContextMenu
        open={menu.open}
        position={menu.position}
        onClose={menu.close}
        items={[
          { key: 'view', label: t('deliveries.view'), onSelect: () => menuDelivery && setSelectedDeliveryId(menuDelivery.id) },
          ...((menuDelivery && (menuDelivery.status === 'failed' || menuDelivery.status === 'dead') && canManage)
            ? [{ key: 'redeliver', label: t('deliveries.redeliver'), onSelect: () => menuDelivery && redeliver(menuDelivery.id) }]
            : []),
        ]}
      />
    </UrlDrawer>
  )
}

function SettingsTab({ creating, endpointKey, setKey, url, setUrl, description, setDescription, selected, toggleEvent, groups, active, canManage, endpoint }: {
  creating: boolean
  endpointKey: string
  setKey: (v: string) => void
  url: string
  setUrl: (v: string) => void
  description: string
  setDescription: (v: string) => void
  selected: Set<string>
  toggleEvent: (type: string) => void
  groups: [string, string[]][]
  active: boolean
  canManage: boolean
  endpoint: EndpointRow | null
}) {
  const t = useTranslations('admin.webhooks')
  const tCommon = useTranslations('common')
  const readOnly = !canManage
  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="webhook-key">{t('drawer.keyLabel')}</Label>
          <Input
            id="webhook-key"
            value={endpointKey}
            onChange={(e) => setKey(e.target.value)}
            disabled={!creating || readOnly}
            placeholder={t('drawer.keyPlaceholder')}
          />
          <p className="text-xs text-slate-500">{t('drawer.keyHint')}</p>
        </div>
        <div className="space-y-1.5">
          <Label>{t('drawer.activeLabel')}</Label>
          <div>
            <Badge variant={active ? 'success' : 'secondary'}>
              {active ? t('drawer.activeOn') : t('drawer.activeOff')}
            </Badge>
          </div>
          <p className="text-xs text-slate-500">{t('drawer.activeHint')}</p>
        </div>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="webhook-url">{t('drawer.urlLabel')}</Label>
        <Input
          id="webhook-url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          disabled={readOnly}
          placeholder="https://"
          inputMode="url"
        />
        <p className="text-xs text-slate-500">{t('drawer.urlHint')}</p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="webhook-description">{tCommon('labels.description')}</Label>
        <Textarea
          id="webhook-description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          disabled={readOnly}
          placeholder={t('drawer.descriptionPlaceholder')}
        />
      </div>
      <div className="space-y-2">
        <Label>{t('drawer.eventsLabel')}</Label>
        <p className="text-xs text-slate-500">{t('drawer.eventsHint')}</p>
        {groups.map(([group, types]) => (
          <fieldset key={group} className="rounded-lg border border-slate-200 p-3 dark:border-slate-800">
            <legend className="px-1 text-xs font-semibold text-slate-600 dark:text-slate-300">
              {t(`groups.${group}`)}
            </legend>
            <div className="grid gap-1.5">
              {types.map((type) => (
                <label key={type} className="flex cursor-pointer items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={selected.has(type)}
                    disabled={readOnly}
                    onChange={() => toggleEvent(type)}
                    className="h-4 w-4 rounded border-slate-300"
                  />
                  <code className="font-mono text-[13px]">{type}</code>
                </label>
              ))}
            </div>
          </fieldset>
        ))}
      </div>
      {!creating && endpoint ? (
        <DisclosureSection
          title={t('advanced.title')}
          summary={t('advanced.summary', { threshold: endpoint.autoDisableAfter })}
          forceOpen={(endpoint.failedCount ?? 0) > 0}
        >
          <div className="space-y-2 text-sm text-slate-600 dark:text-slate-300">
            <p>{t('advanced.retry')}</p>
            <p>{t('advanced.autoDisable', { threshold: endpoint.autoDisableAfter, failures: endpoint.consecutiveFailures })}</p>
            <p>{t('advanced.envelope')}</p>
          </div>
        </DisclosureSection>
      ) : null}
    </div>
  )
}

function DeliveriesTab({ deliveries, busy, onOpen, onMenu, onRedeliver }: {
  deliveries: EndpointDelivery[]
  busy: boolean
  onOpen: (id: string) => void
  onMenu: (delivery: EndpointDelivery, el: HTMLElement) => void
  onRedeliver: (id: string) => void
}) {
  const t = useTranslations('admin.webhooks')
  const failed = deliveries.filter((d) => d.status === 'failed' || d.status === 'dead')
  return (
    <div className="space-y-3">
      {failed.length > 0 ? (
        <p className="text-sm text-slate-600 dark:text-slate-300">
          {t('deliveries.needsAttention', { count: failed.length })}
        </p>
      ) : null}
      <PagedTable
        rows={deliveries}
        rowKey={(row) => row.id}
        empty={t('deliveries.empty')}
        onRowClick={(row) => onOpen(row.id)}
        rowRole="button"
        rowLabel={(row) => t('deliveries.openAria', { event: row.eventType })}
        columns={[
          {
            key: 'event',
            header: t('deliveries.event'),
            cell: (row) => <code className="font-mono text-xs">{row.eventType}</code>,
          },
          {
            key: 'status',
            header: t('deliveries.status'),
            cell: (row) => (
              <Badge variant={DELIVERY_VARIANT[row.status] ?? 'secondary'}>{row.status}</Badge>
            ),
          },
          {
            key: 'attempts',
            header: t('deliveries.attempts'),
            cell: (row) => <span className="tabular-nums">{row.attemptCount}</span>,
          },
          {
            key: 'code',
            header: t('deliveries.code'),
            cell: (row) => <span className="tabular-nums">{row.lastResponseCode ?? '—'}</span>,
          },
          {
            key: 'latency',
            header: t('deliveries.latency'),
            cell: (row) => (
              <span className="tabular-nums">
                {row.lastLatencyMs == null ? '—' : t('deliveries.latencyMs', { ms: row.lastLatencyMs })}
              </span>
            ),
          },
          {
            key: 'next',
            header: t('deliveries.next'),
            cell: (row) => (
              <span className="whitespace-nowrap text-xs">
                {row.status === 'pending' && row.nextAttemptAt ? row.nextAttemptAt : '—'}
              </span>
            ),
          },
          {
            key: 'actions',
            header: '',
            cell: (row) => (row.status === 'failed' || row.status === 'dead' ? (
              <span className="flex gap-1" onClick={(e) => e.stopPropagation()}>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => onRedeliver(row.id)}
                >
                  {t('deliveries.redeliver')}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={(e) => onMenu(row, e.currentTarget as HTMLElement)}
                  aria-label={t('deliveries.moreActions')}
                >
                  <MoreHorizontal size={14} />
                </Button>
              </span>
            ) : (
              <span onClick={(e) => e.stopPropagation()}>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={(e) => onMenu(row, e.currentTarget as HTMLElement)}
                  aria-label={t('deliveries.moreActions')}
                >
                  <MoreHorizontal size={14} />
                </Button>
              </span>
            )),
          },
        ]}
      />
    </div>
  )
}

function SecurityTab({ endpoint, canManage, busy, onRotate, onPing }: {
  endpoint: EndpointRow
  canManage: boolean
  busy: boolean
  onRotate: () => void
  onPing: () => void
}) {
  const t = useTranslations('admin.webhooks')
  return (
    <div className="space-y-5">
      <div className="rounded-lg border border-slate-200 p-4 dark:border-slate-800">
        <h3 className="text-sm font-semibold">{t('security.signingTitle')}</h3>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">{t('security.signingBody')}</p>
        {canManage ? (
          <div className="mt-3 flex gap-2">
            <Button variant="outline" size="sm" disabled={busy} onClick={onRotate}>
              {t('security.rotate')}
            </Button>
            <Button variant="outline" size="sm" disabled={busy} onClick={onPing}>
              {t('security.ping')}
            </Button>
          </div>
        ) : null}
      </div>
      <DisclosureSection
        title={t('security.overlapTitle')}
        summary={endpoint.secretRotatedAt ? t('security.overlapOn') : t('security.overlapOff')}
      >
        <p className="text-sm text-slate-600 dark:text-slate-300">{t('security.overlapBody')}</p>
      </DisclosureSection>
    </div>
  )
}

function DeliveryDetail({ delivery, canManage, busy, onBack, onRedeliver }: {
  delivery: EndpointDelivery
  canManage: boolean
  busy: boolean
  onBack: () => void
  onRedeliver: () => void
}) {
  const t = useTranslations('admin.webhooks')
  const terminal = delivery.status === 'failed' || delivery.status === 'dead'
  return (
    <div className="space-y-4 p-1">
      <Button variant="ghost" size="sm" onClick={onBack}>
        <ArrowLeft size={14} /> {t('deliveries.back')}
      </Button>
      <div className="flex items-center gap-2">
        <code className="font-mono text-sm">{delivery.eventType}</code>
        <Badge variant={DELIVERY_VARIANT[delivery.status] ?? 'secondary'}>{delivery.status}</Badge>
      </div>
      {delivery.lastError ? (
        <p className="text-sm text-slate-600 dark:text-slate-300">{delivery.lastError}</p>
      ) : null}
      {terminal && canManage ? (
        <Button size="sm" disabled={busy} onClick={onRedeliver}>
          {t('deliveries.redeliver')}
        </Button>
      ) : null}
      <div className="space-y-1.5">
        <h3 className="text-sm font-semibold">{t('deliveries.payloadTitle')}</h3>
        <pre className="max-h-64 overflow-auto rounded-md border border-slate-200 bg-slate-50 p-3 font-mono text-xs dark:border-slate-800 dark:bg-slate-900">
          {JSON.stringify(delivery.payload, null, 2)}
        </pre>
      </div>
      <div className="space-y-1.5">
        <h3 className="text-sm font-semibold">{t('deliveries.responseTitle')}</h3>
        <pre className="max-h-40 overflow-auto rounded-md border border-slate-200 bg-slate-50 p-3 font-mono text-xs dark:border-slate-800 dark:bg-slate-900">
          {delivery.lastResponseExcerpt || t('deliveries.noResponse')}
        </pre>
      </div>
    </div>
  )
}
