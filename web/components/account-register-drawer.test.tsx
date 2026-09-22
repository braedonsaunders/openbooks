import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

// Regression test for the set-state-in-effect slice's lazy-initializer trap:
// AccountRegisterDrawer tracks the next-intl translator in a render-time
// reset latch. Passing the translator bare to its setter
// (`setPrevTc(tc)`) makes React invoke it as a state updater with the
// previous translator as the key, and next-intl throws
// `key.split is not a function`. The drawer mounts globally in the app
// shell, so the first RSC refresh that hands out a new translator identity
// dropped every page into the error boundary (email settings, extensions,
// insights e2e regressions). The setter must wrap the function:
// `setPrevTc(() => tc)`.

type DependencyList = readonly unknown[]

type HookSlot =
  | { kind: 'state'; value: unknown }
  | { kind: 'memo'; value: unknown; deps: DependencyList }
  | { kind: 'effect'; deps: DependencyList }

interface ReactHookHarness {
  beginRender(): void
  commitEffects(): void
  reset(): void
  readonly dirty: boolean
  useEffect(effect: () => void | (() => void), deps: DependencyList): void
  useMemo<T>(factory: () => T, deps: DependencyList): T
  useState<T>(initial: T | (() => T)): [T, (next: T | ((current: T) => T)) => void]
}

function sameDeps(left: DependencyList, right: DependencyList): boolean {
  return left.length === right.length && left.every((value, index) => Object.is(value, right[index]))
}

function createReactHookHarness(): ReactHookHarness {
  const slots: HookSlot[] = []
  let cursor = 0
  let isDirty = false

  return {
    beginRender() {
      cursor = 0
      isDirty = false
    },
    commitEffects() {},
    reset() {
      slots.length = 0
      cursor = 0
      isDirty = false
    },
    get dirty() {
      return isDirty
    },
    useEffect(effect, deps) {
      const index = cursor++
      const existing = slots[index]
      if (existing) {
        assert.equal(existing.kind, 'effect')
        if (!sameDeps(existing.deps, deps)) {
          existing.deps = deps
          isDirty = true
        }
        return
      }
      slots[index] = { kind: 'effect', deps }
    },
    useMemo<T>(factory: () => T, deps: DependencyList): T {
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
    useState<T>(initial: T | (() => T)): [T, (next: T | ((current: T) => T)) => void] {
      const index = cursor++
      let slot = slots[index]
      if (!slot) {
        slot = {
          kind: 'state',
          value: typeof initial === 'function' ? (initial as () => T)() : initial,
        }
        slots[index] = slot
      }
      assert.equal(slot.kind, 'state')
      const stateSlot = slot as Extract<HookSlot, { kind: 'state' }>
      return [
        stateSlot.value as T,
        (next: T | ((current: T) => T)) => {
          // Faithful to React: a function passed to the setter is an updater
          // and is invoked with the current state — never stored as-is.
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

interface DrawerTestState {
  harness: ReactHookHarness
  translate: (key: unknown) => string
}

function identityTranslator(key: unknown): string {
  if (typeof key !== 'string') throw new TypeError('key.split is not a function')
  return key
}

const testState: DrawerTestState = {
  harness: createReactHookHarness(),
  translate: identityTranslator,
}
;(globalThis as typeof globalThis & Record<symbol, unknown>)[
  Symbol.for('openbooks.account-register-drawer-test-state')
] = testState
// tsx compiles this legacy JSX module with the classic runtime in the test
// process; provide the tiny createElement surface its output calls.
const reactShim = {
  createElement(type: unknown, props: Record<string, unknown> | null | undefined, ...children: unknown[]) {
    return {
      type,
      props: {
        ...props,
        ...(children.length === 0 ? {} : { children: children.length === 1 ? children[0] : children }),
      },
    }
  },
}
Reflect.set(globalThis, 'React', reactShim)

const mockUrls = new Map<string, string>([
  ['react', 'mock:react'],
  ['react/jsx-runtime', 'mock:jsx-runtime'],
  ['next/navigation', 'mock:next-navigation'],
  ['next-intl', 'mock:next-intl'],
  ['sonner', 'mock:sonner'],
  ['@openbooks/ui', 'mock:ui'],
  ['@/components/money-provider', 'mock:money'],
  ['./doc-type-badge', 'mock:doc-type-badge'],
  ['./pagination', 'mock:pagination'],
  ['../app/(app)/reports/TxnLink', 'mock:txn-link'],
  ['../lib/account-register-navigation', 'mock:register-navigation'],
  ['./account-register-export-menu', 'mock:export-menu'],
  ['./search-input', 'mock:search-input'],
  ['./navigation-provider', 'mock:overlay'],
])

const mockSources = new Map<string, string>([
  [
    'mock:react',
    `
      const harness = globalThis[Symbol.for('openbooks.account-register-drawer-test-state')].harness
      export const useEffect = (effect, deps) => harness.useEffect(effect, deps)
      export const useMemo = (factory, deps) => harness.useMemo(factory, deps)
      export const useState = (initial) => harness.useState(initial)
    `,
  ],
  [
    'mock:jsx-runtime',
    `
      export function jsx(type, props, key) { return { type, props: props ?? {}, key: key ?? null } }
      export const jsxs = jsx
    `,
  ],
  [
    'mock:next-navigation',
    `
      const params = { get() { return null }, has() { return false }, entries() { return [][Symbol.iterator]() }, toString() { return '' } }
      const router = { replace() {} }
      export function usePathname() { return '/accounts' }
      export function useRouter() { return router }
      export function useSearchParams() { return params }
    `,
  ],
  [
    'mock:next-intl',
    `
      const state = globalThis[Symbol.for('openbooks.account-register-drawer-test-state')]
      export function useTranslations() { return state.translate }
    `,
  ],
  ['mock:sonner', `export const toast = { error() {} }`],
  [
    'mock:ui',
    `
      export function Skeleton() { return null }
      export function Table() { return null }
      export function TableBody() { return null }
      export function TableCell() { return null }
      export function TableHead() { return null }
      export function TableHeader() { return null }
      export function TableRow() { return null }
      export function UrlDrawer() { return null }
    `,
  ],
  ['mock:money', `export function useMoney() { return { money: (value) => value } }`],
  ['mock:doc-type-badge', `export function DocTypeBadge() { return null }`],
  ['mock:pagination', `export function Pagination() { return null }`],
  ['mock:txn-link', `export function TxnLink() { return null }`],
  ['mock:register-navigation', `export function accountRegisterCloseHref() { return '/accounts' }`],
  ['mock:export-menu', `export function AccountRegisterExportMenu() { return null }`],
  ['mock:search-input', `export function SearchInput() { return null }`],
  ['mock:overlay', `export function useReportOverlayOptional() { return null }`],
])

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.includes('/web/components/account-register-drawer.tsx')) {
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

const componentUrl = new URL('./account-register-drawer.tsx?account-register-drawer-test', import.meta.url).href
const { AccountRegisterDrawer } = await import(componentUrl)
hooks.deregister()

function renderDrawer(): unknown {
  testState.harness.beginRender()
  let tree = AccountRegisterDrawer() as unknown
  testState.harness.commitEffects()
  if (testState.harness.dirty) {
    testState.harness.beginRender()
    tree = AccountRegisterDrawer() as unknown
    testState.harness.commitEffects()
  }
  return tree
}

test('a translator identity change stores the translator without invoking it', (t) => {
  t.after(() => {
    testState.translate = identityTranslator
  })
  testState.harness.reset()
  testState.translate = identityTranslator

  renderDrawer()

  // A locale/messages refresh hands useTranslations a new identity for the
  // same locale. The reset latch must store it; passing it bare to the
  // setter invokes it as a state updater with the old translator as the
  // key and next-intl throws `key.split is not a function`, dropping the
  // whole shell into the error boundary.
  const refreshed = (key: unknown): string => {
    if (typeof key !== 'string') throw new TypeError('key.split is not a function')
    return `v2:${key}`
  }
  testState.translate = refreshed
  assert.doesNotThrow(() => renderDrawer(), 'the refreshed translator must render without throwing')
  assert.equal(testState.harness.dirty, false, 'the latch settles after one pass')
})
