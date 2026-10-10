import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { bootJsdomEnvironment } from '../../../testing/jsdom-env'
import { stubModules } from '../../../testing/stub-modules'

await bootJsdomEnvironment({ url: 'http://localhost/me/profile?edit=1', matchMediaMatches: false, event: 'jsdom' })

const profileWindow = window as unknown as { matchMedia?: (query: string) => unknown }
profileWindow.matchMedia = () => ({
  matches: false,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
  dispatchEvent() {
    return false
  },
})

stubModules({
  navigation: {
    source:
      'export function useRouter(){return {refresh(){},push(){},replace(){}}}' +
      'export function usePathname(){return "/me/profile"}' +
      'export function useSearchParams(){return new URLSearchParams()}',
  },
  intl: false,
  authz: false,
  features: false,
  extra: {
    'next/link': 'export default function Link(p){return p.children}',
  },
})
const { NextIntlClientProvider } = await import('next-intl')
const { readFileSync } = await import('node:fs')
const { ProfileDialog } = await import('../islands')
// tsx compiles JSX classic: the island never imports React, so the test bridges it.
Object.assign(globalThis, { React })

const messages = {
  hrm: JSON.parse(readFileSync(new URL('../../../messages/en/hrm.json', import.meta.url), 'utf8')),
  common: JSON.parse(readFileSync(new URL('../../../messages/en/common.json', import.meta.url), 'utf8')),
  ui: JSON.parse(readFileSync(new URL('../../../messages/en/ui.json', import.meta.url), 'utf8')),
}

type Dialog = Parameters<typeof ProfileDialog>[0]['dialog']

const NO_EMPLOYMENT = messages.hrm.me.profile.noEmployment as string

function dialogWith(employments: { value: string; label: string }[]): Dialog {
  return {
    title: 'Edit profile',
    description: 'Changes file as a request.',
    employments,
    employmentLabel: 'Employment',
    phoneLabel: 'Phone',
    emailLabel: 'Email',
    addressLabel: 'Address',
    line1Label: 'Street',
    line2Label: 'Line 2',
    cityLabel: 'City',
    regionLabel: 'Region',
    postalCodeLabel: 'Postal code',
    countryLabel: 'Country',
    emergencyLabel: 'Emergency contact',
    emergencyNameLabel: 'Name',
    emergencyRelationshipLabel: 'Relationship',
    emergencyPhoneLabel: 'Phone',
    reasonLabel: 'Reason',
    reasonPlaceholder: 'What changed',
    clearHint: 'Clear',
    submitLabel: 'Submit for approval',
    cancelLabel: 'Cancel',
    submitFailed: 'The profile request could not be filed.',
    noEmployment: NO_EMPLOYMENT,
  } as unknown as Dialog
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 30))

async function renderDialog(selected: Dialog): Promise<{ unmount: () => Promise<void> }> {
  const prior = globalThis.fetch
  globalThis.fetch = (async () =>
    Response.json({ profile: { phone: null, email: null, emergencyContact: null, address: null } })) as typeof fetch
  const { createRoot } = await import('react-dom/client')
  const { act } = await import('react')
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <ProfileDialog dialog={selected} closeHref="/me/profile" />
      </NextIntlClientProvider>,
    )
    await tick()
  })
  await tick()
  await tick()
  return {
    unmount: async () => {
      globalThis.fetch = prior
      await act(async () => {
        root.unmount()
      })
      host.remove()
    },
  }
}

function submitButton(): HTMLButtonElement | undefined {
  return [...document.querySelectorAll('button')].find(
    (button) => button.textContent?.trim() === 'Submit for approval',
  ) as HTMLButtonElement | undefined
}

test('with no employment the dialog names the hire remedy and refuses submit', async (t) => {
  const { unmount } = await renderDialog(dialogWith([]))
  t.after(unmount)
  assert.ok(document.body.textContent?.includes(NO_EMPLOYMENT), 'the hire remedy renders proactively')
  const submit = submitButton()
  assert.ok(submit, 'submit renders')
  assert.equal(submit.disabled, true, 'nothing can file without a binding employment')
})

test('with an employment the dialog files normally with no hire notice', async (t) => {
  const { unmount } = await renderDialog(dialogWith([{ value: 'employment-1', label: 'Main Co — Active' }]))
  t.after(unmount)
  assert.ok(!document.body.textContent?.includes(NO_EMPLOYMENT), 'no hire notice when bound')
  const submit = submitButton()
  assert.ok(submit, 'submit renders')
  assert.equal(submit.disabled, false, 'a bound employment submits')
})

const { BankDetailsDialog } = await import('../islands')

type BankDialog = Parameters<typeof BankDetailsDialog>[0]['dialog']

function bankDialogWith(employments: { value: string; label: string }[]): BankDialog {
  return {
    title: 'Direct deposit',
    description: 'The bank account your pay goes to.',
    employments,
    employmentLabel: 'Employment',
    bankNameLabel: 'Bank name',
    accountLabel: 'Account number',
    accountHint: 'Sent once and never shown again.',
    countryLabel: 'Country',
    currencyLabel: 'Currency',
    routingLabel: 'Routing number',
    routingHint: 'Optional.',
    reasonLabel: 'Reason',
    reasonPlaceholder: 'Why this change',
    submitLabel: 'Submit bank change',
    cancelLabel: 'Cancel',
    submitFailed: 'The bank change could not be filed.',
    noEmployment: NO_EMPLOYMENT,
  } as unknown as BankDialog
}

async function renderBankDialog(selected: BankDialog): Promise<{ unmount: () => Promise<void> }> {
  const prior = globalThis.fetch
  const posts: { url: string; init?: RequestInit }[] = []
  ;(globalThis as Record<string, unknown>).__bankPosts = posts
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    posts.push({ url, init })
    return Response.json({ request: { id: 'req-1', status: 'applied' }, applied: true, notified: true })
  }) as typeof fetch
  const { createRoot } = await import('react-dom/client')
  const { act } = await import('react')
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <BankDetailsDialog dialog={selected} closeHref="/me/profile" />
      </NextIntlClientProvider>,
    )
    await tick()
  })
  await tick()
  await tick()
  return {
    unmount: async () => {
      globalThis.fetch = prior
      await act(async () => {
        root.unmount()
      })
      host.remove()
    },
  }
}

function setValue(id: string, value: string): void {
  const input = document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement | null
  assert.ok(input, `the ${id} field must render`)
  const setter = Object.getOwnPropertyDescriptor(
    input instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype,
    'value',
  )?.set as ((this: Element, value: string) => void) | undefined
  setter?.call(input, value)
  input.dispatchEvent(new window.Event('input', { bubbles: true }))
}

test('bank dialog with no employment names the hire remedy and refuses submit', async (t) => {
  const { unmount } = await renderBankDialog(bankDialogWith([]))
  t.after(unmount)
  assert.ok(document.body.textContent?.includes(NO_EMPLOYMENT), 'the hire remedy renders proactively')
  const submit = [...document.querySelectorAll('button')].find(
    (button) => button.textContent?.trim() === 'Submit bank change',
  ) as HTMLButtonElement | undefined
  assert.ok(submit, 'submit renders')
  assert.equal(submit.disabled, true, 'nothing can file without a binding employment')
})

test('bank dialog files the change with the number sent once over the wire', async (t) => {
  const { unmount } = await renderBankDialog(bankDialogWith([{ value: 'employment-1', label: 'Main Co — Active' }]))
  t.after(unmount)
  assert.ok(!document.body.textContent?.includes(NO_EMPLOYMENT), 'no hire notice when bound')
  await (async () => {
    const { act } = await import('react')
    await act(async () => {
      setValue('me-bank-name', 'First Bank')
      setValue('me-bank-account', '12345678')
      setValue('me-bank-reason', 'switched to direct deposit')
      await tick()
    })
    await tick()
  })()
  const submit = [...document.querySelectorAll('button')].find(
    (button) => button.textContent?.trim() === 'Submit bank change',
  ) as HTMLButtonElement | undefined
  assert.ok(submit, 'submit renders')
  const { act } = await import('react')
  await act(async () => {
    submit.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await tick()
  })
  await tick()
  await tick()
  const posts = (globalThis as Record<string, unknown>).__bankPosts as { url: string; init?: RequestInit }[]
  const post = posts.find((entry) => entry.url === '/api/hrm/me/bank-changes')
  assert.ok(post, 'submit posts the bank change')
  const body = JSON.parse(String(post?.init?.body)) as {
    employmentId?: string
    bank?: { bankName?: string; accountNumber?: string }
    reason?: string
  }
  assert.equal(body.employmentId, 'employment-1', 'the single employment binds silently')
  assert.equal(body.bank?.bankName, 'First Bank')
  assert.equal(body.bank?.accountNumber, '12345678', 'the number travels once over TLS; storage seals it')
  assert.equal(body.reason, 'switched to direct deposit')
})
