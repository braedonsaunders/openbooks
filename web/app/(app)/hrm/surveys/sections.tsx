'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Button, Input, Label, Select, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, UrlDrawer } from '@openbooks/ui'
import { readApiErrorMessage } from '../../../../lib/api-error'
import type { loadSurveysHome } from '../../../../lib/hrm/surveys-home'

/**
 * Surveys drawer + author dialog islands (0230, HR-19).
 *
 * The drawer renders the aggregate results panel — eNPS tile,
 * participation, driver bars, the driver × segment heatmap as one
 * table with colour-scaled cells and suppression marks (suppressed
 * cells carry no number, never a traceable figure), comments, and the
 * pulse trend — plus open (with the recipient picker) and close
 * actions. The author dialog posts question cards. Every fetch
 * branches on res.ok FIRST.
 */

type Home = NonNullable<Awaited<ReturnType<typeof loadSurveysHome>>>
type Drawer = NonNullable<Home['drawer']>

function msg(labels: Record<string, string>, key: string): string {
  return labels[key] ?? key
}

async function post(url: string, body: unknown, failed: string): Promise<boolean> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    toast.error(await readApiErrorMessage(res, failed))
    return false
  }
  return true
}

/** Colour scale for a 1–5 mean: red (low) → amber → green (high). */
function heatColor(mean: number): string {
  const t = Math.min(1, Math.max(0, (mean - 1) / 4))
  return `hsl(${Math.round(t * 120)} 70% 88%)`
}

function Heatmap({ results, suppressedLabel }: { results: NonNullable<Drawer['results']>; suppressedLabel: string }) {
  const heat = results.heat
  if (heat.drivers.length === 0 || heat.segments.length === 0) return null
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead />
            {heat.segments.map((segment) => (
              <TableHead key={segment}>{segment}</TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {heat.drivers.map((driver) => (
            <TableRow key={driver}>
              <TableCell>{driver}</TableCell>
              {heat.segments.map((segment) => {
                const cell = heat.cells[driver]?.[segment]
                if (!cell || cell.suppressed || cell.mean === null) {
                  return (
                    <TableCell key={segment} title={suppressedLabel}>
                      <span aria-label={suppressedLabel}>•</span>
                    </TableCell>
                  )
                }
                return (
                  <TableCell key={segment} style={{ backgroundColor: heatColor(cell.mean) }}>
                    {cell.mean.toFixed(2)}
                  </TableCell>
                )
              })}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

function ResultsPanel({ drawer }: { drawer: Drawer }) {
  const router = useRouter()
  const labels = drawer.labels
  const survey = drawer.survey
  const results = drawer.results
  const [inviting, setInviting] = useState(false)
  const [checked, setChecked] = useState<string[]>([])
  if (!survey || !results) {
    return <p className="text-sm text-slate-500 dark:text-slate-400">{drawer.missingDetail}</p>
  }
  const people = drawer.people
  const base = `/api/hrm/surveys/${survey.id}`

  async function open() {
    if (await post(`${base}?action=open`, { partyIds: checked }, msg(labels, 'actionFailed'))) {
      setInviting(false)
      router.refresh()
    }
  }

  async function close() {
    if (await post(`${base}?action=close`, {}, msg(labels, 'actionFailed'))) router.refresh()
  }

  function toggle(id: string) {
    setChecked((prev) => (prev.includes(id) ? prev.filter((c) => c !== id) : [...prev, id]))
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap gap-2">
        {survey.status === 'draft' && (
          <Button onClick={() => setInviting((v) => !v)}>{msg(labels, 'open')}</Button>
        )}
        {survey.status === 'open' && (
          <Button variant="outline" onClick={close}>{msg(labels, 'close')}</Button>
        )}
      </div>
      {inviting && survey.status === 'draft' && (
        <section>
          <h3 className="mb-2 text-sm font-semibold">{msg(labels, 'inviteLabel')}</h3>
          <div className="flex max-h-48 flex-col gap-1 overflow-y-auto">
            {people.map((p) => (
              <label key={p.value} className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={checked.includes(p.value)} onChange={() => toggle(p.value)} />
                {p.label}
              </label>
            ))}
          </div>
          <div className="mt-2 flex gap-2">
            <Button onClick={open} disabled={checked.length === 0}>{msg(labels, 'open')}</Button>
            <Button variant="outline" onClick={() => setInviting(false)}>{msg(labels, 'cancel')}</Button>
          </div>
        </section>
      )}
      <section className="grid grid-cols-2 gap-3">
        <div className="rounded-md border p-3">
          <p className="text-xs text-slate-500">{msg(labels, 'participation')}</p>
          <p className="text-xl font-semibold tabular-nums">
            {results.participationPct === null ? '—' : `${results.participationPct}%`}
          </p>
          <p className="text-xs text-slate-500 tabular-nums">{results.responded}/{results.invitations}</p>
        </div>
        <div className="rounded-md border p-3">
          <p className="text-xs text-slate-500">{msg(labels, 'enps')}</p>
          <p className="text-xl font-semibold tabular-nums">{results.enps?.score ?? '—'}</p>
        </div>
      </section>
      {results.drivers.length > 0 && (
        <section>
          <h3 className="mb-2 text-sm font-semibold">{msg(labels, 'drivers')}</h3>
          <ul className="flex flex-col gap-2">
            {results.drivers.map((driver) => (
              <li key={driver.driver}>
                <div className="flex justify-between text-sm">
                  <span>{driver.driver}</span>
                  <span className="tabular-nums">{driver.mean.toFixed(2)} · {driver.responses}</span>
                </div>
                <div className="h-2 overflow-hidden rounded bg-slate-100 dark:bg-slate-800">
                  <div className="h-full rounded bg-emerald-500" style={{ width: `${Math.min(100, (driver.mean / 5) * 100)}%` }} />
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
      <section>
        <h3 className="mb-2 text-sm font-semibold">{msg(labels, 'heatmap')}</h3>
        <Heatmap results={results} suppressedLabel={msg(labels, 'suppressed')} />
      </section>
      {results.comments.length > 0 && (
        <section>
          <h3 className="mb-2 text-sm font-semibold">{msg(labels, 'comments')}</h3>
          {results.comments.map((comment) => (
            <div key={comment.questionId} className="mb-3">
              <p className="text-sm font-medium">{comment.prompt}</p>
              <ul className="mt-1 flex flex-col gap-1">
                {comment.texts.map((text, index) => (
                  <li key={index} className="rounded bg-slate-50 p-2 text-sm dark:bg-slate-900">{text}</li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      )}
      {results.trend.length > 1 && (
        <section>
          <h3 className="mb-2 text-sm font-semibold">{msg(labels, 'trend')}</h3>
          <Table>
            <TableBody>
              {results.trend.map((point) => (
                <TableRow key={point.surveyId}>
                  <TableCell>{point.name}</TableCell>
                  <TableCell>{point.enps === null ? '—' : point.enps}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </section>
      )}
      <section>
        <h3 className="mb-2 text-sm font-semibold">{msg(labels, 'questions')}</h3>
        <ul className="flex flex-col gap-1 text-sm">
          {survey.questions.map((question) => (
            <li key={question.id} className="flex justify-between gap-3">
              <span>{question.prompt}</span>
              <span className="text-slate-500">{question.kind}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}

export function SurveysDrawer({ drawer }: { drawer: Home['drawer'] }) {
  if (!drawer) return null
  return (
    <UrlDrawer open closeHref={drawer.closeHref} title={drawer.title}>
      <ResultsPanel drawer={drawer as Drawer} />
    </UrlDrawer>
  )
}

interface QuestionCard {
  kind: string
  prompt: string
  options: string
  driverKey: string
}

export function SurveysAuthorDialog({ author }: { author: Home['author'] }) {
  const router = useRouter()
  const [name, setName] = useState('')
  const [kind, setKind] = useState('engagement')
  const [anonymity, setAnonymity] = useState('anonymous')
  const [minGroup, setMinGroup] = useState('5')
  const [questions, setQuestions] = useState<QuestionCard[]>([{ kind: 'scale', prompt: '', options: '', driverKey: '' }])
  const [failed, setFailed] = useState<string | null>(null)
  if (!author) return null
  const labels = author.labels

  function setQuestion(index: number, patch: Partial<QuestionCard>) {
    setQuestions((prev) => prev.map((q, i) => (i === index ? { ...q, ...patch } : q)))
  }

  async function submit() {
    setFailed(null)
    const ok = await post(
      '/api/hrm/surveys',
      {
        name,
        kind,
        anonymity,
        minGroupSize: Number(minGroup) || 5,
        questions: questions.map((q) => ({
          kind: q.kind,
          prompt: q.prompt,
          ...(q.kind === 'single' || q.kind === 'multi'
            ? { options: q.options.split('\n').map((o) => o.trim()).filter(Boolean) }
            : {}),
          ...(q.driverKey.trim() ? { driverKey: q.driverKey.trim() } : {}),
        })),
      },
      msg(labels, 'failed'),
    )
    if (!ok) {
      setFailed(msg(labels, 'failed'))
      return
    }
    router.push('/hrm/surveys')
    router.refresh()
  }

  return (
    <UrlDrawer open closeHref={author.closeHref} title={msg(labels, 'title')}>
      <div className="flex flex-col gap-4">
        <div>
          <Label>{msg(labels, 'name')}</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>{msg(labels, 'kind')}</Label>
            <Select value={kind} onChange={(e) => setKind(e.target.value)}>
              {author.kinds.map((k) => (
                <option key={k.value} value={k.value}>{k.label}</option>
              ))}
            </Select>
          </div>
          <div>
            <Label>{msg(labels, 'anonymity')}</Label>
            <Select value={anonymity} onChange={(e) => setAnonymity(e.target.value)}>
              {author.anonymity.map((a) => (
                <option key={a.value} value={a.value}>{a.label}</option>
              ))}
            </Select>
          </div>
        </div>
        <div>
          <Label>{msg(labels, 'minGroup')}</Label>
          <Input type="number" min={2} max={1000} value={minGroup} onChange={(e) => setMinGroup(e.target.value)} />
        </div>
        <h3 className="text-sm font-semibold">{msg(labels, 'questions')}</h3>
        {questions.map((question, index) => (
          <div key={index} className="flex flex-col gap-2 rounded-md border p-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>{msg(labels, 'prompt')}</Label>
                <Input value={question.prompt} onChange={(e) => setQuestion(index, { prompt: e.target.value })} />
              </div>
              <div>
                <Label>{msg(labels, 'kind')}</Label>
                <Select value={question.kind} onChange={(e) => setQuestion(index, { kind: e.target.value })}>
                  {author.questionKinds.map((k) => (
                    <option key={k.value} value={k.value}>{k.label}</option>
                  ))}
                </Select>
              </div>
            </div>
            <div>
              <Label>{msg(labels, 'driver')}</Label>
              <Input value={question.driverKey} onChange={(e) => setQuestion(index, { driverKey: e.target.value })} />
            </div>
            {(question.kind === 'single' || question.kind === 'multi') && (
              <div>
                <Label>{msg(labels, 'options')}</Label>
                <Input value={question.options} onChange={(e) => setQuestion(index, { options: e.target.value })} />
              </div>
            )}
            {questions.length > 1 && (
              <Button variant="outline" onClick={() => setQuestions((prev) => prev.filter((_, i) => i !== index))}>
                {msg(labels, 'remove')}
              </Button>
            )}
          </div>
        ))}
        <Button
          variant="outline"
          onClick={() => setQuestions((prev) => [...prev, { kind: 'scale', prompt: '', options: '', driverKey: '' }])}
        >
          {msg(labels, 'addQuestion')}
        </Button>
        {failed && <p className="text-sm text-red-600">{failed}</p>}
        <Button onClick={submit} disabled={!name.trim() || questions.some((q) => !q.prompt.trim())}>
          {msg(labels, 'submit')}
        </Button>
      </div>
    </UrlDrawer>
  )
}
