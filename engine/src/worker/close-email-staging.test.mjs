import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

// DS1: staged attachments are orphaned when the close-delivery handoff fails.
// DS2: the DS1 catch deleted staged refs on ANY enqueue exception — but a
// Redis/BullMQ add can accept the job and then lose its reply, so the job
// exists while the enqueue throws, and the queued worker later refuses the
// missing blob. processCloseDeliveryJobData stages the rendered bundle under
// a fresh random id BEFORE the Redis enqueue; the stubs below stand in for
// staging (no S3 in unit) while recording exactly which keys stay live, for
// the database (a canned answer queue consumed in call order), and for
// rendering. The settlement helper itself is REAL (not stubbed): its static
// '../delivery/email-attachments.ts' import is served the same tracking stub
// whenever the importing parent is the settlement module, and its dynamic
// '@openbooks/jobs' import reaches the real package, so the expected job
// identities under test are the production plan, not a copy.
globalThis.__closeEmailStageTest = {
  queue: [],
  stagedCount: 0,
  live: new Set(),
  deleted: [],
  sent: [],
  recorded: new Map(),
  enqueueError: null,
  recordThenThrow: false,
}
const state = globalThis.__closeEmailStageTest

const emailAttachmentsStub = `
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
  `

const sources = {
  bullmq: 'export class Worker { constructor() {} }',
  'drizzle-orm': `
    export const sql = Object.assign((...args) => ({}), { join: (...args) => ({}) });
  `,
  '@openbooks/jobs': `
    export const CLOSE_DELIVERY_QUEUE = 'test';
    export const closeDeliveryManualEmailIntentKey = () => { throw new Error('unexpected manual delivery in attachment-staging test'); };
    export const getBlockingConnection = () => ({});
    export const newEmailIntentKey = (s) => s + '|intent';
    export const enqueueEmail = async (data, options) => {
      const s = globalThis.__closeEmailStageTest;
      if (s.recordThenThrow) {
        // BullMQ accepted the job, then the connection dropped before the
        // reply came back: the job exists while this throw fires.
        s.recorded.set(options.jobId, data);
        throw s.enqueueError;
      }
      if (s.enqueueError) throw s.enqueueError;
      s.sent.push(data);
    };
  `,
  '@openbooks/emails': 'export const isValidEmailAddress = () => true;',
  '../delivery/email-attachments.ts': emailAttachmentsStub,
  '../platform/db.ts': `
    export const db = { execute: async () => globalThis.__closeEmailStageTest.queue.shift() ?? { rows: [] } };
    export const withOrgContext = (_org, fn) => fn();
  `,
  '../organization/actor-subsidiaries.ts': 'export const actorAllowedSubsidiaryIds = async () => null;',
  '../reports/ensure-report-definitions.ts': 'export const ensureReportDefinitions = async () => {};',
  './render-client.ts': `export const renderReportPdf = async () => Buffer.from('pdf-bytes');`,
}

const hooks = registerHooks({ resolve(specifier, context, next) {
  const parent = context.parentURL ?? ''
  if (specifier === './email-attachments.ts' && parent.endsWith('/email-enqueue-settlement.ts')) {
    return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(emailAttachmentsStub)}` }
  }
  if (parent.endsWith('/close-delivery-worker.ts') && sources[specifier]) {
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
    package_author: 'user-1',
  }
}

// Consumed in call order: package context load, report-definition lookup,
// report-run insert, report status update, binder lookup, and close event.
function primeDb() {
  state.queue.push(
    { rows: [packageContext()] },
    { rows: [{ slug: 'pnl', id: 'def-1', name: 'P&L' }] },
    { rows: [{ id: 'report-run-1' }] },
    { rows: [] },
    { rows: [] },
    { rows: [] },
  )
}

function reset() {
  state.queue.length = 0
  state.stagedCount = 0
  state.live.clear()
  state.deleted.length = 0
  state.sent.length = 0
  state.recorded.clear()
  state.enqueueError = null
  state.recordThenThrow = false
}

function jobData() {
  return { orgId: 'org-1', packageId: 'pkg-1', runId: 'run-1' }
}

// The queue-state probe the tests inject: the fake queue's recorded jobs.
const probeQueuedJob = async (jobId) => state.recorded.get(jobId) ?? null

test('provable non-acceptance: a failed handoff with no queued job deletes every ref staged in that attempt', async () => {
  reset()
  primeDb()
  state.enqueueError = new Error('Redis unavailable')
  await assert.rejects(processCloseDeliveryJobData(jobData(), { probeQueuedJob }), /Redis unavailable/)
  assert.equal(state.live.size, 0)
  assert.equal(state.deleted.length, 1)
})

test('lost acknowledgement: an enqueue that records the job then throws keeps the blobs for the queued worker', async () => {
  reset()
  primeDb()
  state.enqueueError = new Error('Redis connection lost after accept')
  state.recordThenThrow = true
  const result = await processCloseDeliveryJobData(jobData(), { probeQueuedJob })
  assert.equal(result.files, 1)
  // The blobs are kept, and the recorded job's worker can still read them:
  // every ref the recorded job carries is still live.
  assert.equal(state.live.size, 1)
  assert.deepEqual(state.deleted, [])
  const recorded = state.recorded.get('close-package|org-1|run-1|unbound')
  assert.ok(recorded, 'the accepted job is the deterministic email intent key')
  assert.equal(recorded.attachments.length, 1)
  assert.ok(state.live.has(recorded.attachments[0].storageKey))
})

test('uncheckable queue: when the queue cannot be reached the blobs are kept and the error is rethrown', async () => {
  reset()
  primeDb()
  state.enqueueError = new Error('Redis unavailable')
  await assert.rejects(
    processCloseDeliveryJobData(jobData(), { probeQueuedJob: async () => { throw new Error('cannot reach Redis') } }),
    /Redis unavailable/,
  )
  assert.equal(state.live.size, 1)
  assert.deepEqual(state.deleted, [])
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
