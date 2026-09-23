import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

// DS1: staged attachments are orphaned when the close-delivery handoff fails.
// processCloseDeliveryJobData stages the rendered bundle under a fresh random
// id BEFORE the Redis enqueue; the stubs below stand in for staging (no S3 in
// unit) while recording exactly which keys stay live, for the database (a
// canned answer queue consumed in call order), and for rendering.
globalThis.__closeEmailStageTest = {
  queue: [],
  stagedCount: 0,
  live: new Set(),
  deleted: [],
  sent: [],
  enqueueError: null,
}
const state = globalThis.__closeEmailStageTest

const sources = {
  bullmq: 'export class Worker { constructor() {} }',
  'drizzle-orm': `
    export const sql = Object.assign((...args) => ({}), { join: (...args) => ({}) });
  `,
  '@openbooks/jobs': `
    export const CLOSE_DELIVERY_QUEUE = 'test';
    export const getBlockingConnection = () => ({});
    export const newEmailIntentKey = (s) => s + '|intent';
    export const enqueueEmail = async (data) => {
      const s = globalThis.__closeEmailStageTest;
      if (s.enqueueError) throw s.enqueueError;
      s.sent.push(data);
    };
  `,
  '@openbooks/emails': 'export const isValidEmailAddress = () => true;',
  '../delivery/email-attachments.ts': `
    export async function storeEmailAttachments(attachments) {
      const s = globalThis.__closeEmailStageTest;
      return (attachments ?? []).map((a) => {
        const key = 'staged-key-' + (s.stagedCount++);
        s.live.add(key);
        return { filename: a.filename, contentType: a.contentType, storageKey: key };
      });
    }
    export async function deleteStoredEmailAttachments(attachments) {
      const s = globalThis.__closeEmailStageTest;
      for (const a of attachments ?? []) {
        if (a.storageKey) { s.live.delete(a.storageKey); s.deleted.push(a.storageKey); }
      }
    }
  `,
  '../platform/db.ts': `
    export const db = { execute: async () => globalThis.__closeEmailStageTest.queue.shift() ?? { rows: [] } };
    export const withOrgContext = (_org, fn) => fn();
  `,
  '../reports/ensure-report-definitions.ts': 'export const ensureReportDefinitions = async () => {};',
  './render-client.ts': `export const renderReportPdf = async () => Buffer.from('pdf-bytes');`,
}

const hooks = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.endsWith('/close-delivery-worker.ts') && sources[specifier]) {
    return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(sources[specifier])}` }
  }
  return next(specifier, context)
} })
const { processCloseDeliveryJobData } = await import('./close-delivery-worker.ts')
hooks.deregister()

function packageContext() {
  return {
    period_name: 'Jan 2026',
    starts_on: '2026-01-01',
    ends_on: '2026-01-31',
    book_name: 'Primary',
    package_name: 'Board pack',
    reports: [{ slug: 'pnl' }],
    recipients: ['a@example.com'],
    delivery: {},
    org_name: 'Acme',
  }
}

// Consumed in call order: package context load, report-definition lookup,
// post-send close event insert.
function primeDb() {
  state.queue.push(
    { rows: [packageContext()] },
    { rows: [{ slug: 'pnl', id: 'def-1', name: 'P&L' }] },
    { rows: [] },
  )
}

function reset() {
  state.queue.length = 0
  state.stagedCount = 0
  state.live.clear()
  state.deleted.length = 0
  state.sent.length = 0
  state.enqueueError = null
}

function jobData() {
  return { orgId: 'org-1', packageId: 'pkg-1', periodId: 'p-1', bookId: 'b-1' }
}

test('a failing queue handoff deletes every ref staged in that attempt', async () => {
  reset()
  primeDb()
  state.enqueueError = new Error('Redis unavailable')
  await assert.rejects(processCloseDeliveryJobData(jobData()), /Redis unavailable/)
  assert.equal(state.live.size, 0)
  assert.equal(state.deleted.length, 1)
})

test('a successful handoff keeps the staged refs for the worker to fetch', async () => {
  reset()
  primeDb()
  const result = await processCloseDeliveryJobData(jobData())
  assert.equal(result.files, 1)
  assert.equal(state.sent.length, 1)
  assert.equal(state.sent[0].attachments.length, 1)
  assert.ok(state.sent[0].attachments[0].storageKey.startsWith('staged-key-'))
  assert.deepEqual(state.deleted, [])
  assert.equal(state.live.size, 1)
})
