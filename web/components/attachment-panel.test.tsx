import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

type DependencyList = readonly unknown[]

type HookSlot =
  | { kind: 'state'; value: unknown }
  | { kind: 'ref'; value: { current: unknown } }
  | { kind: 'memo'; value: unknown; deps: DependencyList }
  | { kind: 'effect'; deps: DependencyList; cleanup: (() => void) | undefined }

interface ReactHookHarness {
  beginRender(): void
  commitEffects(): void
  reset(): void
  unmount(): void
  readonly dirty: boolean
  clearDirty(): void
  useCallback<T extends (...args: never[]) => unknown>(callback: T, deps: DependencyList): T
  useEffect(effect: () => void | (() => void), deps: DependencyList): void
  useMemo<T>(factory: () => T, deps: DependencyList): T
  useRef<T>(initial: T): { current: T }
  useState<T>(initial: T | (() => T)): [T, (next: T | ((current: T) => T)) => void]
}

function sameDeps(left: DependencyList, right: DependencyList): boolean {
  return left.length === right.length && left.every((value, index) => Object.is(value, right[index]))
}

function createReactHookHarness(): ReactHookHarness {
  const slots: HookSlot[] = []
  const pendingEffects: { slot: Extract<HookSlot, { kind: 'effect' }>; effect: () => void | (() => void) }[] = []
  let cursor = 0
  let isDirty = false

  return {
    beginRender() {
      cursor = 0
      pendingEffects.length = 0
      isDirty = false
    },
    commitEffects() {
      for (const pending of pendingEffects.splice(0)) {
        pending.slot.cleanup?.()
        const cleanup = pending.effect()
        pending.slot.cleanup = typeof cleanup === 'function' ? cleanup : undefined
      }
    },
    reset() {
      this.unmount()
      slots.length = 0
      pendingEffects.length = 0
      cursor = 0
      isDirty = false
    },
    unmount() {
      for (const slot of slots) {
        if (slot.kind === 'effect') slot.cleanup?.()
      }
    },
    get dirty() {
      return isDirty
    },
    clearDirty() {
      isDirty = false
    },
    useCallback<T extends (...args: never[]) => unknown>(callback: T, deps: DependencyList): T {
      return this.useMemo(() => callback, deps)
    },
    useEffect(effect, deps) {
      const index = cursor++
      const existing = slots[index]
      if (existing) {
        assert.equal(existing.kind, 'effect')
        if (!sameDeps(existing.deps, deps)) {
          existing.deps = deps
          pendingEffects.push({ slot: existing, effect })
        }
        return
      }
      const slot: Extract<HookSlot, { kind: 'effect' }> = { kind: 'effect', deps, cleanup: undefined }
      slots[index] = slot
      pendingEffects.push({ slot, effect })
    },
    useMemo<T>(factory, deps) {
      const index = cursor++
      const existing = slots[index]
      if (existing) {
        assert.equal(existing.kind, 'memo')
        if (sameDeps(existing.deps, deps)) return existing.value as T
        existing.deps = deps
        existing.value = factory()
        return existing.value as T
      }
      const slot: Extract<HookSlot, { kind: 'memo' }> = { kind: 'memo', deps, value: factory() }
      slots[index] = slot
      return slot.value as T
    },
    useRef<T>(initial) {
      const index = cursor++
      const existing = slots[index]
      if (existing) {
        assert.equal(existing.kind, 'ref')
        return existing.value as { current: T }
      }
      const value = { current: initial }
      slots[index] = { kind: 'ref', value }
      return value
    },
    useState<T>(initial) {
      const index = cursor++
      let slot = slots[index]
      if (slot) {
        assert.equal(slot.kind, 'state')
      } else {
        slot = {
          kind: 'state',
          value: typeof initial === 'function' ? (initial as () => T)() : initial,
        }
        slots[index] = slot
      }
      const stateSlot = slot as Extract<HookSlot, { kind: 'state' }>
      return [
        stateSlot.value as T,
        (next: T | ((current: T) => T)) => {
          const value = typeof next === 'function'
            ? (next as (current: T) => T)(stateSlot.value as T)
            : next
          stateSlot.value = value
          isDirty = true
        },
      ]
    },
  }
}

interface RenderedElement {
  type: unknown
  props: Record<string, unknown>
}

function isRenderedElement(value: unknown): value is RenderedElement {
  return typeof value === 'object' && value !== null && 'type' in value && 'props' in value
}

function findRenderedElement(
  value: unknown,
  predicate: (element: RenderedElement) => boolean,
): RenderedElement | null {
  if (Array.isArray(value)) {
    for (const child of value) {
      const match = findRenderedElement(child, predicate)
      if (match) return match
    }
    return null
  }
  if (!isRenderedElement(value)) return null
  if (predicate(value)) return value
  for (const prop of Object.values(value.props)) {
    const match = findRenderedElement(prop, predicate)
    if (match) return match
  }
  return null
}

function renderedText(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value)
  if (Array.isArray(value)) return value.map(renderedText).join('')
  return isRenderedElement(value) ? renderedText(value.props.children) : ''
}

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

type Attachment = {
  id: string
  name: string
  fileType: string
  contentType: string
  sizeBytes: number
  createdAt: string
  createdBy: string | null
  attachmentId: string
}

type RequestRecord = {
  targetId: string
  signal: AbortSignal | undefined
  response: Deferred<Response>
}

interface AttachmentPanelTestState {
  harness: ReactHookHarness
  errors: string[]
}

const testState: AttachmentPanelTestState = {
  harness: createReactHookHarness(),
  errors: [],
}
;(globalThis as typeof globalThis & Record<symbol, unknown>)[
  Symbol.for('openbooks.attachment-panel-test-state')
] = testState
// tsx compiles this legacy JSX module with the classic runtime in the test
// process; provide the tiny createElement surface its output calls.
;(globalThis as typeof globalThis & { React?: unknown }).React = {
  createElement(type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) {
    return {
      type,
      props: {
        ...props,
        ...(children.length === 0 ? {} : { children: children.length === 1 ? children[0] : children }),
      },
    }
  },
}

const mockUrls = new Map<string, string>([
  ['react', 'mock:react'],
  ['react/jsx-runtime', 'mock:jsx-runtime'],
  ['next/navigation', 'mock:next-navigation'],
  ['next-intl', 'mock:next-intl'],
  ['lucide-react', 'mock:icons'],
  ['sonner', 'mock:sonner'],
  ['@openbooks/ui', 'mock:ui'],
  ['../lib/format', 'mock:format'],
  ['./search-input', 'mock:search-input'],
  ['./filter-bar', 'mock:filter-bar'],
  ['./pagination', 'mock:pagination'],
])

const mockSources = new Map<string, string>([
  [
    'mock:react',
    `
      const harness = globalThis[Symbol.for('openbooks.attachment-panel-test-state')].harness
      export const useCallback = (callback, deps) => harness.useCallback(callback, deps)
      export const useEffect = (effect, deps) => harness.useEffect(effect, deps)
      export const useMemo = (factory, deps) => harness.useMemo(factory, deps)
      export const useRef = (initial) => harness.useRef(initial)
      export const useState = (initial) => harness.useState(initial)
    `,
  ],
  [
    'mock:jsx-runtime',
    `
      export const Fragment = Symbol.for('openbooks.attachment-panel-test-fragment')
      export function jsx(type, props, key) { return { type, props: props ?? {}, key: key ?? null } }
      export const jsxs = jsx
    `,
  ],
  [
    'mock:next-navigation',
    `
      const params = { get() { return null }, entries() { return [][Symbol.iterator]() } }
      export function usePathname() { return '/records' }
      export function useSearchParams() { return params }
    `,
  ],
  [
    'mock:next-intl',
    `
      const translate = (key) => key
      export function useTranslations() { return translate }
    `,
  ],
  [
    'mock:icons',
    `
      export function Download() { return null }
      export function ExternalLink() { return null }
      export function FileImage() { return null }
      export function FileText() { return null }
      export function Loader2() { return null }
      export function Maximize2() { return null }
      export function Minimize2() { return null }
      export function Paperclip() { return null }
      export function Trash2() { return null }
      export function UploadCloud() { return null }
    `,
  ],
  [
    'mock:sonner',
    `
      const state = globalThis[Symbol.for('openbooks.attachment-panel-test-state')]
      export const toast = { error(message) { state.errors.push(String(message)) }, success() {} }
    `,
  ],
  [
    'mock:ui',
    `
      export function Badge() { return null }
      export function Button() { return null }
      export function cn(...values) { return values.filter(Boolean).join(' ') }
    `,
  ],
  ['mock:format', `export function dateTime(value) { return value }`],
  [
    'mock:search-input',
    `export function SearchInput() { return null }`,
  ],
  [
    'mock:filter-bar',
    `export function FilterChips() { return null }`,
  ],
  [
    'mock:pagination',
    `export function Pagination() { return null }`,
  ],
])

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.includes('/web/components/attachment-panel.tsx')) {
      const mocked = mockUrls.get(specifier)
      if (mocked) return { url: mocked, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    const source = mockSources.get(url)
    if (source !== undefined) return { format: 'module', source, shortCircuit: true }
    return nextLoad(url, context)
  },
})

const { AttachmentPanel } = await import('./attachment-panel.tsx?attachment-panel-test')
hooks.deregister()

function attachment(id: string, name: string): Attachment {
  return {
    id,
    name,
    fileType: 'pdf',
    contentType: 'application/pdf',
    sizeBytes: 1024,
    createdAt: '2026-08-28T12:00:00.000Z',
    createdBy: null,
    attachmentId: `attachment-${id}`,
  }
}

function response(items: Attachment[]): Response {
  return new Response(JSON.stringify({ attachments: items }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function installDeferredFetch(): { requests: RequestRecord[]; restore(): void } {
  const requests: RequestRecord[] = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input), 'http://openbooks.test')
    const targetId = url.searchParams.get('targetId')
    assert.ok(targetId, 'attachment requests must identify their target record')
    const request = { targetId, signal: init?.signal, response: deferred<Response>() }
    requests.push(request)
    return request.response.promise
  }) as typeof fetch
  return {
    requests,
    restore() {
      globalThis.fetch = originalFetch
    },
  }
}

function renderPanel(targetId: string): RenderedElement {
  testState.harness.beginRender()
  let tree = AttachmentPanel({ targetTable: 'documents', targetId, canEdit: true }) as unknown as RenderedElement
  testState.harness.commitEffects()
  // Effects synchronously clear target-specific state and set loading. Render
  // once more so assertions observe the same committed state a user sees.
  if (testState.harness.dirty) {
    testState.harness.beginRender()
    tree = AttachmentPanel({ targetTable: 'documents', targetId, canEdit: true }) as unknown as RenderedElement
    testState.harness.commitEffects()
  }
  return tree
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
}

function loadingVisible(tree: RenderedElement): boolean {
  return renderedText(tree).includes('feedback.loading')
}

function buttonWithLabel(tree: RenderedElement, label: string): RenderedElement {
  const button = findRenderedElement(
    tree,
    (element) => typeof element.type === 'function' && element.type.name === 'Button' && element.props['aria-label'] === label,
  )
  assert.ok(button, `expected button ${label}`)
  return button
}

test('switching records aborts A, clears its state, and fences late A success/finalizer', async (t) => {
  testState.harness.reset()
  testState.errors.length = 0
  const transport = installDeferredFetch()
  t.after(() => transport.restore())

  let tree = renderPanel('record-a')
  assert.equal(transport.requests.length, 1)
  assert.equal(transport.requests[0]!.targetId, 'record-a')
  assert.equal(loadingVisible(tree), true)

  transport.requests[0]!.response.resolve(response([attachment('file-a', 'A.pdf')]))
  await settle()
  tree = renderPanel('record-a')
  assert.match(renderedText(tree), /A\.pdf/)
  assert.equal(loadingVisible(tree), false)

  buttonWithLabel(tree, 'expandPreviewAria').props.onClick?.()
  tree = renderPanel('record-a')
  assert.equal(findRenderedElement(tree, (element) => element.type === 'aside'), null)

  tree = renderPanel('record-b')
  assert.equal(transport.requests.length, 2)
  assert.equal(transport.requests[0]!.signal?.aborted, true, 'record A fetch is aborted on target change')
  assert.doesNotMatch(renderedText(tree), /A\.pdf/, 'record A files clear before record B resolves')
  assert.ok(findRenderedElement(tree, (element) => element.type === 'aside'), 'record-specific expanded state resets')
  assert.match(renderedText(tree), /previewEmptyDescription/, 'record-specific selection clears immediately')
  assert.equal(loadingVisible(tree), true)

  // This response is intentionally delivered after B is active and while B
  // remains loading. Both the stale success and its finally must be ignored.
  transport.requests[0]!.response.resolve(response([attachment('late-a', 'late-A.pdf')]))
  await settle()
  tree = renderPanel('record-b')
  assert.doesNotMatch(renderedText(tree), /late-A\.pdf/)
  assert.equal(loadingVisible(tree), true, 'late A finalizer cannot stop B loading')

  transport.requests[1]!.response.resolve(response([attachment('file-b', 'B.pdf')]))
  await settle()
  tree = renderPanel('record-b')
  assert.match(renderedText(tree), /B\.pdf/)
  assert.doesNotMatch(renderedText(tree), /A\.pdf|late-A\.pdf/)
  assert.equal(loadingVisible(tree), false)
  assert.deepEqual(testState.errors, [])
})

test('a late A error cannot replace B files or B loading/error state', async (t) => {
  testState.harness.reset()
  testState.errors.length = 0
  const transport = installDeferredFetch()
  t.after(() => transport.restore())

  renderPanel('record-a')
  let tree = renderPanel('record-b')
  assert.equal(transport.requests[0]!.signal?.aborted, true)
  assert.equal(loadingVisible(tree), true)

  transport.requests[1]!.response.resolve(response([attachment('file-b', 'B.pdf')]))
  await settle()
  tree = renderPanel('record-b')
  assert.match(renderedText(tree), /B\.pdf/)
  assert.equal(loadingVisible(tree), false)

  transport.requests[0]!.response.reject(new Error('late A failure'))
  await settle()
  tree = renderPanel('record-b')
  assert.match(renderedText(tree), /B\.pdf/)
  assert.equal(loadingVisible(tree), false)
  assert.deepEqual(testState.errors, [], 'late A error cannot toast over the active record')

  // A real B failure owns the error side effect; a stale A failure must not
  // add to it or alter the settled loading state.
  testState.harness.reset()
  testState.errors.length = 0
  const secondTransport = installDeferredFetch()
  t.after(() => secondTransport.restore())
  renderPanel('record-a')
  tree = renderPanel('record-b')
  secondTransport.requests[1]!.response.reject(new Error('B failure'))
  await settle()
  tree = renderPanel('record-b')
  assert.equal(loadingVisible(tree), false)
  assert.deepEqual(testState.errors, ['loadFailed'])
  secondTransport.requests[0]!.response.reject(new Error('late A failure'))
  await settle()
  tree = renderPanel('record-b')
  assert.equal(loadingVisible(tree), false)
  assert.deepEqual(testState.errors, ['loadFailed'])
})
