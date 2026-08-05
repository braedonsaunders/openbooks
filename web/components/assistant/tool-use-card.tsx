'use client'

// A single tool call rendered as a tidy, expandable card. Driven by the SDK
// part `state`: input-streaming/input-available →
// spinner; output-available → check; output-error → alert. The same card
// renders live and on transcript reload.

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import {
  AlertCircle,
  BookOpenText,
  CheckCircle2,
  ChevronRight,
  Database,
  FileText,
  Landmark,
  Loader2,
  Scale,
  ScrollText,
  Search,
  ShieldCheck,
  Sparkles,
  TrendingUp,
  Users,
  Wallet,
  type LucideIcon,
} from 'lucide-react'
import { cn } from '@openbooks/ui'

type ToolState = 'input-streaming' | 'input-available' | 'output-available' | 'output-error'

/** Tool → past-tense i18n key (assistant.tools.*) + icon. */
const META: Record<string, { labelKey: string; icon: LucideIcon }> = {
  whoami: { labelKey: 'whoami', icon: ShieldCheck },
  find_accounts: { labelKey: 'find_accounts', icon: Search },
  account_register: { labelKey: 'account_register', icon: BookOpenText },
  find_journal_entries: { labelKey: 'find_journal_entries', icon: Search },
  get_journal_entry: { labelKey: 'get_journal_entry', icon: ScrollText },
  find_documents: { labelKey: 'find_documents', icon: Search },
  get_document: { labelKey: 'get_document', icon: FileText },
  find_parties: { labelKey: 'find_parties', icon: Users },
  profit_and_loss: { labelKey: 'profit_and_loss', icon: TrendingUp },
  balance_sheet: { labelKey: 'balance_sheet', icon: Landmark },
  trial_balance: { labelKey: 'trial_balance', icon: Scale },
  aging: { labelKey: 'aging', icon: Wallet },
  cash_flow: { labelKey: 'cash_flow', icon: Wallet },
  draft_journal_entry: { labelKey: 'draft_journal_entry', icon: Sparkles },
}

function summarize(output: unknown): string | null {
  if (!output || typeof output !== 'object') return null
  const o = output as Record<string, unknown>
  if (o.ok === false) return typeof o.error === 'string' ? o.error.replace(/_/g, ' ') : 'failed'
  const data = (o.data ?? o) as Record<string, unknown>
  if (typeof data.total === 'number') return String(data.total)
  if (typeof data.returned === 'number') return String(data.returned)
  return null
}

export function ToolUseCard({
  name,
  state,
  input,
  output,
}: {
  name: string
  state: ToolState
  input?: unknown
  output?: unknown
}) {
  const t = useTranslations('assistant')
  const [open, setOpen] = useState(false)
  const meta = META[name]
  const label = meta ? t(`tools.${meta.labelKey}`) : name.replace(/_/g, ' ')
  const Icon = meta?.icon ?? Database
  const running = state === 'input-streaming' || state === 'input-available'
  const errored = state === 'output-error' || (output as { ok?: boolean })?.ok === false
  const summary = summarize(output)

  return (
    <div className="overflow-hidden rounded-lg border border-slate-200 bg-slate-50/70 text-sm dark:border-slate-800 dark:bg-slate-900/50">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-slate-100/70 dark:hover:bg-slate-800/50"
      >
        <span
          className={cn(
            'flex h-6 w-6 shrink-0 items-center justify-center rounded-md',
            errored
              ? 'bg-red-100 text-red-600 dark:bg-red-950/50 dark:text-red-300'
              : 'bg-teal-100 text-teal-700 dark:bg-teal-950/50 dark:text-teal-300',
          )}
        >
          <Icon className="h-3.5 w-3.5" />
        </span>
        <span className="min-w-0 flex-1 truncate font-medium text-slate-700 dark:text-slate-200">
          {label}
        </span>
        {summary ? (
          <span className="shrink-0 text-xs text-slate-400 dark:text-slate-500">{summary}</span>
        ) : null}
        {running ? (
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-slate-400" />
        ) : errored ? (
          <AlertCircle className="h-3.5 w-3.5 shrink-0 text-red-500" />
        ) : (
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-teal-600 dark:text-teal-400" />
        )}
        <ChevronRight
          className={cn(
            'h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform',
            open && 'rotate-90',
          )}
        />
      </button>
      {open ? (
        <div className="space-y-2 border-t border-slate-200 px-3 py-2 dark:border-slate-800">
          {input !== undefined && input !== null && Object.keys(input).length > 0 ? (
            <Detail label={t('card.input')} value={input} />
          ) : null}
          {output !== undefined ? <Detail label={t('card.result')} value={output} /> : null}
        </div>
      ) : null}
    </div>
  )
}

function Detail({ label, value }: { label: string; value: unknown }) {
  return (
    <div>
      <div className="mb-1 text-[11px] font-semibold tracking-wide text-slate-400 uppercase dark:text-slate-500">
        {label}
      </div>
      <pre className="max-h-60 overflow-auto rounded-md bg-white p-2 text-xs leading-relaxed text-slate-700 ring-1 ring-slate-200 dark:bg-slate-950 dark:text-slate-300 dark:ring-slate-800">
        {safeStringify(value)}
      </pre>
    </div>
  )
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}
