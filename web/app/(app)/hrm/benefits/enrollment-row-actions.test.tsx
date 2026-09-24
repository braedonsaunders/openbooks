import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'

const { JSDOM } = await import('jsdom')
const dom = new JSDOM('<!doctype html><html><body></body></html>')
for (const key of ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'Event', 'self']) {
  Object.defineProperty(globalThis, key, { value: (dom.window as unknown as Record<string, unknown>)[key], configurable: true })
}
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
Object.assign(globalThis, { React })

const { registerHooks } = await import('node:module')
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'next/navigation') {
      return { shortCircuit: true, url: 'data:text/javascript,export function useRouter(){return {refresh(){}}}' }
    }
    if (specifier === 'sonner') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export const toast={error(message){globalThis.__actionErrors.push(message)}}',
      }
    }
    if (specifier.endsWith('/lib/prompt')) {
      return { shortCircuit: true, url: 'data:text/javascript,export async function promptDialog(){return null}' }
    }
    return next(specifier, context)
  },
})

const { createRoot } = await import('react-dom/client')
const { act } = await import('react')
const { EnrollmentRowActions } = await import('./EnrollmentRowActions')
const { ComplianceActions } = await import('../compliance/ComplianceActions')

async function checkRefusal(render: React.ReactNode): Promise<string[]> {
  const errors: string[] = []
  ;(globalThis as Record<string, unknown>).__actionErrors = errors
  const previousFetch = globalThis.fetch
  globalThis.fetch = (async () => new Response('upstream failure', { status: 503 })) as typeof fetch
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  try {
    await act(async () => root.render(render))
    const approve = Array.from(document.querySelectorAll('button')).find((button) => button.textContent?.trim() === 'Approve')
    assert.ok(approve, 'the manager sees the approval action')
    await act(async () => {
      approve!.click()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    return errors
  } finally {
    await act(async () => root.unmount())
    host.remove()
    globalThis.fetch = previousFetch
  }
}

test('enrollment refusal falls back to an action failure message, not the Approve button label', async () => {
  const errors = await checkRefusal(
    <EnrollmentRowActions
      enrollmentId="enrollment-1"
      enrollmentStatus="pending_approval"
      approveLabel="Approve"
      failedLabel="This action could not be completed."
      canManage
    />,
  )
  assert.deepEqual(errors, ['This action could not be completed. (status 503)'])
})

test('compliance approval refusal uses its action failure copy, not the Approve label', async () => {
  const errors = await checkRefusal(
    <ComplianceActions
      actionKind="entry"
      rowId="entry-1"
      rowStatus="computed"
      entryKind="per_diem"
      canManage
      acknowledgeLabel="Acknowledge"
      resolveLabel="Resolve"
      approveLabel="Approve"
      voidLabel="Void"
      submitLabel="Submit"
      failedLabel="This action could not be completed."
    />,
  )
  assert.deepEqual(errors, ['This action could not be completed. (status 503)'])
})
