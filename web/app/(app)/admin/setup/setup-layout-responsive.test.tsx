import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'

// The shared setup shell's rail (SetupNav) composes its entries from the
// setup registry plus the feature and permission flags — a dropped entry
// strands its surface with no navigation, and a leaked gated entry invites
// the reader onto a refusal page. Proved here through the real rail.

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'next/navigation') {
      return {
        shortCircuit: true,
        format: 'module',
        url: `data:text/javascript,export function usePathname(){return '/admin/setup/company'}export function useRouter(){return {push(){},refresh(){},replace(){}}}export function useSearchParams(){return new URLSearchParams()}`,
      }
    }
    if (specifier === 'next/link') {
      return {
        shortCircuit: true,
        format: 'module',
        url: `data:text/javascript,export default function Link(p){return globalThis.React.createElement('a',{href:p.href,'aria-current':p['aria-current']},p.children)}`,
      }
    }
    return nextResolve(specifier, context)
  },
})

const React = await import('react')
Object.assign(globalThis, { React })
const { renderToStaticMarkup } = await import('react-dom/server')
const { NextIntlClientProvider } = await import('next-intl')
const messages = (await import('../../../../messages/en')).default
const { SetupNav } = await import('./SetupNav')

type NavProps = Parameters<typeof SetupNav>[0]

const BASE_PROPS: NavProps = {
  canExport: false,
  canImport: false,
  canManageSetup: true,
  hiddenEntityKeys: [],
  projectsEnabled: true,
  currencyEnabled: true,
  fixedAssetsEnabled: true,
  crmEnabled: true,
  bankFeedsEnabled: false,
  onlinePaymentsEnabled: false,
  payrollEnabled: false,
}

function renderNav(props: NavProps): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <SetupNav {...props} />
    </NextIntlClientProvider>,
  )
}

function hrefs(html: string): string[] {
  return [...html.matchAll(/href="([^"]+)"/g)].map((match) => match[1]!)
}

test('hidden registry entities drop out of the rail', () => {
  const shown = hrefs(renderNav(BASE_PROPS))
  assert.ok(shown.includes('/admin/setup/account-groups'), 'a visible entity links its surface')
  const hidden = hrefs(renderNav({ ...BASE_PROPS, hiddenEntityKeys: ['account-groups'] }))
  assert.ok(!hidden.includes('/admin/setup/account-groups'), 'a hidden entity leaves the rail')
  assert.ok(hidden.includes('/admin/setup/company'), 'the Company tab stays while siblings hide')
})

test('feature-gated entries follow their flags, never the install', () => {
  const off = hrefs(renderNav(BASE_PROPS))
  assert.ok(!off.includes('/admin/setup/bank-feeds'), 'bank feeds stay out while the flag is off')
  assert.ok(!off.includes('/admin/setup/payroll'), 'payroll stays out while the flag is off')
  const on = hrefs(
    renderNav({ ...BASE_PROPS, bankFeedsEnabled: true, onlinePaymentsEnabled: true, payrollEnabled: true }),
  )
  assert.ok(on.includes('/admin/setup/bank-feeds'), 'bank feeds link their surface once enabled')
  assert.ok(on.includes('/admin/setup/payment-providers'), 'online payments link their surface once enabled')
  assert.ok(on.includes('/admin/setup/payroll'), 'payroll links its surface once enabled')
})

test('readers without setup permission keep only the CRM entry', () => {
  const html = hrefs(renderNav({ ...BASE_PROPS, canManageSetup: false }))
  assert.ok(html.includes('/admin/setup/crm'), 'the CRM entry survives without the permission')
  assert.ok(!html.includes('/admin/setup/account-groups'), 'registry entities hide without the permission')
  assert.ok(!html.includes('/admin/setup/company'), 'the Company tab hides without the permission')
})
