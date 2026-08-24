import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { decodeStatementSourceText as engineDecodeStatementSourceText } from '../../engine/src/banking.ts'

interface CapturedImport {
  dryRun?: boolean
  sourceEvidence?: {
    content?: unknown
    filename?: string | null
    contentType?: string | null
  }
}

interface UploadBoundaryState {
  decoderInputs: { content: unknown; source: string }[]
  parserInputs: unknown[]
  imports: CapturedImport[]
  decodeStatementSourceText: typeof engineDecodeStatementSourceText
}

type HookSlot =
  | { kind: 'state'; value: unknown }
  | { kind: 'ref'; value: { current: unknown } }

interface ReactHookHarness {
  beginRender(): void
  reset(): void
  readonly updates: number
  useRef(initial: unknown): { current: unknown }
  useState(initial: unknown): [unknown, (next: unknown) => void]
}

function createReactHookHarness(): ReactHookHarness {
  const slots: HookSlot[] = []
  let cursor = 0
  let updates = 0

  return {
    beginRender() {
      cursor = 0
    },
    reset() {
      slots.length = 0
      cursor = 0
      updates = 0
    },
    get updates() {
      return updates
    },
    useRef(initial) {
      const index = cursor++
      const existing = slots[index]
      if (existing) {
        assert.equal(existing.kind, 'ref')
        return existing.value
      }
      const value = { current: initial }
      slots[index] = { kind: 'ref', value }
      return value
    },
    useState(initial) {
      const index = cursor++
      let slot = slots[index]
      if (slot) {
        assert.equal(slot.kind, 'state')
      } else {
        slot = {
          kind: 'state',
          value: typeof initial === 'function' ? (initial as () => unknown)() : initial,
        }
        slots[index] = slot
      }
      const stateSlot = slot as Extract<HookSlot, { kind: 'state' }>
      return [
        stateSlot.value,
        (next: unknown) => {
          stateSlot.value = typeof next === 'function' ? (next as (current: unknown) => unknown)(stateSlot.value) : next
          updates += 1
        },
      ]
    },
  }
}

const stateKey = Symbol.for('openbooks.bank-statement-upload-test')
const uploadState: UploadBoundaryState = {
  decoderInputs: [],
  parserInputs: [],
  imports: [],
  decodeStatementSourceText: engineDecodeStatementSourceText,
}
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = uploadState

const reactHarnessKey = Symbol.for('openbooks.bank-statement-upload-react-harness')
const reactHarness = createReactHookHarness()
;(globalThis as typeof globalThis & Record<symbol, unknown>)[reactHarnessKey] = reactHarness
;(globalThis as typeof globalThis & Record<string, unknown>).React = {
  Fragment: Symbol.for('openbooks.test.fragment'),
  createElement(type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) {
    return {
      type,
      props: {
        ...props,
        ...(children.length === 0 ? {} : { children: children.length === 1 ? children[0] : children }),
      },
    }
  },
} as unknown as typeof import('react')

const mockUrls = new Map<string, string>([
  ['@/lib/api/json', 'mock:json'],
  ['@openbooks/engine/src/banking.ts', 'mock:banking'],
  ['../../../../lib/feature-gates', 'mock:feature-gates'],
  ['@/components/money-provider', 'mock:money-provider'],
  ['next/navigation', 'mock:next-navigation'],
  ['next-intl', 'mock:next-intl'],
  ['lucide-react', 'mock:icons'],
  ['sonner', 'mock:sonner'],
  ['@openbooks/ui', 'mock:ui'],
])

const mockSources = new Map<string, string>([
  [
    'mock:json',
    `
      export const jsonObject = {}
      export async function parseJsonBody(request) {
        return { ok: true, data: await request.json() }
      }
    `,
  ],
  [
    'mock:feature-gates',
    `
      export async function guardFeaturePermission() {
        return { user: { orgId: 'org-1', id: 'user-1' } }
      }
    `,
  ],
  [
    'mock:banking',
    `
      const state = globalThis[Symbol.for('openbooks.bank-statement-upload-test')]
      const line = {
        postedOn: '2026-08-24',
        amount: '10.0000',
        description: 'Café – dépôt',
        bankTransactionId: 'bank-line-1',
      }

      export const BANK_STATEMENT_PARSER_VERSION = 'test-parser-v1'

      export class BankingError extends Error {
        constructor(message, status = 422) {
          super(message)
          this.status = status
        }
      }

      export function decodeStatementSourceText(content, source) {
        state.decoderInputs.push({ content, source })
        try {
          return state.decodeStatementSourceText(content, source)
        } catch (error) {
          throw new BankingError(error instanceof Error ? error.message : 'Statement decoding failed')
        }
      }

      function parsed(content) {
        state.parserInputs.push(content)
        return { lines: [line] }
      }

      export function parseCsvRows(content) {
        state.parserInputs.push(content)
        return [['date', 'amount', 'description']]
      }
      export function parseCsv(content) { return parsed(content).lines }
      export function parseOfx(content) { return parsed(content) }
      export function parseCamt053(content) { return parsed(content) }
      export function parseBai2(content) { return parsed(content) }
      export function parseMt940(content) { return parsed(content) }

      export async function importStatement(options) {
        state.imports.push(options)
        return {
          statementId: 'statement-1',
          sourceEvidenceRef: 'statement-evidence-1',
          imported: options.lines.length,
          duplicates: 0,
          lines: options.lines,
        }
      }
    `,
  ],
  [
    'mock:react',
    `
      const harness = globalThis[Symbol.for('openbooks.bank-statement-upload-react-harness')]
      export function useRef(initial) { return harness.useRef(initial) }
      export function useState(initial) { return harness.useState(initial) }
    `,
  ],
  [
    'mock:jsx-runtime',
    `
      export const Fragment = Symbol.for('openbooks.test.fragment')
      export function jsx(type, props, key) { return { type, props: props ?? {}, key: key ?? null } }
      export const jsxs = jsx
    `,
  ],
  ['mock:money-provider', `export function useMoney() { return { money: String } }`],
  ['mock:next-navigation', `export function useRouter() { return { refresh() {} } }`],
  ['mock:next-intl', `export function useTranslations() { return (key) => key }`],
  ['mock:icons', `export function FileUp() { return null }; export function Upload() { return null }`],
  ['mock:sonner', `export const toast = { error() {}, success() {} }`],
  [
    'mock:ui',
    `
      export function Badge() { return null }
      export function Button() { return null }
      export function Drawer() { return null }
      export function Input() { return null }
      export function Label() { return null }
      export function Select() { return null }
      export function Textarea() { return null }
    `,
  ],
])

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.includes('ImportStatementButton.tsx')) {
      if (specifier === 'react') return { url: 'mock:react', shortCircuit: true }
      if (specifier === 'react/jsx-runtime' || specifier === 'react/jsx-dev-runtime') {
        return { url: 'mock:jsx-runtime', shortCircuit: true }
      }
    }
    const mocked = mockUrls.get(specifier)
    if (mocked) return { url: mocked, shortCircuit: true }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    const source = mockSources.get(url)
    if (source !== undefined) return { format: 'module', source, shortCircuit: true }
    return nextLoad(url, context)
  },
})

const componentUrl = '../app/(app)/banking/[accountId]/ImportStatementButton.tsx?upload-boundary-test'
const { ImportStatementButton } = (await import(
  componentUrl
)) as typeof import('../app/(app)/banking/[accountId]/ImportStatementButton.tsx')
const routeUrl = '../app/api/banking/import/route.ts?upload-boundary-test'
const { POST } = (await import(routeUrl)) as typeof import('../app/api/banking/import/route.ts')
hooks.deregister()

function request(body: Record<string, unknown>): Request {
  return new Request('http://openbooks.test/api/banking/import', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
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

function renderImportButton(): RenderedElement {
  reactHarness.beginRender()
  return ImportStatementButton({ accountId: 'account-1' }) as unknown as RenderedElement
}

function requiredElement(
  tree: RenderedElement,
  predicate: (element: RenderedElement) => boolean,
  description: string,
): RenderedElement {
  const element = findRenderedElement(tree, predicate)
  assert.ok(element, `Expected rendered ${description}`)
  return element
}

function requiredHandler(element: RenderedElement, name: string): (...args: unknown[]) => unknown {
  const handler = element.props[name]
  assert.equal(typeof handler, 'function', `Expected ${name} handler`)
  return handler as (...args: unknown[]) => unknown
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  assert.ok(predicate(), 'Timed out waiting for component state update')
}

class CountingFile extends File {
  reads = 0

  override async arrayBuffer(): Promise<ArrayBuffer> {
    this.reads += 1
    return super.arrayBuffer()
  }
}

test('component file input sends exact bytes through preview, import, parser and evidence boundaries', async (t) => {
  reactHarness.reset()
  uploadState.decoderInputs.length = 0
  uploadState.parserInputs.length = 0
  uploadState.imports.length = 0

  const requestBodies: Record<string, unknown>[] = []
  const originalFetch = globalThis.fetch
  t.after(() => {
    globalThis.fetch = originalFetch
  })
  globalThis.fetch = (async (input, init) => {
    const componentRequest = new Request(new URL(String(input), 'http://openbooks.test'), init)
    assert.equal(componentRequest.url, 'http://openbooks.test/api/banking/import')
    assert.equal(componentRequest.method, 'POST')
    assert.equal(componentRequest.headers.get('content-type'), 'application/json')
    const body = await componentRequest.clone().json()
    assert.ok(typeof body === 'object' && body !== null && !Array.isArray(body))
    requestBodies.push(body as Record<string, unknown>)
    return POST(componentRequest)
  }) as typeof fetch

  const header = Buffer.from(
    'OFXHEADER:100\r\nDATA:OFXSGML\r\nVERSION:102\r\nSECURITY:NONE\r\nENCODING:USASCII\r\nCHARSET:1252\r\nCOMPRESSION:NONE\r\nOLDFILEUID:NONE\r\nNEWFILEUID:NONE\r\n\r\n<OFX><STMTTRN><MEMO>Caf',
    'ascii',
  )
  const trailer = Buffer.from('</MEMO></STMTTRN></OFX>', 'ascii')
  const chunkCrossingPadding = Buffer.alloc(0x8000 + 17, 0x41)
  const sourceBytes = Uint8Array.from([
    ...header,
    0xe9,
    0x20,
    0x96,
    0x20,
    0x64,
    0xe9,
    0x70,
    0xf4,
    0x74,
    ...chunkCrossingPadding,
    ...trailer,
  ])
  const file = new CountingFile([sourceBytes], 'legacy.ofx', {
    type: 'application/x-ofx; charset=windows-1252',
  })
  const initialTree = renderImportButton()
  const fileInput = requiredElement(
    initialTree,
    (element) => element.type === 'input' && element.props.type === 'file',
    'statement file input',
  )
  const fileInputTarget = { files: [file], value: 'selected' }
  const updatesBeforeRead = reactHarness.updates

  requiredHandler(fileInput, 'onChange')({ target: fileInputTarget })
  await waitFor(() => reactHarness.updates >= updatesBeforeRead + 7)

  assert.equal(fileInputTarget.value, '')
  assert.equal(file.reads, 1)
  let tree = renderImportButton()
  const statementTextarea = requiredElement(
    tree,
    (element) => typeof element.type === 'function' && element.type.name === 'Textarea',
    'statement text area',
  )
  assert.match(String(statementTextarea.props.value), /Café – dépôt/)
  assert.match(renderedText(tree), /legacy\.ofx/)

  const previewButton = requiredElement(
    tree,
    (element) =>
      typeof element.type === 'function' &&
      element.type.name === 'Button' &&
      renderedText(element).includes('preview'),
    'preview button',
  )
  await requiredHandler(previewButton, 'onClick')()

  tree = renderImportButton()
  const importButton = requiredElement(
    tree,
    (element) =>
      typeof element.type === 'function' &&
      element.type.name === 'Button' &&
      renderedText(element).includes('importCount'),
    'import button with preview count',
  )
  assert.equal(importButton.props.disabled, false)
  await requiredHandler(importButton, 'onClick')()

  assert.equal(requestBodies.length, 3)
  assert.deepEqual(
    requestBodies.map((body) => body.mode),
    ['decode', 'preview', 'import'],
  )
  const expectedBase64 = Buffer.from(sourceBytes).toString('base64')
  for (const body of requestBodies) {
    assert.equal(body.source, 'ofx')
    assert.equal('text' in body, false)
    assert.equal(body.sourceBytesBase64, expectedBase64)
  }
  assert.equal('accountId' in requestBodies[0]!, false)
  for (const body of requestBodies.slice(1)) {
    assert.equal(body.accountId, 'account-1')
    assert.equal(body.filename, 'legacy.ofx')
    assert.equal(body.contentType, 'application/x-ofx')
  }

  assert.equal(uploadState.decoderInputs.length, 1)
  assert.equal(uploadState.decoderInputs[0]?.source, 'ofx')
  assert.ok(uploadState.decoderInputs[0]?.content instanceof Uint8Array)
  assert.deepEqual(Uint8Array.from(uploadState.decoderInputs[0]!.content as Uint8Array), sourceBytes)

  assert.equal(uploadState.parserInputs.length, 2)
  for (const parserInput of uploadState.parserInputs) {
    assert.ok(parserInput instanceof Uint8Array)
    assert.deepEqual(Uint8Array.from(parserInput), sourceBytes)
  }
  assert.equal(uploadState.imports.length, 2)
  assert.deepEqual(
    uploadState.imports.map((imported) => imported.dryRun),
    [true, false],
  )
  for (const imported of uploadState.imports) {
    assert.ok(imported.sourceEvidence?.content instanceof Uint8Array)
    assert.deepEqual(Uint8Array.from(imported.sourceEvidence.content), sourceBytes)
    assert.equal(imported.sourceEvidence.filename, 'legacy.ofx')
    assert.equal(imported.sourceEvidence.contentType, 'application/x-ofx')
  }
})

test('editing source while preview is in flight fences the stale preview response', async (t) => {
  reactHarness.reset()

  const requestBodies: Record<string, unknown>[] = []
  let resolvePreview: ((response: Response) => void) | undefined
  const originalFetch = globalThis.fetch
  t.after(() => {
    globalThis.fetch = originalFetch
  })
  globalThis.fetch = (async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    requestBodies.push(body)
    return new Promise<Response>((resolve) => {
      resolvePreview = resolve
    })
  }) as typeof fetch

  let tree = renderImportButton()
  let statementTextarea = requiredElement(
    tree,
    (element) => typeof element.type === 'function' && element.type.name === 'Textarea',
    'statement text area',
  )
  requiredHandler(statementTextarea, 'onChange')({ target: { value: '<OFX>first source</OFX>' } })

  tree = renderImportButton()
  const previewButton = requiredElement(
    tree,
    (element) =>
      typeof element.type === 'function'
      && element.type.name === 'Button'
      && renderedText(element).includes('preview'),
    'preview button',
  )
  const previewPromise = requiredHandler(previewButton, 'onClick')()
  await waitFor(() => requestBodies.length === 1 && resolvePreview !== undefined)

  statementTextarea = requiredElement(
    tree,
    (element) => typeof element.type === 'function' && element.type.name === 'Textarea',
    'statement text area',
  )
  requiredHandler(statementTextarea, 'onChange')({ target: { value: '<OFX>replacement source</OFX>' } })

  resolvePreview!(new Response(JSON.stringify({
    imported: 1,
    duplicates: 0,
    lines: [{ postedOn: '2026-08-24', amount: '10.0000', description: 'stale result' }],
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }))
  await previewPromise

  tree = renderImportButton()
  const importButton = requiredElement(
    tree,
    (element) =>
      typeof element.type === 'function'
      && element.type.name === 'Button'
      && renderedText(element).includes('importAction'),
    'disabled import button',
  )
  assert.equal(importButton.props.disabled, true)
  assert.deepEqual(requestBodies.map((body) => body.mode), ['preview'])
  assert.doesNotMatch(renderedText(tree), /stale result/)
})

test('server rejects non-canonical browser base64 before parsing or persistence', async (t) => {
  for (const sourceBytesBase64 of ['AA', 'Zm9v-', 'Zh==']) {
    await t.test(sourceBytesBase64, async () => {
      uploadState.parserInputs.length = 0
      uploadState.imports.length = 0

      const response = await POST(
        request({
          accountId: 'account-1',
          source: 'ofx',
          text: 'fallback text must not make an invalid upload acceptable',
          sourceBytesBase64,
          mode: 'import',
        }),
      )

      assert.equal(response.status, 400)
      assert.deepEqual(await response.json(), {
        error: 'Uploaded statement bytes must be canonical base64',
      })
      assert.equal(uploadState.parserInputs.length, 0)
      assert.equal(uploadState.imports.length, 0)
    })
  }
})
