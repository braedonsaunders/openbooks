'use client'

import { Suspense, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Button, Card, CardContent, Input, Label } from '@openbooks/ui'

/**
 * Password reset. Without ?token= this asks for the account email and always
 * reports "link sent" (no account enumeration). With ?token= it collects the
 * new password and confirms, then routes back to sign-in.
 */
function ResetForm() {
  const t = useTranslations('login')
  const tCommon = useTranslations('common')
  const params = useSearchParams()
  const token = params.get('token')

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submitRequest(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    await fetch('/api/password-reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    }).catch(() => undefined)
    setDone(true)
    setBusy(false)
  }

  async function submitConfirm(e: React.FormEvent) {
    e.preventDefault()
    if (password !== confirm) {
      setError(t('reset.mismatch'))
      return
    }
    setBusy(true)
    setError(null)
    const res = await fetch('/api/password-reset', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, password }),
    })
    if (res.ok) {
      setDone(true)
    } else {
      const data = await res.json().catch(() => ({}))
      setError(data.error === 'weak_password' ? t('reset.weakPassword') : t('reset.invalidToken'))
    }
    setBusy(false)
  }

  return (
    <div className="login-rise-in relative w-full max-w-sm">
      <Card className="w-full rounded-3xl border-slate-200/80 shadow-xl shadow-slate-900/5 dark:border-slate-800 dark:shadow-black/30">
        <CardContent className="px-8 py-8">
          <div className="mb-7 text-center">
            <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white">
              open<span className="text-teal-600 dark:text-teal-400">books</span>
            </h1>
            <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
              {token ? t('reset.chooseTitle') : t('reset.requestTitle')}
            </p>
          </div>

          {done ? (
            <div className="space-y-4 text-center">
              <p className="text-sm text-slate-600 dark:text-slate-300">
                {token ? t('reset.changed') : t('reset.sent')}
              </p>
              <Button asChild className="h-11 w-full text-base font-semibold">
                <Link href="/login">{t('reset.backToSignIn')}</Link>
              </Button>
            </div>
          ) : token ? (
            <form onSubmit={submitConfirm} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="new-password">{t('reset.newPassword')}</Label>
                <Input
                  id="new-password"
                  type="password"
                  autoComplete="new-password"
                  autoFocus
                  required
                  minLength={10}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="h-11"
                />
                <p className="text-xs text-slate-500 dark:text-slate-400">{t('reset.passwordHelp')}</p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="confirm-password">{t('reset.confirmPassword')}</Label>
                <Input
                  id="confirm-password"
                  type="password"
                  autoComplete="new-password"
                  required
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  className="h-11"
                />
              </div>
              {error ? (
                <p className="text-sm text-red-600 dark:text-red-400" role="alert">{error}</p>
              ) : null}
              <Button type="submit" disabled={busy} className="h-11 w-full text-base font-semibold">
                {busy ? t('reset.saving') : t('reset.setPassword')}
              </Button>
            </form>
          ) : (
            <form onSubmit={submitRequest} className="space-y-4">
              <p className="text-sm text-slate-600 dark:text-slate-400">{t('reset.requestHelp')}</p>
              <div className="space-y-1.5">
                <Label htmlFor="email">{tCommon('labels.email')}</Label>
                <Input
                  id="email"
                  type="email"
                  autoComplete="email"
                  autoFocus
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="h-11"
                />
              </div>
              {error ? (
                <p className="text-sm text-red-600 dark:text-red-400" role="alert">{error}</p>
              ) : null}
              <Button type="submit" disabled={busy} className="h-11 w-full text-base font-semibold">
                {busy ? t('reset.sending') : t('reset.sendLink')}
              </Button>
              <p className="text-center">
                <Link href="/login" className="text-sm text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200">
                  {t('reset.backToSignIn')}
                </Link>
              </p>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

export default function ResetPage() {
  return (
    <main className="grid h-full min-h-screen place-items-center bg-gradient-to-b from-white to-slate-100 p-4 dark:from-slate-950 dark:to-slate-900">
      <Suspense>
        <ResetForm />
      </Suspense>
    </main>
  )
}
