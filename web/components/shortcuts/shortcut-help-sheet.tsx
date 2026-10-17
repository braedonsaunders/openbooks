'use client'

import { Fragment } from 'react'
import { useTranslations } from 'next-intl'
import { Drawer } from '@openbooks/ui'
import { DATE_ENTRY_KEYS } from '../../lib/date-entry'
import { bindingKeys, SCOPE_ORDER, shortcutLabel, type RegisteredShortcut } from './shortcut-keys'

const KEY_CAP =
  'inline-flex min-w-[1.5rem] items-center justify-center rounded border border-slate-200 bg-white px-1.5 py-0.5 font-sans text-[11px] font-medium text-slate-600 shadow-[0_1px_0_rgba(15,23,42,0.08)] dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300'

function KeyCaps({ keys, separator }: { keys: readonly string[]; separator?: string }) {
  return (
    <span className="flex shrink-0 items-center gap-1">
      {keys.map((key, index) => (
        <Fragment key={`${key}-${index}`}>
          {separator && index > 0 ? <span className="text-[11px] text-slate-400 dark:text-slate-500">{separator}</span> : null}
          <kbd className={KEY_CAP}>{key}</kbd>
        </Fragment>
      ))}
    </span>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <li className="flex items-center justify-between gap-4 py-2 text-sm text-slate-700 dark:text-slate-200">
      <span className="min-w-0">{label}</span>
      {children}
    </li>
  )
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-1">
      <h3 className="text-[11px] font-semibold tracking-wider text-slate-400 uppercase dark:text-slate-500">{title}</h3>
      <ul className="divide-y divide-slate-100 dark:divide-slate-800">{children}</ul>
    </section>
  )
}

/**
 * The keyboard reference: the commands available where focus stood when it
 * opened, grouped by scope, then the date-field keys every date input
 * accepts. Key caps follow the viewer's platform.
 */
export function ShortcutHelpSheet({
  open,
  commands,
  apple,
  onClose,
}: {
  open: boolean
  commands: readonly RegisteredShortcut[]
  apple: boolean
  onClose: () => void
}) {
  const t = useTranslations('shell.shortcuts')
  const tDate = useTranslations('shell.dateEntry')
  return (
    <Drawer open={open} onClose={onClose} title={t('title')} description={t('description')} size="sm" stacked>
      <div className="space-y-6">
        {SCOPE_ORDER.map((scope) => {
          const scoped = commands.filter((command) => command.scope === scope)
          if (scoped.length === 0) return null
          return (
            <Group key={scope} title={t(`scopes.${scope}`)}>
              {scoped.map((command) => (
                <Row key={command.id} label={shortcutLabel(command)}>
                  <KeyCaps keys={bindingKeys(command.binding, apple)} />
                </Row>
              ))}
            </Group>
          )
        })}
        <Group title={tDate('title')}>
          {DATE_ENTRY_KEYS.map((entry) => (
            <Row key={entry.command} label={tDate(`keys.${entry.command}`)}>
              <KeyCaps keys={entry.keys.slice(0, 1).map((key) => key.toUpperCase())} />
            </Row>
          ))}
        </Group>
        <p className="text-xs leading-relaxed text-slate-500 dark:text-slate-400">{tDate('repeatHint')}</p>
        <p className="text-xs leading-relaxed text-slate-500 dark:text-slate-400">{tDate('pasteHint')}</p>
      </div>
    </Drawer>
  )
}
