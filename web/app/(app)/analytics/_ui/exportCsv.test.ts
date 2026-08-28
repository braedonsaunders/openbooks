import assert from 'node:assert/strict'
import test from 'node:test'
import { exportCsv } from './exportCsv.ts'

type Anchor = {
  href: string
  download: string
  click: () => void
  remove: () => void
}

const originalDocument = globalThis.document
const originalCreateObjectURL = URL.createObjectURL
const originalRevokeObjectURL = URL.revokeObjectURL

test.afterEach(() => {
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: originalDocument,
  })
  URL.createObjectURL = originalCreateObjectURL
  URL.revokeObjectURL = originalRevokeObjectURL
})

test('guards formula-like tenant strings while preserving CSV quoting and numbers', async () => {
  let blob: Blob | undefined
  let downloadedFile = ''
  let revokedUrl = ''
  let clicked = false
  let removed = false
  const anchor: Anchor = {
    href: '',
    download: '',
    click() {
      clicked = true
      downloadedFile = this.download
    },
    remove() {
      removed = true
    },
  }

  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      createElement(tag: string) {
        assert.equal(tag, 'a')
        return anchor
      },
      body: {
        appendChild(node: Anchor) {
          assert.equal(node, anchor)
        },
      },
    },
  })
  URL.createObjectURL = (value: Blob) => {
    blob = value
    return 'blob:analytics-export-test'
  }
  URL.revokeObjectURL = (value: string) => {
    revokedUrl = value
  }

  exportCsv(
    'budget-vs-actual.csv',
    ['Account', 'Amount'],
    [
      ['=HYPERLINK("https://attacker.invalid")', 12.5],
      ['+SUM(1,2)', '-12.5'],
      ['-2+3', '@SUM(A1:A2)'],
      ['Normal, account', null],
    ],
    '2026-08-28',
  )

  assert.ok(blob)
  assert.equal(
    await blob.text(),
    'Account,Amount\n"\'=HYPERLINK(""https://attacker.invalid"")",12.5\n"\'+SUM(1,2)",-12.5\n\'-2+3,\'@SUM(A1:A2)\n"Normal, account",',
  )
  assert.equal(downloadedFile, 'budget-vs-actual-2026-08-28.csv')
  assert.equal(anchor.href, 'blob:analytics-export-test')
  assert.equal(clicked, true)
  assert.equal(removed, true)
  assert.equal(revokedUrl, 'blob:analytics-export-test')
})
