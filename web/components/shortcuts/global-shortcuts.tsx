'use client'

import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { queryDrawerRouteGuard } from '@openbooks/ui'
import { useGlobalCreate, type GlobalCreateKey, type GlobalCreatePermissions } from '../global-create-menu'
import type { SidebarNavGroup } from '../sidebar-nav'
import { useShortcuts } from './shortcut-provider'
import type { ShortcutCommand } from './shortcut-keys'

const CREATE_SHORTCUTS: ReadonlyArray<{ id: string; create: GlobalCreateKey; code: string }> = [
  { id: 'newInvoice', create: 'invoice', code: 'KeyI' },
  { id: 'newBill', create: 'bill', code: 'KeyB' },
  { id: 'newJournal', create: 'journal', code: 'KeyJ' },
  { id: 'newExpense', create: 'expense', code: 'KeyX' },
  { id: 'newCustomerPayment', create: 'customerPayment', code: 'KeyR' },
]

const GO_SHORTCUTS: ReadonlyArray<{ id: string; href: string; code: string }> = [
  { id: 'goDashboard', href: '/dashboard', code: 'KeyH' },
  { id: 'goReports', href: '/reports', code: 'KeyP' },
  { id: 'goBanking', href: '/banking', code: 'KeyK' },
]

/** Whether the reader's resolved navigation offers `href` (permission, feature and tenant menu applied). */
function navigationOffers(groups: readonly SidebarNavGroup[], href: string): boolean {
  return groups.some((group) => group.groupHref === href || group.items.some((item) => item.href === href))
}

/**
 * Application-wide Ctrl+Alt (⌃⌥) commands. A create command exists only
 * when the shell's create menu offers it (the same permission and feature
 * resolution), and runs the menu's own create path; a go-to command exists
 * only when the reader's navigation includes the destination.
 */
export function GlobalShortcuts({
  permissions,
  groups,
}: {
  permissions: GlobalCreatePermissions
  groups: readonly SidebarNavGroup[]
}) {
  const t = useTranslations('shell.shortcuts.commands')
  const router = useRouter()
  const { available, create } = useGlobalCreate(permissions)
  const offered = new Set(available.map((action) => action.key))

  const commands: ShortcutCommand[] = [
    ...CREATE_SHORTCUTS.filter((shortcut) => offered.has(shortcut.create)).map((shortcut): ShortcutCommand => ({
      id: shortcut.id,
      label: t(shortcut.id),
      binding: { modifier: 'chord', code: shortcut.code },
      scope: 'global',
      run: () => void create(shortcut.create),
    })),
    ...GO_SHORTCUTS.filter((shortcut) => navigationOffers(groups, shortcut.href)).map((shortcut): ShortcutCommand => ({
      id: shortcut.id,
      label: t(shortcut.id),
      binding: { modifier: 'chord', code: shortcut.code },
      scope: 'global',
      run: () => {
        void queryDrawerRouteGuard().then((allowed) => {
          if (allowed) router.push(shortcut.href as never)
        })
      },
    })),
  ]
  useShortcuts(commands)
  return null
}
