'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import {
  Building2,
  ClipboardList,
  Contact,
  FileMinus2,
  FilePlus2,
  Landmark,
  Package,
  Plus,
  Receipt,
  ScrollText,
  Send,
  ShoppingCart,
  UserRound,
  UsersRound,
  WalletCards,
} from 'lucide-react'
import { Popover, cn } from '@openbooks/ui'
import { toast } from 'sonner'

export interface GlobalCreatePermissions {
  accountsReceivable: boolean
  accountsPayable: boolean
  journal: boolean
  customerPayments: boolean
  vendorPayments: boolean
  expenses: boolean
  parties: boolean
  items: boolean
  projects: boolean
  assets: boolean
}

type CreateKey =
  | 'invoice'
  | 'creditMemo'
  | 'estimate'
  | 'salesOrder'
  | 'customerPayment'
  | 'bill'
  | 'vendorCredit'
  | 'purchaseOrder'
  | 'vendorPayment'
  | 'journal'
  | 'expense'
  | 'cardCharge'
  | 'cardRefund'
  | 'check'
  | 'deposit'
  | 'transfer'
  | 'customer'
  | 'vendor'
  | 'employee'
  | 'item'
  | 'project'
  | 'asset'

type GroupKey = 'sales' | 'purchases' | 'accounting' | 'peopleAndLists'

interface CreateAction {
  key: CreateKey
  group: GroupKey
  enabled: (permissions: GlobalCreatePermissions) => boolean
  icon: typeof Plus
  endpoint: string
  body?: Record<string, string>
  destination: (id: string) => string
}

const ACTIONS: CreateAction[] = [
  { key: 'invoice', group: 'sales', enabled: (p) => p.accountsReceivable, icon: FilePlus2, endpoint: '/api/documents/draft', body: { kind: 'customer_invoice' }, destination: (id) => `/ar/invoices?doc=${id}&mode=edit` },
  { key: 'creditMemo', group: 'sales', enabled: (p) => p.accountsReceivable, icon: FileMinus2, endpoint: '/api/documents/draft', body: { kind: 'customer_credit' }, destination: (id) => `/ar/invoices?doc=${id}&mode=edit` },
  { key: 'estimate', group: 'sales', enabled: (p) => p.accountsReceivable, icon: ClipboardList, endpoint: '/api/estimates/draft', destination: (id) => `/estimates?estimate=${id}&mode=edit` },
  { key: 'salesOrder', group: 'sales', enabled: (p) => p.accountsReceivable, icon: Send, endpoint: '/api/sales-orders/draft', destination: (id) => `/sales-orders?order=${id}&mode=edit` },
  { key: 'customerPayment', group: 'sales', enabled: (p) => p.customerPayments, icon: WalletCards, endpoint: '/api/payments/draft', body: { kind: 'customer_payment' }, destination: (id) => `/receipts?payment=${id}&mode=edit` },
  { key: 'bill', group: 'purchases', enabled: (p) => p.accountsPayable, icon: Receipt, endpoint: '/api/documents/draft', body: { kind: 'vendor_bill' }, destination: (id) => `/ap/bills?doc=${id}&mode=edit` },
  { key: 'vendorCredit', group: 'purchases', enabled: (p) => p.accountsPayable, icon: FileMinus2, endpoint: '/api/documents/draft', body: { kind: 'vendor_credit' }, destination: (id) => `/ap/bills?doc=${id}&mode=edit` },
  { key: 'purchaseOrder', group: 'purchases', enabled: (p) => p.accountsPayable, icon: ShoppingCart, endpoint: '/api/purchase-orders/draft', destination: (id) => `/purchase-orders?order=${id}&mode=edit` },
  { key: 'vendorPayment', group: 'purchases', enabled: (p) => p.vendorPayments, icon: WalletCards, endpoint: '/api/payments/draft', body: { kind: 'vendor_payment' }, destination: (id) => `/payments?payment=${id}&mode=edit` },
  { key: 'journal', group: 'accounting', enabled: (p) => p.journal, icon: ScrollText, endpoint: '/api/journals/draft', destination: (id) => `/journal?entry=${id}&mode=edit` },
  { key: 'expense', group: 'accounting', enabled: (p) => p.expenses, icon: Receipt, endpoint: '/api/expenses/draft', destination: (id) => `/expenses/reports?expense=${id}&mode=edit` },
  { key: 'cardCharge', group: 'accounting', enabled: (p) => p.accountsPayable, icon: WalletCards, endpoint: '/api/documents/draft', body: { kind: 'card_charge' }, destination: (id) => `/banking/transactions?doc=${id}&mode=edit` },
  { key: 'cardRefund', group: 'accounting', enabled: (p) => p.accountsPayable, icon: WalletCards, endpoint: '/api/documents/draft', body: { kind: 'card_refund' }, destination: (id) => `/banking/transactions?doc=${id}&mode=edit` },
  { key: 'check', group: 'accounting', enabled: (p) => p.accountsPayable, icon: FileMinus2, endpoint: '/api/documents/draft', body: { kind: 'check' }, destination: (id) => `/banking/transactions?doc=${id}&mode=edit` },
  { key: 'deposit', group: 'accounting', enabled: (p) => p.journal, icon: Landmark, endpoint: '/api/documents/draft', body: { kind: 'deposit' }, destination: (id) => `/banking/transactions?doc=${id}&mode=edit` },
  { key: 'transfer', group: 'accounting', enabled: (p) => p.journal, icon: Send, endpoint: '/api/documents/draft', body: { kind: 'transfer' }, destination: (id) => `/banking/transactions?doc=${id}&mode=edit` },
  { key: 'asset', group: 'accounting', enabled: (p) => p.assets, icon: Landmark, endpoint: '/api/assets/draft', body: {}, destination: (id) => `/assets?asset=${id}` },
  { key: 'customer', group: 'peopleAndLists', enabled: (p) => p.parties, icon: UsersRound, endpoint: '/api/parties/draft', body: { role: 'customer' }, destination: (id) => `/entities/customers?party=${id}&mode=edit` },
  { key: 'vendor', group: 'peopleAndLists', enabled: (p) => p.parties, icon: Building2, endpoint: '/api/parties/draft', body: { role: 'vendor' }, destination: (id) => `/entities/vendors?party=${id}&mode=edit` },
  { key: 'employee', group: 'peopleAndLists', enabled: (p) => p.parties, icon: UserRound, endpoint: '/api/parties/draft', body: { role: 'employee' }, destination: (id) => `/entities/employees?party=${id}&mode=edit` },
  { key: 'item', group: 'peopleAndLists', enabled: (p) => p.items, icon: Package, endpoint: '/api/items/draft', body: {}, destination: (id) => `/items?item=${id}` },
  { key: 'project', group: 'peopleAndLists', enabled: (p) => p.projects, icon: Contact, endpoint: '/api/projects/draft', body: {}, destination: (id) => `/projects?project=${id}` },
]

const GROUPS: GroupKey[] = ['sales', 'purchases', 'accounting', 'peopleAndLists']

/** Prominent shell-level instant-create menu for every record the user may create. */
export function GlobalCreateMenu({ permissions }: { permissions: GlobalCreatePermissions }) {
  const t = useTranslations('shell.globalCreate')
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<CreateKey | null>(null)
  const available = useMemo(() => ACTIONS.filter((action) => action.enabled(permissions)), [permissions])

  if (available.length === 0) return null

  async function create(action: CreateAction) {
    setOpen(false)
    setBusy(action.key)
    try {
      const response = await fetch(action.endpoint, {
        method: 'POST',
        ...(action.body
          ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(action.body) }
          : {}),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok || typeof data.id !== 'string') {
        throw new Error(typeof data.error === 'string' ? data.error : t('createFailed'))
      }
      router.push(action.destination(data.id) as never)
      router.refresh()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('createFailed'))
    } finally {
      setBusy(null)
    }
  }

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      align="end"
      className="w-[min(34rem,calc(100vw-1.5rem))] overflow-hidden rounded-xl p-0"
      trigger={
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          disabled={busy !== null}
          aria-label={t('ariaLabel')}
          aria-expanded={open}
          className={cn(
            'group relative grid h-9 w-9 shrink-0 place-items-center overflow-hidden rounded-xl bg-gradient-to-br from-teal-500 to-cyan-600 text-white shadow-sm shadow-teal-600/25 transition-all',
            'hover:-translate-y-0.5 hover:shadow-md hover:shadow-teal-600/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 focus-visible:ring-offset-2',
            'disabled:cursor-wait disabled:opacity-70 dark:from-teal-400 dark:to-cyan-500 dark:text-slate-950 dark:shadow-black/20 dark:focus-visible:ring-offset-slate-900',
          )}
        >
          <span className="absolute inset-0 bg-white/0 transition-colors group-hover:bg-white/10" />
          <Plus className={cn('relative h-5 w-5 transition-transform', open && 'rotate-45', busy && 'animate-pulse')} strokeWidth={2.5} />
        </button>
      }
    >
      <div className="border-b border-slate-100 bg-gradient-to-r from-teal-50 to-cyan-50 px-4 py-3 dark:border-slate-800 dark:from-teal-950/50 dark:to-cyan-950/30">
        <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t('title')}</p>
        <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{t('description')}</p>
      </div>
      <div className="grid max-h-[min(32rem,calc(100vh-8rem))] grid-cols-1 gap-x-2 overflow-y-auto p-2 sm:grid-cols-2">
        {GROUPS.map((group) => {
          const actions = available.filter((action) => action.group === group)
          if (actions.length === 0) return null
          return (
            <section key={group} className="p-1.5">
              <h3 className="px-2 pb-1.5 text-[11px] font-semibold tracking-wider text-slate-400 uppercase dark:text-slate-500">
                {t(`groups.${group}`)}
              </h3>
              <div className="space-y-0.5">
                {actions.map((action) => {
                  const Icon = action.icon
                  return (
                    <button
                      key={action.key}
                      type="button"
                      disabled={busy !== null}
                      onClick={() => create(action)}
                      className="group/item flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left text-sm text-slate-700 transition-colors hover:bg-teal-50 hover:text-teal-900 disabled:opacity-50 dark:text-slate-200 dark:hover:bg-teal-950/40 dark:hover:text-teal-100"
                    >
                      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-slate-100 text-slate-500 transition-colors group-hover/item:bg-white group-hover/item:text-teal-600 dark:bg-slate-800 dark:text-slate-400 dark:group-hover/item:bg-slate-900 dark:group-hover/item:text-teal-300">
                        <Icon size={16} />
                      </span>
                      <span className="font-medium">{t(`items.${action.key}`)}</span>
                    </button>
                  )
                })}
              </div>
            </section>
          )
        })}
      </div>
    </Popover>
  )
}
