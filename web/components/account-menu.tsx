'use client'

// Top-bar account menu: a compact "launcher" landing — an identity header over a
// grid of icon cards (Organizations, Language, Theme, Menu layout, …). Each card
// drills into a submenu rendered in the SAME bounded popover, with its options as
// an inline scrollable list. This keeps the menu a fixed, on-screen size no matter
// how many tenants or languages exist (the old flat menu grew tall and its nested
// dropdowns opened off-screen).

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import {
  Building2,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Languages,
  LayoutPanelLeft,
  LogOut,
  Palette,
  ShieldAlert,
  type LucideIcon,
} from 'lucide-react'
import { Popover, cn } from '@openbooks/ui'
import { ThemeToggle } from './theme-toggle'
import { EnvironmentPicker } from './environment-picker'
import { LOCALES, type Locale } from '../i18n/config'
import { NAV_MODES, type NavMode } from '../lib/nav-mode'
import type { WorkspaceEnvironments } from '../lib/environments'

// Two-letter monogram from a display name, falling back to the email. Handles the
// "Last, First" directory convention so the initials read First+Last either way.
function initialsFrom(name: string, email: string): string {
  const base = (name.trim() || email.trim()).trim()
  if (!base) return '?'
  const ordered = base.includes(',') ? base.split(',').reverse().join(' ') : base
  const parts = ordered.split(/\s+/).filter(Boolean)
  if (parts.length === 0) return base.slice(0, 1).toUpperCase()
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase()
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase()
}

// The built-in users.role enum — custom role slugs render verbatim.
const ROLE_KEYS = ['admin', 'controller', 'accountant', 'approver', 'viewer']

type View = 'home' | 'tenants' | 'language' | 'theme' | 'layout'

async function signOut() {
  await fetch('/api/login', { method: 'DELETE' })
}

export function AccountMenu({
  name,
  email,
  role,
  localePreference,
  navModePreference,
  environments,
}: {
  name: string
  email: string
  role: string
  localePreference: Locale | null
  navModePreference: NavMode | null
  environments: WorkspaceEnvironments
}) {
  const t = useTranslations('shell.accountMenu')
  const tLang = useTranslations('shell.language')
  const tMenu = useTranslations('shell.menuMode')
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [view, setView] = useState<View>('home')
  const [pending, startSignOut] = useTransition()
  const [, startRefresh] = useTransition()
  const [locale, setLocale] = useState(localePreference ?? '')
  const [navMode, setNavMode] = useState(navModePreference ?? '')
  const [saving, setSaving] = useState(false)

  const label = name || email || t('account')
  const initials = initialsFrom(name, email)
  const inSandbox = environments.envKind !== 'production'
  const showTenants =
    environments.tenants.length > 1 ||
    environments.tenants.some((tn) => tn.sandboxes.length > 0) ||
    inSandbox

  const localeLabel = locale
    ? (LOCALES.find((l) => l.code === locale)?.label ?? locale)
    : tLang('orgDefault')
  const layoutLabel = navMode ? tMenu(`options.${navMode}`) : tMenu('orgDefault')

  function close() {
    setOpen(false)
    // reset to the landing view for next open, after the close animation
    setTimeout(() => setView('home'), 150)
  }

  async function savePref(body: Record<string, string | null>, onErr: () => void, fail: string) {
    setSaving(true)
    try {
      const res = await fetch('/api/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        onErr()
        toast.error(fail)
        return
      }
      startRefresh(() => router.refresh())
      close()
    } finally {
      setSaving(false)
    }
  }

  const pickLocale = (v: string) => {
    const prev = locale
    setLocale(v)
    void savePref({ locale: v || null }, () => setLocale(prev), tLang('saveFailed'))
  }
  const pickLayout = (v: string) => {
    const prev = navMode
    setNavMode(v)
    void savePref({ navMode: v || null }, () => setNavMode(prev), tMenu('saveFailed'))
  }

  return (
    <Popover
      open={open}
      onOpenChange={(v) => {
        setOpen(v)
        if (!v) setTimeout(() => setView('home'), 150)
      }}
      align="end"
      className="w-72"
      trigger={
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-label={t('menuAriaLabel')}
          aria-expanded={open}
          aria-haspopup="menu"
          className="flex shrink-0 items-center gap-2 rounded-md border border-transparent px-1.5 py-1 text-sm text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800"
        >
          <span className="grid h-7 w-7 place-items-center rounded-full bg-slate-200 text-xs font-semibold text-slate-700 dark:bg-slate-700 dark:text-slate-100">
            {initials}
          </span>
          <span className="hidden min-w-0 max-w-[11rem] flex-col text-left sm:flex">
            <span className="truncate text-sm leading-tight">{label}</span>
            <span
              className={cn(
                'truncate text-[11px] leading-tight',
                inSandbox ? 'text-amber-600 dark:text-amber-400' : 'text-slate-400 dark:text-slate-500',
              )}
            >
              {inSandbox ? `${environments.currentName} · sandbox` : environments.currentName}
            </span>
          </span>
          <ChevronDown size={14} className="hidden shrink-0 text-slate-400 sm:inline dark:text-slate-500" />
        </button>
      }
    >
      {view === 'home' ? (
        <div>
          {/* identity */}
          <div className="flex items-center gap-3 px-3 py-3">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-gradient-to-br from-teal-500 to-teal-600 text-sm font-semibold text-white">
              {initials}
            </span>
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">{label}</span>
              {email ? (
                <span className="truncate text-xs text-slate-500 dark:text-slate-400">{email}</span>
              ) : null}
              <span className="mt-0.5 w-fit rounded-full bg-slate-100 px-1.5 py-px text-[10px] font-medium text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                {ROLE_KEYS.includes(role) ? t(`roles.${role}`) : role}
              </span>
            </span>
          </div>

          {/* card grid */}
          <div className="grid grid-cols-2 gap-2 px-2 pb-2">
            {showTenants && (
              <Card
                icon={Building2}
                tint="bg-teal-50 text-teal-600 dark:bg-teal-950/40 dark:text-teal-400"
                label={t('organizations')}
                sub={inSandbox ? `${environments.currentName} · sandbox` : environments.currentName}
                subTone={inSandbox ? 'text-amber-600 dark:text-amber-400' : undefined}
                onClick={() => setView('tenants')}
              />
            )}
            <Card
              icon={Languages}
              tint="bg-sky-50 text-sky-600 dark:bg-sky-950/40 dark:text-sky-400"
              label={t('language')}
              sub={localeLabel}
              onClick={() => setView('language')}
            />
            <Card
              icon={Palette}
              tint="bg-violet-50 text-violet-600 dark:bg-violet-950/40 dark:text-violet-400"
              label={t('theme')}
              onClick={() => setView('theme')}
            />
            <Card
              icon={LayoutPanelLeft}
              tint="bg-amber-50 text-amber-600 dark:bg-amber-950/40 dark:text-amber-400"
              label={t('menuLayout')}
              sub={layoutLabel}
              onClick={() => setView('layout')}
            />
            {environments.isSuperAdmin && (
              <Link
                href="/platform"
                onClick={close}
                className="group relative flex flex-col gap-2 rounded-xl border border-slate-200 bg-white p-3 transition-colors hover:border-slate-300 hover:bg-slate-50 dark:border-slate-800 dark:bg-slate-900 dark:hover:border-slate-700 dark:hover:bg-slate-800/60"
              >
                <span className="grid h-9 w-9 place-items-center rounded-lg bg-rose-50 text-rose-600 dark:bg-rose-950/40 dark:text-rose-400">
                  <ShieldAlert size={18} />
                </span>
                <span className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">
                  {t('superAdmin')}
                </span>
              </Link>
            )}
          </div>

          {/* sign out */}
          <div className="border-t border-slate-100 p-1 dark:border-slate-800">
            <button
              type="button"
              disabled={pending}
              role="menuitem"
              onClick={() =>
                startSignOut(async () => {
                  await signOut()
                  router.replace('/login')
                })
              }
              className="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-60 dark:text-slate-200 dark:hover:bg-slate-800/60"
            >
              <LogOut size={15} className="text-slate-500 dark:text-slate-400" />
              {pending ? t('signingOut') : t('signOut')}
            </button>
          </div>
        </div>
      ) : (
        <div>
          <SubHeader
            title={
              view === 'tenants'
                ? t('organizations')
                : view === 'language'
                  ? t('language')
                  : view === 'theme'
                    ? t('theme')
                    : t('menuLayout')
            }
            onBack={() => setView('home')}
          />
          {view === 'tenants' && (
            <EnvironmentPicker env={environments} hideHeading onNavigate={close} />
          )}
          {view === 'language' && (
            <div className="max-h-72 overflow-y-auto p-1">
              <OptionRow label={tLang('orgDefault')} active={locale === ''} disabled={saving} onClick={() => pickLocale('')} />
              {LOCALES.map((l) => (
                <OptionRow
                  key={l.code}
                  label={l.label}
                  active={locale === l.code}
                  disabled={saving}
                  onClick={() => pickLocale(l.code)}
                />
              ))}
            </div>
          )}
          {view === 'layout' && (
            <div className="p-1">
              <OptionRow label={tMenu('orgDefault')} active={navMode === ''} disabled={saving} onClick={() => pickLayout('')} />
              {NAV_MODES.map((m) => (
                <OptionRow
                  key={m}
                  label={tMenu(`options.${m}`)}
                  active={navMode === m}
                  disabled={saving}
                  onClick={() => pickLayout(m)}
                />
              ))}
            </div>
          )}
          {view === 'theme' && (
            <div className="p-3">
              <ThemeToggle />
            </div>
          )}
        </div>
      )}
    </Popover>
  )
}

function Card({
  icon: Icon,
  tint,
  label,
  sub,
  subTone,
  onClick,
}: {
  icon: LucideIcon
  tint: string
  label: string
  sub?: string
  subTone?: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group relative flex flex-col gap-2 rounded-xl border border-slate-200 bg-white p-3 text-left transition-colors hover:border-slate-300 hover:bg-slate-50 dark:border-slate-800 dark:bg-slate-900 dark:hover:border-slate-700 dark:hover:bg-slate-800/60"
    >
      <span className={cn('grid h-9 w-9 place-items-center rounded-lg', tint)}>
        <Icon size={18} />
      </span>
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium text-slate-900 dark:text-slate-100">{label}</span>
        {sub ? (
          <span className={cn('block truncate text-[11px]', subTone ?? 'text-slate-400 dark:text-slate-500')}>
            {sub}
          </span>
        ) : null}
      </span>
      <ChevronRight
        size={14}
        className="absolute right-2.5 top-3 text-slate-300 transition-transform group-hover:translate-x-0.5 dark:text-slate-600"
      />
    </button>
  )
}

function SubHeader({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <div className="flex items-center gap-1.5 border-b border-slate-100 px-2 py-2 dark:border-slate-800">
      <button
        type="button"
        onClick={onBack}
        aria-label="Back"
        className="grid h-7 w-7 place-items-center rounded-md text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
      >
        <ChevronLeft size={16} />
      </button>
      <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">{title}</span>
    </div>
  )
}

function OptionRow({
  label,
  active,
  disabled,
  onClick,
}: {
  label: string
  active: boolean
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={active}
      disabled={disabled}
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-60 dark:text-slate-200 dark:hover:bg-slate-800/60"
    >
      <Check size={15} className={cn('shrink-0', active ? 'text-teal-600 dark:text-teal-400' : 'text-transparent')} />
      <span className="truncate">{label}</span>
    </button>
  )
}
