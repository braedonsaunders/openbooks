import assert from 'node:assert/strict'
import test from 'node:test'

// A builder must never swallow a refusal: a refused reorder reports the
// server's reason and puts the stages back, and a refused save keeps the
// inspector open with the server's message in it.

const { bootJsdomEnvironment } = await import('../../../../../testing/jsdom-env')
await bootJsdomEnvironment({ url: 'http://localhost:4800/admin/setup/hiring-pipelines/p1', matchMediaMatches: false, scrollIntoView: false, resizeObserver: false })

const { registerHooks } = await import('node:module')
const { stubModules } = await import('../../../../../testing/stub-modules')
stubModules({ navigation: 'export function useRouter(){return {refresh(){},push(){},replace(){},back(){},forward(){}}}' })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'next/link') {
      return { shortCircuit: true, url: 'data:text/javascript,export default function Link(p){return p.children}' }
    }
    if (specifier === 'sonner') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export const toast={success(){},error(m){(globalThis.__toastErrors??=[]).push(m)},warning(){}};export function Toaster(){return null}',
      }
    }
    return next(specifier, context)
  },
})

declare global {
  var __toastErrors: string[] | undefined
}

const React = await import('react')
Object.assign(globalThis, { React })
const { createRoot } = await import('react-dom/client')
const { act } = await import('react')
const { NextIntlClientProvider } = await import('next-intl')
const messages = (await import('../../../../../messages/en')).default
const { PipelineBuilder } = await import('./PipelineBuilder')
import type { PipelineStageNode } from '../../../../../lib/setup/hrm-builder-outline'

const tick = () => new Promise((resolve) => setTimeout(resolve, 30))

const stage = (id: string, name: string, kind: PipelineStageNode['kind'], position: number): PipelineStageNode => ({
  id, position, key: id, name, kind, isTerminal: kind === 'hired' || kind === 'rejected',
  activeApplications: 0, totalApplications: 0, kits: [],
})
const PIPELINE = {
  id: 'p1', name: 'Campus', isDefault: false, isActive: true, requisitionCount: 0,
  stages: [stage('s1', 'Applied', 'screening', 0), stage('s2', 'Panel', 'interview', 1), stage('s3', 'Hired', 'hired', 2)],
}

async function mount(respond: (url: string, method: string) => Response) {
  globalThis.__toastErrors = []
  const calls: { url: string; method: string }[] = []
  globalThis.fetch = (async (input: unknown, init?: { method?: string }) => {
    const call = { url: String(input), method: init?.method ?? 'GET' }
    calls.push(call)
    return respond(call.url, call.method)
  }) as typeof fetch
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <PipelineBuilder pipeline={PIPELINE} />
      </NextIntlClientProvider>,
    )
    await tick()
  })
  return {
    host,
    calls,
    stageNames: () => [...host.querySelectorAll('ol')[1]!.querySelectorAll('li')].map((li) => li.querySelector('span.truncate')?.textContent),
    async click(el: Element) {
      await act(async () => {
        el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
        await tick()
        await tick()
      })
    },
    async unmount() {
      await act(async () => root.unmount())
      host.remove()
    },
  }
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

test('a refused reorder surfaces the refusal and restores the stage order', async () => {
  const m = await mount(() => json(409, { error: 'The outline changed since it was loaded — reload the page and reorder again', code: 'stale' }))
  try {
    assert.deepEqual(m.stageNames(), ['Applied', 'Panel', 'Hired'])
    const kebab = m.host.querySelectorAll('button[aria-label="Row actions"]')[0]!
    await m.click(kebab)
    const moveDown = [...document.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Move down')
    assert.ok(moveDown, 'the row menu offers Move down')
    await m.click(moveDown)
    assert.ok(m.calls.some((call) => call.method === 'PUT' && call.url.endsWith('/api/admin/setup/hiring-pipelines/p1/stages')))
    assert.deepEqual(globalThis.__toastErrors, ['The outline changed since it was loaded. Reload the page and try again.'])
    assert.deepEqual(m.stageNames(), ['Applied', 'Panel', 'Hired'], 'the optimistic move is rolled back')
  } finally {
    await m.unmount()
  }
})

test('a refused stage save keeps the server message in the inspector', async () => {
  const refusal = 'The stage kind must be screening, interview, assessment, offer, hired, or rejected'
  const m = await mount(() => json(400, { error: refusal, code: 'invalid' }))
  try {
    const row = [...m.host.querySelectorAll('button')].find((button) => button.textContent?.startsWith('Panel'))!
    await m.click(row)
    const name = m.host.querySelector('#stage-name') as HTMLInputElement
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(name, 'Panel interview')
      name.dispatchEvent(new window.Event('input', { bubbles: true }))
      await tick()
    })
    const save = [...m.host.querySelectorAll('button')].find((button) => button.textContent === 'Save changes')!
    await m.click(save)
    assert.ok(m.calls.some((call) => call.method === 'PATCH' && call.url.endsWith('/api/admin/setup/hrm-pipeline-stages')))
    assert.match(m.host.querySelector('[role="alert"]')?.textContent ?? '', /stage kind must be/)
    assert.equal((m.host.querySelector('#stage-name') as HTMLInputElement).value, 'Panel interview', 'the draft survives the refusal')
  } finally {
    await m.unmount()
  }
})
