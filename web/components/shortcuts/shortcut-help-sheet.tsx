'use client'

import { Fragment } from 'react'
import { useTranslations } from 'next-intl'
import { Drawer } from '@openbooks/ui'
import { DATE_ENTRY_KEYS } from '../../lib/date-entry'
import { bindingKeys, SCOPE_ORDER, shortcutLabel, type RegisteredShortcut } from './shortcut-keys'
import { EntryPreferencesPanel } from '../entry-preferences-panel'

/** Keys every line grid, list picker and amount field accepts, in reading order. */
const ENTRY_KEYS: ReadonlyArray<{ id: string; keys: (apple: boolean) => string[]; separator?: string }> = [
  { id: 'gridEnter', keys: () => ['Enter'] },
  { id: 'gridShiftEnter', keys: (apple) => [apple ? '⇧' : 'Shift', 'Enter'] },
  { id: 'gridArrows', keys: () => ['↑', '↓'], separator: '/' },
  { id: 'gridTab', keys: () => ['Tab'] },
  { id: 'gridInsertBelow', keys: (apple) => [apple ? '⌥' : 'Alt', 'Enter'] },
  { id: 'gridInsertAbove', keys: (apple) => [apple ? '⌥' : 'Alt', apple ? '⇧' : 'Shift', 'Enter'] },
  { id: 'gridCopyAbove', keys: () => ['F8'] },
  { id: 'gridDuplicate', keys: (apple) => [apple ? '⌘' : 'Ctrl', 'D'] },
  { id: 'gridRemove', keys: (apple) => [apple ? '⌘' : 'Ctrl', '⌫'] },
  { id: 'gridMove', keys: (apple) => [apple ? '⌥' : 'Alt', '↑/↓'] },
  { id: 'gridMenu', keys: (apple) => [apple ? '⇧' : 'Shift', 'F10'] },
  { id: 'gridPaste', keys: (apple) => [apple ? '⌘' : 'Ctrl', 'V'] },
  { id: 'pickerType', keys: () => ['A–Z'] },
  { id: 'pickerTab', keys: () => ['Tab'] },
  { id: 'pickerOpen', keys: () => ['F4'] },
  { id: 'amountMath', keys: () => ['+', '−', '×', '÷'] },
  { id: 'fieldHelp', keys: () => ['F1'] },
]

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
 * opened, grouped by scope, then the keys every date field accepts and how
 * typed dates and the calendar work. Key caps follow the viewer's platform.
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
  const tEntry = useTranslations('entry.keys')
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
          <Row label={tDate('calendarKey')}>
            <KeyCaps keys={[apple ? '⌥' : 'Alt', '↓']} />
          </Row>
        </Group>
        <p className="text-xs leading-relaxed text-slate-500 dark:text-slate-400">{tDate('repeatHint')}</p>
        <p className="text-xs leading-relaxed text-slate-500 dark:text-slate-400">{tDate('typingHint')}</p>
        <p className="text-xs leading-relaxed text-slate-500 dark:text-slate-400">{tDate('calendarHint')}</p>
        <Group title={tEntry('title')}>
          {ENTRY_KEYS.map((entry) => (
            <Row key={entry.id} label={tEntry(entry.id)}>
              <KeyCaps keys={entry.keys(apple)} separator={entry.separator} />
            </Row>
          ))}
        </Group>
        <section className="space-y-1">
          <h3 className="text-[11px] font-semibold tracking-wider text-slate-400 uppercase dark:text-slate-500">{tEntry('preferencesTitle')}</h3>
          <EntryPreferencesPanel className="-mx-1" />
        </section>
      </div>
    </Drawer>
  )
}
