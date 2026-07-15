'use client'

import { Suspense, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Button, Card, CardContent, Input, Label } from '@openbooks/ui'
import { Logo } from '../../components/brand-logo'

function LoginForm() {
  const t = useTranslations('login')
  const tCommon = useTranslations('common')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const router = useRouter()
  const params = useSearchParams()

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    })
    if (res.ok) {
      router.push(params.get('next') ?? '/')
      router.refresh()
    } else {
      setError(t('invalidCredentials'))
      setBusy(false)
    }
  }

  return (
    <Card className="w-full max-w-sm">
      <CardContent className="p-7">
        <div className="mb-6 space-y-1">
          <Logo />
          <p className="text-sm text-slate-500 dark:text-slate-400">{t('tagline')}</p>
        </div>
        <form onSubmit={submit} className="space-y-4">
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
            />
          </div>
          {error ? <p className="text-sm text-red-600 dark:text-red-400">{error}</p> : null}
          <Button type="submit" className="w-full" disabled={busy}>
            {busy ? t('signingIn') : t('signIn')}
          </Button>
        </form>
      </CardContent>
    </Card>
  )
}

export default function Login() {
  return (
    <div className="grid h-full place-items-center bg-slate-50 p-4 dark:bg-slate-950">
      <Suspense>
        <LoginForm />
      </Suspense>
    </div>
  )
}
