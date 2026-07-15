'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Play } from 'lucide-react'
import { Alert, AlertDescription, Button, PageHeader, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, Textarea, cn } from '@openbooks/ui'
import { PageContainer } from '../../../components/page-layout'

const STARTER = `select a.number, a.name, sum(l.amount) as balance
  from journal_lines l
  join accounts a on a.id = l.account_id
 group by 1, 2
 order by abs(sum(l.amount)) desc
 limit 15`

export default function QueryConsole() {
  const t = useTranslations('query')
  const [sqlText, setSqlText] = useState(STARTER)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{
    columns: string[]
    rows: Record<string, unknown>[]
    rowCount: number
    truncated: boolean
    durationMs: number
  } | null>(null)

  async function run() {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sql: sqlText }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
      setResult(data)
    } catch (e) {
      setError((e as Error).message)
      setResult(null)
    } finally {
      setBusy(false)
    }
  }

  return (
    <PageContainer>
      <PageHeader title={t('title')} description={t('description')} />
      <div className="mt-6 space-y-4">
        <Textarea
          className="min-h-36 font-mono text-[13px]"
          value={sqlText}
          onChange={(e) => setSqlText(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault()
              run()
            }
          }}
          spellCheck={false}
        />
        <Button onClick={run} disabled={busy}>
          <Play size={14} />
          {busy ? t('running') : t('run')}
        </Button>

        {error ? (
          <Alert variant="destructive">
            <AlertDescription className="font-mono text-xs whitespace-pre-wrap">{error}</AlertDescription>
          </Alert>
        ) : null}

        {result ? (
          <div className="space-y-2">
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {t('resultSummary', {
                count: result.rowCount,
                truncated: result.truncated ? 'true' : 'false',
                duration: result.durationMs,
              })}
            </p>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    {result.columns.map((c) => (
                      <TableHead key={c}>{c}</TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {result.rows.map((r, i) => (
                    <TableRow key={i}>
                      {result.columns.map((c) => {
                        const v = r[c]
                        const isNum = typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v)
                        return (
                          <TableCell key={c} className={cn(isNum && 'text-right font-mono text-[13px] tabular-nums')}>
                            {v === null ? <span className="text-slate-400">∅</span> : String(v)}
                          </TableCell>
                        )
                      })}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        ) : null}
      </div>
    </PageContainer>
  )
}
