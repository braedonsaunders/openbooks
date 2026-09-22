import assert from 'node:assert/strict'
import test from 'node:test'
import {
  hrefWithoutKeys,
  hrefWithoutOverlay,
  hrefWithOverlay,
  isOverlayOnlyHrefChange,
  isReportOverlayParam,
  reportFilterQuery,
  stripReportOverlay,
} from './report-overlay'

test('overlay keys are chrome, not report inputs', () => {
  assert.equal(isReportOverlayParam('reportDrill'), true)
  assert.equal(isReportOverlayParam('reportRecord'), true)
  assert.equal(isReportOverlayParam('txn'), true)
  assert.equal(isReportOverlayParam('accountRegister'), true)
  assert.equal(isReportOverlayParam('period'), false)
  assert.equal(isReportOverlayParam('currency'), false)
  assert.equal(isReportOverlayParam('side'), false)
})

test('stripReportOverlay leaves the paper filters intact', () => {
  const params = new URLSearchParams(
    'period=today&side=ar&reportDrill=%7B%7D&reportDrillPage=2&txn=abc',
  )
  const stripped = stripReportOverlay(params)
  assert.equal(stripped.get('period'), 'today')
  assert.equal(stripped.get('side'), 'ar')
  assert.equal(stripped.has('reportDrill'), false)
  assert.equal(stripped.has('txn'), false)
  assert.equal(reportFilterQuery(params), 'period=today&side=ar')
})

test('opening or closing a drill is an overlay-only URL change', () => {
  const paper = '/reports/aging?period=today&side=ar'
  const drilled = hrefWithOverlay('/reports/aging', 'period=today&side=ar', {
    reportDrill: '{"kind":"aging"}',
  })
  assert.equal(isOverlayOnlyHrefChange(paper, drilled), true)
  assert.equal(isOverlayOnlyHrefChange(drilled, paper), true)
  assert.equal(
    isOverlayOnlyHrefChange(drilled, hrefWithOverlay('/reports/aging', 'period=today&side=ar', {
      reportDrill: '{"kind":"aging","partyId":"x"}',
    })),
    true,
  )
})

test('a period or currency change is a real report navigation', () => {
  const current = '/reports/aging?period=today&side=ar&reportDrill=%7B%7D'
  assert.equal(isOverlayOnlyHrefChange(current, '/reports/aging?period=yesterday&side=ar'), false)
  assert.equal(isOverlayOnlyHrefChange(current, '/reports/aging?period=today&side=ap'), false)
  assert.equal(isOverlayOnlyHrefChange(current, '/reports/pnl?period=today'), false)
})

test('hrefWithoutOverlay drops the whole drawer stack and keeps the paper', () => {
  assert.equal(
    hrefWithoutOverlay(
      '/reports/aging',
      'period=today&reportDrill=x&reportRecord=y&txn=z&accountRegister=a',
    ),
    '/reports/aging?period=today',
  )
})

test('closing a nested record keeps the drill overlay', () => {
  assert.equal(
    hrefWithoutKeys(
      '/reports/aging',
      'period=today&reportDrill=x&reportRecord=y&reportRecordKind=invoice',
      ['reportRecord', 'reportRecordKind', 'drawerReturn', 'form', 'transactionTab'],
    ),
    '/reports/aging?period=today&reportDrill=x',
  )
})
