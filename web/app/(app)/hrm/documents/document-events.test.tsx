import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'

const { registerHooks } = await import('node:module')
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'sonner') {
      return { shortCircuit: true, url: 'data:text/javascript,export const toast = { success(){}, error(){} }' }
    }
    if (specifier === 'next/navigation') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export const useRouter = () => ({ refresh(){}, push(){}, replace(){} })',
      }
    }
    return next(specifier, context)
  },
})
const { DocumentDrawerBody } = await import('./sections')
// tsx compiles JSX classic: the island never imports React, so the test bridges it.
Object.assign(globalThis, { React })

type Drawer = Parameters<typeof DocumentDrawerBody>[0]['drawer']

const labels: Record<string, string> = {
  send: 'Send',
  remind: 'Remind',
  hold: 'Hold',
  releaseHold: 'Release hold',
  void: 'Void',
  signers: 'Signers',
  noSigners: 'No signers.',
  events: 'Events',
  noEvents: 'No events.',
  eventCreated: 'Created',
  eventSent: 'Sent',
  eventViewed: 'Viewed',
  eventSigned: 'Signed',
  eventDeclined: 'Declined',
  eventAcknowledged: 'Acknowledged',
  eventVoided: 'Voided',
  eventReminded: 'Reminded',
  eventExpired: 'Expired',
  eventRetentionFlagged: 'Flagged for retention',
  eventDeleted: 'Deleted',
  actionFailed: 'Failed.',
}

function drawerWith(events: { kind: string; recordedAt: string }[], canManage = true): Drawer {
  return {
    closeHref: '/hrm/documents',
    title: 'Offer letter',
    // F3-38: the write actions follow the loader grant.
    canManage,
    document: {
      id: 'doc-1',
      status: 'sent',
      legalHold: false,
      fileId: null,
      retainUntil: null,
      retentionAction: null,
      retentionUnverified: false,
      signers: [],
      events: events.map((e) => ({ ...e, actor: null })),
    },
    signerNames: {},
    missingDetail: null,
    labels,
  } as unknown as Drawer
}

async function renderText(drawer: Drawer): Promise<{ text: string; doc: Document; unmount: () => Promise<void> }> {
  const { JSDOM } = await import('jsdom')
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/hrm/documents',
  })
  const previous = {
    window: (globalThis as Record<string, unknown>).window,
    document: (globalThis as Record<string, unknown>).document,
    navigator: (globalThis as Record<string, unknown>).navigator,
    self: (globalThis as Record<string, unknown>).self,
  }
  Object.defineProperty(globalThis, 'window', { value: dom.window, configurable: true, writable: true })
  Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true, writable: true })
  Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true, writable: true })
  Object.defineProperty(globalThis, 'self', { value: dom.window, configurable: true, writable: true })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  const doc = dom.window.document
  const { createRoot } = await import('react-dom/client')
  const { act } = await import('react')
  const root = createRoot(doc.getElementById('root')!)
  await act(async () => {
    root.render(<DocumentDrawerBody drawer={drawer} />)
  })
  return {
    text: doc.body.textContent ?? '',
    doc: doc as unknown as Document,
    unmount: async () => {
      await act(async () => {
        root.unmount()
      })
      Object.defineProperty(globalThis, 'window', { value: previous.window, configurable: true, writable: true })
      Object.defineProperty(globalThis, 'document', { value: previous.document, configurable: true, writable: true })
      Object.defineProperty(globalThis, 'navigator', { value: previous.navigator, configurable: true, writable: true })
      Object.defineProperty(globalThis, 'self', { value: previous.self, configurable: true, writable: true })
    },
  }
}

test('F3-67: document events render translated labels, never raw codes', async () => {
  const m = await renderText(
    drawerWith([
      { kind: 'created', recordedAt: '2026-09-01' },
      { kind: 'sent', recordedAt: '2026-09-02' },
      { kind: 'retention_flagged', recordedAt: '2026-09-03' },
    ]),
  )
  try {
    assert.match(m.text, /Created/, 'the created event renders its label')
    assert.match(m.text, /Sent/, 'the sent event renders its label')
    assert.match(m.text, /Flagged for retention/, 'the retention event renders its label')
    assert.ok(!m.text.includes('retention_flagged'), 'no raw event code leaks into the display')
  } finally {
    await m.unmount()
  }
})

test('F3-67: an unrecognized event kind falls back to its code, never blank', async () => {
  const m = await renderText(drawerWith([{ kind: 'mystery_kind', recordedAt: '2026-09-04' }]))
  try {
    assert.match(m.text, /mystery_kind/, 'an unknown kind stays visible as its code')
  } finally {
    await m.unmount()
  }
})

test('F3-38: a sent document offers Send, Remind, Hold and Void to the manage grant', async () => {
  const m = await renderText(drawerWith([{ kind: 'sent', recordedAt: '2026-09-02' }], true))
  try {
    const buttons = [...m.doc.querySelectorAll('button')].map((b) => b.textContent ?? '')
    for (const label of ['Send', 'Remind', 'Hold', 'Void']) {
      assert.ok(buttons.includes(label), `${label} renders for the manage grant`)
    }
  } finally {
    await m.unmount()
  }
})

test('F3-38: a read-only viewer sees the document with no Send, Remind, Hold or Void', async () => {
  const m = await renderText(drawerWith([{ kind: 'sent', recordedAt: '2026-09-02' }], false))
  try {
    // The body carries no title (the UrlDrawer owns it) — Signers/Events
    // prove the detail still renders without the grant.
    assert.match(m.text, /Signers/, 'the document detail stays readable without the grant')
    const buttons = [...m.doc.querySelectorAll('button')].map((b) => b.textContent ?? '')
    for (const label of ['Send', 'Remind', 'Hold', 'Void']) {
      assert.ok(!buttons.includes(label), `${label} never renders without the manage grant`)
    }
  } finally {
    await m.unmount()
  }
})
