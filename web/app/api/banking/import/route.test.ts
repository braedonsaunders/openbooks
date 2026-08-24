import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { decodeStatementSourceText as engineDecodeStatementSourceText } from '../../../../../engine/src/banking.ts'

interface ImportCall {
  options: {
    dryRun?: boolean
    lines: unknown[]
    sourceEvidence?: {
      content: string | Uint8Array
      filename?: string | null
      contentType?: string | null
      parserVersion?: string | null
      csvMapping?: Record<string, number> | null
    }
  }
  context: {
    orgId: string
    userId: string
  }
}

const stateKey = Symbol.for('openbooks.bank-import-route-test')
const importState = {
  calls: [] as ImportCall[],
  decoderInputs: [] as { content: unknown; source: string }[],
  parsedSources: [] as unknown[],
  decodeStatementSourceText: engineDecodeStatementSourceText,
}
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = importState

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
      const state = globalThis[Symbol.for('openbooks.bank-import-route-test')]
      const line = {
        postedOn: '2026-08-23',
        amount: '10.0000',
        description: 'Deposit',
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

      export function parseCsvRows(source) {
        state.parsedSources.push(source)
        return [
          ['date', 'amount', 'description'],
          ['2026-08-23', '10.00', 'Deposit'],
        ]
      }

      export function parseCsv(source) {
        state.parsedSources.push(source)
        return [line]
      }

      export function parseOfx(source) {
        state.parsedSources.push(source)
        return { lines: [line] }
      }

      export function parseCamt053(source) {
        state.parsedSources.push(source)
        return { lines: [line] }
      }

      export function parseBai2(source) {
        state.parsedSources.push(source)
        return { lines: [line] }
      }

      export function parseMt940(source) {
        state.parsedSources.push(source)
        return { lines: [line] }
      }

      export async function importStatement(options, context) {
        state.calls.push({ options, context })
        return {
          statementId: options.dryRun ? null : 'statement-1',
          imported: options.lines.length,
          duplicates: 0,
          lines: options.lines,
        }
      }
    `,
  ],
])

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@/lib/api/json') {
      return { url: 'mock:json', shortCircuit: true }
    }
    if (specifier === '@openbooks/engine/src/banking.ts') {
      return { url: 'mock:banking', shortCircuit: true }
    }
    if (specifier === '../../../../lib/feature-gates') {
      return { url: 'mock:feature-gates', shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    const source = mockSources.get(url)
    if (source !== undefined) {
      return { format: 'module', source, shortCircuit: true }
    }
    return nextLoad(url, context)
  },
})

const routeUrl = './route.ts?mode-validation-test'
const { POST } = await import(routeUrl) as typeof import('./route.ts')
hooks.deregister()

const validBody = {
  accountId: 'account-1',
  source: 'csv',
  text: 'date,amount,description\n2026-08-23,10.00,Deposit',
  mapping: { date: 0, amount: 1, description: 2 },
}

async function postMode(mode: string): Promise<Response> {
  return POST(new Request('http://openbooks.test/api/banking/import', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...validBody, mode }),
  }))
}

function utf16Bytes(text: string, byteOrder: 'le' | 'be'): Buffer {
  const body = Buffer.from(text, 'utf16le')
  if (byteOrder === 'be') body.swap16()
  return Buffer.concat([
    Buffer.from(byteOrder === 'le' ? [0xff, 0xfe] : [0xfe, 0xff]),
    body,
  ])
}

function postDecode(source: string, bytes: Uint8Array): Promise<Response> {
  return POST(new Request('http://openbooks.test/api/banking/import', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      source,
      sourceBytesBase64: Buffer.from(bytes).toString('base64'),
      mode: 'decode',
    }),
  }))
}

test('columns mode returns CSV metadata without persisting', async () => {
  importState.calls.length = 0

  const response = await postMode('columns')

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    header: ['date', 'amount', 'description'],
    sample: [['2026-08-23', '10.00', 'Deposit']],
    rowCount: 2,
  })
  assert.equal(importState.calls.length, 0)
})

test('preview mode invokes the importer in dry-run mode', async () => {
  importState.calls.length = 0

  const response = await postMode('preview')

  assert.equal(response.status, 200)
  assert.equal(importState.calls.length, 1)
  assert.equal(importState.calls[0]?.options.dryRun, true)
  assert.deepEqual(importState.calls[0]?.context, { orgId: 'org-1', userId: 'user-1' })
  assert.equal((await response.json()).statementId, null)
})

test('import mode invokes the importer with persistence enabled', async () => {
  importState.calls.length = 0

  const response = await postMode('import')
  const body = await response.json()

  assert.equal(response.status, 200)
  assert.equal(importState.calls.length, 1)
  assert.equal(importState.calls[0]?.options.dryRun, false)
  assert.deepEqual(importState.calls[0]?.options.sourceEvidence, {
    content: validBody.text,
    filename: null,
    parserVersion: 'test-parser-v1',
    csvMapping: validBody.mapping,
  })
  assert.equal(body.statementId, 'statement-1')
  assert.equal('lines' in body, false)
})

test('decode mode applies the engine BOM and declared legacy-encoding policy', async (t) => {
  const csv = 'date,amount,description\r\n2026-08-24,10.00,Café\r\n'
  const legacyOfx = Buffer.concat([
    Buffer.from('OFXHEADER:100\nENCODING:USASCII\nCHARSET:1252\n\n<OFX>Caf', 'ascii'),
    Buffer.from([0xe9, 0x20, 0x96, 0x20, 0x64, 0xe9, 0x70, 0xf4, 0x74]),
  ])
  const cases = [
    {
      name: 'Windows-1252 OFX declaration',
      source: 'ofx',
      bytes: legacyOfx,
      expected: 'OFXHEADER:100\nENCODING:USASCII\nCHARSET:1252\n\n<OFX>Café – dépôt',
    },
    {
      name: 'UTF-8 BOM',
      source: 'csv',
      bytes: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(csv, 'utf8')]),
      expected: csv,
    },
    { name: 'UTF-16LE BOM', source: 'csv', bytes: utf16Bytes(csv, 'le'), expected: csv },
    { name: 'UTF-16BE BOM', source: 'csv', bytes: utf16Bytes(csv, 'be'), expected: csv },
  ]

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      importState.calls.length = 0
      importState.decoderInputs.length = 0
      importState.parsedSources.length = 0

      const response = await postDecode(entry.source, entry.bytes)

      assert.equal(response.status, 200)
      assert.deepEqual(await response.json(), { text: entry.expected })
      assert.equal(importState.decoderInputs.length, 1)
      assert.equal(importState.decoderInputs[0]?.source, entry.source)
      assert.ok(importState.decoderInputs[0]?.content instanceof Uint8Array)
      assert.deepEqual(Buffer.from(importState.decoderInputs[0]!.content as Uint8Array), entry.bytes)
      assert.equal(importState.parsedSources.length, 0)
      assert.equal(importState.calls.length, 0)
    })
  }
})

test('decode mode fails closed when a declaration conflicts with BOM-selected bytes', async () => {
  importState.calls.length = 0
  importState.decoderInputs.length = 0
  importState.parsedSources.length = 0
  const conflictingXml = Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from('<?xml version="1.0" encoding="windows-1252"?><Stmt/>'),
  ])

  const response = await postDecode('camt053', conflictingXml)

  assert.equal(response.status, 422)
  assert.deepEqual(await response.json(), {
    error: 'Statement source encoding declaration "windows-1252" conflicts with UTF-8 source bytes',
  })
  assert.equal(importState.decoderInputs.length, 1)
  assert.equal(importState.parsedSources.length, 0)
  assert.equal(importState.calls.length, 0)
})

test('browser upload bytes drive parsing and remain byte-exact source evidence', async () => {
  importState.calls.length = 0
  importState.parsedSources.length = 0
  const uploadedBytes = Buffer.from([
    0xef, 0xbb, 0xbf, 0x64, 0x61, 0x74, 0x65, 0x2c, 0xe9, 0x0d, 0x0a,
  ])

  const response = await POST(new Request('http://openbooks.test/api/banking/import', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ...validBody,
      text: 'this fallback must not be parsed or retained',
      sourceBytesBase64: uploadedBytes.toString('base64'),
      filename: 'statement.csv',
      contentType: 'text/csv',
      mode: 'import',
    }),
  }))

  assert.equal(response.status, 200)
  assert.equal(importState.parsedSources.length, 1)
  const parsedSource = importState.parsedSources[0]
  assert.ok(parsedSource instanceof Uint8Array)
  assert.deepEqual(Buffer.from(parsedSource), uploadedBytes)

  const evidence = importState.calls[0]?.options.sourceEvidence
  assert.ok(evidence)
  assert.ok(evidence.content instanceof Uint8Array)
  assert.deepEqual(Buffer.from(evidence.content), uploadedBytes)
  assert.equal(evidence.filename, 'statement.csv')
  assert.equal(evidence.contentType, 'text/csv')
  assert.equal(evidence.parserVersion, 'test-parser-v1')
  assert.deepEqual(evidence.csvMapping, validBody.mapping)
})

test('non-canonical browser upload base64 is rejected without parsing or persistence', async () => {
  importState.calls.length = 0
  importState.parsedSources.length = 0

  const response = await POST(new Request('http://openbooks.test/api/banking/import', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ...validBody,
      sourceBytesBase64: 'ZGF0ZQ',
      mode: 'import',
    }),
  }))

  assert.equal(response.status, 400)
  assert.deepEqual(await response.json(), {
    error: 'Uploaded statement bytes must be canonical base64',
  })
  assert.equal(importState.parsedSources.length, 0)
  assert.equal(importState.calls.length, 0)
})

test('an invalid mode is rejected before persistence', async () => {
  importState.calls.length = 0

  const response = await postMode('unexpected')

  assert.equal(response.status, 400)
  assert.deepEqual(await response.json(), { error: 'mode must be decode, columns, preview or import' })
  assert.equal(importState.calls.length, 0)
})
