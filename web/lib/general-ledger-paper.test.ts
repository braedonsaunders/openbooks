import assert from 'node:assert/strict'
import test from 'node:test'
import { escapedPrintText, generalLedgerPaperHtml } from './general-ledger-paper.ts'

test('print text escapes tenant-authored footer content', () => {
  assert.equal(
    escapedPrintText('<R&D> {{page}} “North” → South'),
    '&lt;R&amp;D&gt; &#123;&#123;page&#125;&#125; “North”  -  South',
  )
})

test('general-ledger paper HTML mirrors ReportPaper typography and account hierarchy', () => {
  const html = generalLedgerPaperHtml({
    title: 'General Ledger',
    dateRangeLabel: '2026-01-01 → 2026-01-31',
    summary: [],
    groups: [{
      kind: 'section',
      title: '5210 Overhead Allowance',
      columns: ['Date', 'Entry', 'Party / memo', 'Debits', 'Credits', 'Balance'],
      rows: [
        ['', '', 'Opening balance', null, null, 0],
        ['2026-01-31', 'JE-100', 'Overhead applied', 125, null, 125],
        ['', '', 'Closing balance', null, null, 125],
      ],
      align: ['left', 'left', 'left', 'right', 'right', 'right'],
    }],
  }, {
    orgName: 'Example Manufacturing Inc',
    baseCurrency: 'CAD',
    primaryColor: '#0f766e',
  }, 'en')

  assert.match(html, /font-family:-apple-system,BlinkMacSystemFont,"Segoe UI"/)
  assert.match(html, /class="account-title"/)
  assert.match(html, /5210 Overhead Allowance/)
  assert.match(html, /CA\$125\.00/)
  assert.match(html, /border-bottom:3px double/)
  assert.doesNotMatch(html, /→|–|—/)
})
