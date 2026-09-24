import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'

const { JSDOM } = await import('jsdom')
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/hrm/processes' })
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  self: dom.window,
  React,
  IS_REACT_ACT_ENVIRONMENT: true,
})
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true })
const { registerHooks } = await import('node:module')
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'next/navigation') {
      return { shortCircuit: true, url: "data:text/javascript,export const useRouter=()=>({refresh(){}})" }
    }
    if (specifier === 'next-intl') {
      return { shortCircuit: true, url: 'data:text/javascript,export const useTranslations=()=>key=>key' }
    }
    if (specifier === '@openbooks/ui') {
      return {
        shortCircuit: true,
        url: `data:text/javascript,const React=globalThis.React;export const Button=({children,...p})=>React.createElement('button',p,children);export const Label=({children,...p})=>React.createElement('label',p,children);export const Textarea=p=>React.createElement('textarea',p);export const SearchSelect=({options,onSearchChange,id})=>React.createElement('div',null,React.createElement('input',{id,onInput:e=>onSearchChange(e.target.value)}),...options.map(o=>React.createElement('option',{key:o.value,value:o.value},o.label)))`,
      }
    }
    if (specifier.endsWith('/lib/use-app-action')) {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export const useAppAction=()=>({busy:false,async execute(){return false}})',
      }
    }
    return next(specifier, context)
  },
})

const { createRoot } = await import('react-dom/client')
const { act } = await import('react')
const { ProcessChecklistBody } = await import('./processes-client')

const detail = {
  id: 'proc-1',
  kind: 'onboarding',
  effectiveDate: '2026-09-01',
  status: 'open',
  employmentId: 'employment-1',
  workerPartyId: 'worker-1',
  workerName: 'Worker',
  openedByChangeId: null,
  progress: { total: 1, required: 1, doneRequired: 0, allRequiredDone: false },
  steps: [
    {
      id: 'step-1',
      position: 0,
      title: 'Attach evidence',
      description: null,
      ownerKind: 'manager',
      ownerPartyId: null,
      dueOn: '2026-09-15',
      required: true,
      evidenceKind: 'attachment',
      status: 'pending',
      overdue: false,
    },
  ],
} as never

test('file suggestions are query-bound and a failed new search reports an error', async (t) => {
  const realFetch = globalThis.fetch
  globalThis.fetch = async (input) => {
    const url = String(input)
    if (url.includes('q=first')) return Response.json({ files: [{ id: 'old-file', name: 'Old result' }] })
    return new Response('unavailable', { status: 503 })
  }
  t.after(() => { globalThis.fetch = realFetch })

  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  await act(async () => root.render(<ProcessChecklistBody detail={detail} />))
  const input = host.querySelector('input')!

  await act(async () => {
    input.value = 'first'
    input.dispatchEvent(new window.Event('input', { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 300))
  })
  assert.ok(host.textContent?.includes('Old result'))

  await act(async () => {
    input.value = 'second'
    input.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
  assert.ok(!host.textContent?.includes('Old result'), 'results for the previous query must immediately become unavailable')

  await act(async () => new Promise((resolve) => setTimeout(resolve, 300)))
  assert.ok(!host.textContent?.includes('Old result'), 'a refused query must not restore old suggestions')
  assert.ok(host.querySelector('[role="alert"]')?.textContent?.includes('processes.fileSearchFailed'))
  await act(async () => root.unmount())
  host.remove()
})
