'use client'

import { Suspense, useEffect, useState } from 'react'
import type { CSSProperties } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Button, Card, CardContent, Input, Label, cn } from '@openbooks/ui'

// Hero book that physically opens on load: the spine draws in, both covers
// swing open around it, then the ledger lines write themselves onto the pages.
// It plays once and rests. Geometry matches the brand mark; stroke weights are
// tuned lighter because this renders large. Animation lives in globals.css
// under "Login stage"; the .book-* class hooks drive each part.
const SPINE = 'M24 13 V 40'
const LEFT_COVER = 'M24 13 C 18 7.5 10 6 4.5 8.5 V 35.5 C 10 33.5 18 34.5 24 40'
const RIGHT_COVER = 'M24 13 C 30 7.5 38 6 43.5 8.5 V 35.5 C 38 33.5 30 34.5 24 40'
const LEFT_ENTRIES = [
  'M9.5 15.5 C 13 14.8 17 15.6 20 17.4',
  'M9.5 21.5 C 13 20.8 17 21.6 20 23.4',
  'M9.5 27.5 C 13 26.8 17 27.6 20 29.4',
]
const RIGHT_ENTRIES = [
  'M28 17.4 C 31 15.6 35 14.8 38.5 15.5',
  'M28 23.4 C 31 21.6 35 20.8 38.5 21.5',
  'M28 29.4 C 31 27.6 35 26.8 38.5 27.5',
]
// Entries fade in one-by-one once the covers finish opening (~1.05s).
const entryDelay = (i: number): CSSProperties => ({ animationDelay: `${1.0 + i * 0.1}s` })

function HeroBook({ className }: { className?: string }) {
  return (
    <svg
      viewBox="3 5 42 37"
      role="img"
      aria-label="openbooks"
      className={cn('login-book text-slate-900', className)}
    >
      {/* covers + spine — ink strokes */}
      <g fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
        <path className="book-spine" d={SPINE} pathLength={1} />
        <g className="book-cover-l">
          {/* white page behind the ledger lines — closes along the spine */}
          <path d={`${LEFT_COVER} Z`} fill="#ffffff" stroke="none" />
          <path d={LEFT_COVER} />
          {LEFT_ENTRIES.map((d, i) => (
            <path
              key={d}
              className="book-entry text-teal-600"
              stroke="currentColor"
              strokeWidth={1.4}
              d={d}
              style={entryDelay(i)}
            />
          ))}
        </g>
        <g className="book-cover-r">
          <path d={`${RIGHT_COVER} Z`} fill="#ffffff" stroke="none" />
          <path d={RIGHT_COVER} />
          {RIGHT_ENTRIES.map((d, i) => (
            <path
              key={d}
              className="book-entry text-teal-600"
              stroke="currentColor"
              strokeWidth={1.4}
              d={d}
              style={entryDelay(i + 3)}
            />
          ))}
        </g>
      </g>
    </svg>
  )
}

function LoginForm() {
  const t = useTranslations('login')
  const tCommon = useTranslations('common')
  const router = useRouter()
  const params = useSearchParams()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [mfaCode, setMfaCode] = useState('')
  const [mfaRequired, setMfaRequired] = useState(params.get('mfa') === '1')
  const [oidc, setOidc] = useState<{ enabled: boolean; label: string }>({ enabled: false, label: '' })
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let active = true
    fetch('/api/auth/methods', { cache: 'no-store' })
      .then((response) => response.ok ? response.json() : null)
      .then((methods) => {
        if (active && methods?.oidc) setOidc({ enabled: true, label: methods.oidcLabel || t('sso') })
      })
      .catch(() => undefined)
    if (params.get('error') === 'sso') setError(t('ssoFailed'))
    return () => { active = false }
  }, [params, t])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(mfaRequired ? { mfaCode } : { email, password }),
    })
    if (res.status === 202) {
      setMfaRequired(true)
      setPassword('')
      setBusy(false)
    } else if (res.ok) {
      router.push(params.get('next') ?? '/')
      router.refresh()
    } else {
      setError(mfaRequired ? t('invalidMfa') : t('invalidCredentials'))
      setBusy(false)
    }
  }

  return (
    <div className="login-rise-in relative w-full max-w-sm">
      {/* The large book opens above the card and overlaps down onto its top. */}
      <div className="pointer-events-none absolute inset-x-0 -top-[8.5rem] z-20 flex justify-center">
        <HeroBook className="h-56 w-auto drop-shadow-sm" />
      </div>

      <Card className="w-full rounded-3xl border-slate-200/80 shadow-xl shadow-slate-900/5 dark:border-slate-800 dark:shadow-black/30">
        <CardContent className="px-8 pb-8 pt-24">
          <div className="mb-7 text-center">
            <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white">
              open<span className="text-teal-600 dark:text-teal-400">books</span>
            </h1>
            <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">{t('tagline')}</p>
          </div>

          <form onSubmit={submit} className="space-y-4">
            {mfaRequired ? (
              <div className="space-y-2">
                <Label htmlFor="mfa-code">{t('mfaCode')}</Label>
                <Input
                  id="mfa-code"
                  autoComplete="one-time-code"
                  autoFocus
                  required
                  value={mfaCode}
                  onChange={(e) => setMfaCode(e.target.value)}
                  placeholder={t('mfaPlaceholder')}
                  className="h-11 font-mono tracking-wider"
                />
                <p className="text-xs text-slate-500 dark:text-slate-400">{t('mfaHelp')}</p>
              </div>
            ) : (
              <>
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
                <div className="space-y-1.5">
                  <Label htmlFor="password">{t('password')}</Label>
                  <Input
                    id="password"
                    type="password"
                    autoComplete="current-password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="h-11"
                  />
                </div>
              </>
            )}
            {error ? (
              <p className="text-sm text-red-600 dark:text-red-400" role="alert">
                {error}
              </p>
            ) : null}
            <Button type="submit" disabled={busy} className="h-11 w-full text-base font-semibold">
              {busy ? t('signingIn') : mfaRequired ? t('verify') : t('signIn')}
            </Button>
            {!mfaRequired && oidc.enabled ? (
              <>
                <div className="flex items-center gap-3 text-xs uppercase tracking-wider text-slate-400">
                  <span className="h-px flex-1 bg-slate-200 dark:bg-slate-700" />
                  {t('or')}
                  <span className="h-px flex-1 bg-slate-200 dark:bg-slate-700" />
                </div>
                <a
                  href={`/api/auth/oidc/start?next=${encodeURIComponent(params.get('next') ?? '/')}`}
                  className="flex h-11 w-full items-center justify-center rounded-md border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-900 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-white dark:hover:bg-slate-800"
                >
                  {oidc.label}
                </a>
              </>
            ) : null}
          </form>
        </CardContent>
      </Card>
    </div>
  )
}

export default function Login() {
  return (
    <main className="grid h-full min-h-screen place-items-center bg-gradient-to-b from-white to-slate-100 p-4 pt-32 dark:from-slate-950 dark:to-slate-900">
      <Suspense>
        <LoginForm />
      </Suspense>
    </main>
  )
}
