'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button, Input, Label, Textarea, UrlDrawer } from '@openbooks/ui'
import { readApiErrorMessage } from '../../../../lib/api-error'
import { isUuid } from '../../../../lib/list-params'
import type { RecruitingPageData } from './view'

/** The same URL drawer and form primitives as the requisition create form. */
export function CandidatePoolCreateDrawer({
  create,
}: {
  create: NonNullable<RecruitingPageData['poolCreate']>
}) {
  const router = useRouter()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return (
    <UrlDrawer open title={create.title} closeHref={create.closeHref}>
      <form
        className="space-y-4"
        onSubmit={async (event) => {
          event.preventDefault()
          setBusy(true)
          setError(null)
          try {
            const response = await fetch('/api/hrm/recruiting/talent-pools', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                name: name.trim(),
                description: description.trim() || null,
              }),
            })
            if (!response.ok) {
              setError(await readApiErrorMessage(response, create.failed))
              return
            }
            const payload = (await response.json()) as {
              pool?: { id?: string }
            }
            if (!payload.pool?.id || !isUuid(payload.pool.id)) {
              setError(create.failed)
              return
            }
            const target = new URL(
              create.closeHref,
              'https://navigation.invalid',
            )
            target.searchParams.set('pool', payload.pool.id)
            router.push(`${target.pathname}${target.search}`)
            router.refresh()
          } catch {
            setError(create.failed)
          } finally {
            setBusy(false)
          }
        }}
      >
        <div>
          <Label htmlFor="candidate-pool-name">{create.nameLabel}</Label>
          <Input
            id="candidate-pool-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
            maxLength={120}
          />
        </div>
        <div>
          <Label htmlFor="candidate-pool-description">
            {create.descriptionLabel}
          </Label>
          <Textarea
            id="candidate-pool-description"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            maxLength={2000}
          />
        </div>
        {error ? (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {error}
          </p>
        ) : null}
        <Button disabled={busy || !name.trim()}>{create.submitLabel}</Button>
      </form>
    </UrlDrawer>
  )
}
