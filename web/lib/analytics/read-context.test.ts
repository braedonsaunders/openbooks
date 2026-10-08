import assert from 'node:assert/strict'
import test from 'node:test'
import type { Authz } from '../authz'
import { analyticsSection, currentAnalyticsRead, observeAnalyticsSource, withAnalyticsRead } from './read-context'

const context = (slug: string, projection: 'tab' | 'summary', tab: string) => ({ authz: { user: { orgId: slug, id: 'reader' }, permissions: new Set(['reports.read']), allowedSubsidiaryIds: null } as Authz, slug, projection, tab, locale: 'en', revision: 'unit', observedAt: Date.now() })

test('direct domain reads retain their full contract while summaries skip all detail sections', async () => {
  assert.equal(analyticsSection('financial-health', ['budget']), true)
  await withAnalyticsRead(context('financial-health', 'summary', ''), async () => {
    assert.equal(analyticsSection('financial-health', ['overview', 'items', 'budget']), false)
    assert.equal(analyticsSection('financial-health', ['overview'], { summary: true }), true)
    assert.equal(analyticsSection('cashflow', ['category']), true)
  })
})

test('selected tabs load their own sections and concurrent organizations cannot exchange context', async () => {
  await Promise.all(['financial-health', 'cashflow'].map(slug => withAnalyticsRead(context(slug, 'tab', 'overview'), async () => {
    await new Promise(resolve => setTimeout(resolve, 1))
    assert.equal(currentAnalyticsRead()!.authz.user.orgId, slug)
    assert.equal(analyticsSection(slug, ['overview']), true)
    assert.equal(analyticsSection(slug, ['budget', 'category']), false)
    assert.equal(analyticsSection(slug, ['budget'], { summary: true }), false,
      'summary demand cannot admit an unselected tab')
  })))
  assert.equal(currentAnalyticsRead(), undefined)
})

test('a projection cannot renew the observation time of older source aggregates', async () => {
  const read = context('financial-health', 'tab', 'overview')
  const old = new Date(read.observedAt - 25_000).toISOString()
  await withAnalyticsRead(read, async () => {
    observeAnalyticsSource(old)
    observeAnalyticsSource(new Date().toISOString())
    assert.equal(currentAnalyticsRead()!.observedAt, Date.parse(old))
  })
})
