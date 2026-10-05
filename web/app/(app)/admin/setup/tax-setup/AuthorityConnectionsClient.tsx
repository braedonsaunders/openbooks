'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { ActionError, kindForStatus, transportError, type ActionResult } from '@braedonsaunders/appkit-errors'
import { Badge, Button, Card, CardContent, Input, Label } from '@openbooks/ui'
import { readApiErrorMessage } from '@/lib/api-error'
import { useAppAction } from '@/lib/use-app-action'

export interface AuthorityConnectionView {
  authority: 'hmrc' | 'abn'
  status: 'missing' | 'ready' | 'error' | 'expired'
  hasCredentials: boolean
  tokenExpiresAt: string | null
  lastError: string | null
  lastVerifiedAt: string | null
}

const STATUS_VARIANT = {
  missing: 'secondary',
  ready: 'success',
  error: 'destructive',
  expired: 'warning',
} as const

/**
 * Tax-authority connections on Tax setup. Everyday: each authority shows its
 * connection state with a Verify button that performs a live round-trip.
 * Configure: the credential form lives in the same card, so saving and
 * verifying stay in context — the stored secret is never displayed back.
 */
export function AuthorityConnectionsClient({ initial }: { initial: AuthorityConnectionView[] }) {
  const t = useTranslations('admin.setup.taxSetup.authorities')
  const [connections, setConnections] = useState(initial)
  const [forms, setForms] = useState<Record<string, Record<string, string>>>({})
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)
  const { busy, execute } = useAppAction()

  function field(authority: string, name: string): string {
    return forms[authority]?.[name] ?? ''
  }

  function setField(authority: string, name: string, value: string) {
    setForms((prev) => ({ ...prev, [authority]: { ...prev[authority], [name]: value } }))
  }

  async function runAction(body: unknown): Promise<ActionResult<AuthorityConnectionView>> {
    try {
      const res = await fetch('/api/tax/authorities', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        return {
          ok: false as const,
          error: new ActionError({
            kind: kindForStatus(res.status),
            status: res.status,
            code: 'authorities',
            serverMessage: await readApiErrorMessage(res, t('actionFailed')),
          }),
        }
      }
      return { ok: true as const, status: res.status, data: (await res.json()) as AuthorityConnectionView }
    } catch (error) {
      return { ok: false as const, error: transportError(error instanceof Error ? error.message : String(error)) }
    }
  }

  function apply(next: AuthorityConnectionView, message: string) {
    setConnections((prev) => prev.map((c) => (c.authority === next.authority ? next : c)))
    setNotice({ ok: true, text: message })
  }

  async function act(body: unknown, doneMessage: string) {
    setNotice(null)
    const fallback = t('actionFailed')
    await execute(() => runAction(body), {
      fallbackMessage: fallback,
      onRefused: (error) => setNotice({ ok: false, text: error.displayMessage(fallback) }),
      onOk: (data) => apply(data, doneMessage),
    })
  }

  async function save(authority: 'hmrc' | 'abn') {
    await act(
      {
        action: 'save',
        authority,
        credentials:
          authority === 'hmrc'
            ? { clientId: field(authority, 'clientId'), clientSecret: field(authority, 'clientSecret'), scope: field(authority, 'scope') }
            : { guid: field(authority, 'guid') },
      },
      t('saved'),
    )
  }

  async function verify(authority: 'hmrc' | 'abn') {
    await act({ action: 'verify', authority }, t('verified'))
  }

  async function refresh() {
    await act({ action: 'refresh' }, t('verified'))
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">{t('title')}</h2>
        <p className="mt-0.5 max-w-2xl text-sm text-slate-500 dark:text-slate-400">{t('description')}</p>
      </div>
      {notice ? (
        <p className={`text-sm ${notice.ok ? 'text-teal-700 dark:text-teal-300' : 'text-red-600 dark:text-red-400'}`}>{notice.text}</p>
      ) : null}
      {connections.map((connection) => (
        <Card key={connection.authority}>
          <CardContent className="space-y-3 py-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="font-medium text-slate-900 dark:text-slate-100">{t(`${connection.authority}Title`)}</p>
                <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">{t(`${connection.authority}Description`)}</p>
              </div>
              <Badge variant={STATUS_VARIANT[connection.status]}>{t(`status.${connection.status}`)}</Badge>
            </div>
            {connection.lastError ? (
              <p className="text-sm text-red-600 dark:text-red-400">{t('lastError', { error: connection.lastError })}</p>
            ) : null}
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {connection.lastVerifiedAt ? t('lastVerified', { at: connection.lastVerifiedAt }) : t('neverVerified')}
            </p>
            <div className="grid gap-3 sm:grid-cols-3">
              {connection.authority === 'hmrc' ? (
                <>
                  <div className="space-y-1.5">
                    <Label>{t('clientId')}</Label>
                    <Input
                      value={field('hmrc', 'clientId')}
                      onChange={(event) => setField('hmrc', 'clientId', event.target.value)}
                      autoComplete="off"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label>{t('clientSecret')}</Label>
                    <Input
                      type="password"
                      value={field('hmrc', 'clientSecret')}
                      onChange={(event) => setField('hmrc', 'clientSecret', event.target.value)}
                      autoComplete="new-password"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label>{t('scope')}</Label>
                    <Input
                      value={field('hmrc', 'scope')}
                      onChange={(event) => setField('hmrc', 'scope', event.target.value)}
                      autoComplete="off"
                    />
                  </div>
                </>
              ) : (
                <div className="space-y-1.5 sm:col-span-2">
                  <Label>{t('guid')}</Label>
                  <Input
                    type="password"
                    value={field('abn', 'guid')}
                    onChange={(event) => setField('abn', 'guid', event.target.value)}
                    autoComplete="new-password"
                  />
                </div>
              )}
            </div>
            <div className="flex gap-2">
              <Button disabled={busy} onClick={() => void save(connection.authority)}>
                {busy ? t('saving') : t('save')}
              </Button>
              <Button variant="outline" disabled={busy || !connection.hasCredentials} onClick={() => void verify(connection.authority)}>
                {busy ? t('verifying') : t('verify')}
              </Button>
              {connection.authority === 'hmrc' ? (
                <Button variant="outline" disabled={busy || !connection.hasCredentials} onClick={() => void refresh()}>
                  {busy ? t('refreshing') : t('refresh')}
                </Button>
              ) : null}
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  )
}
