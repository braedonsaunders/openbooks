import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

// DS1: staged attachments are orphaned when the report-delivery handoff fails.
// DS2: the DS1 catch deleted staged refs on ANY enqueue exception — but a
// Redis/BullMQ add can accept the job and then lose its reply, so the job
// exists while the enqueue throws, and the queued worker later refuses the
// missing blob. dispatchReportDeliveries stages the rendered PDF under a
// fresh random id BEFORE the Redis enqueue; the stubs below stand in for
// staging (no S3 in unit) while recording exactly which keys stay live, and
// for the database (a canned answer queue consumed in call order). The
// settlement helper itself is REAL (not stubbed): its static
// './email-attachments.ts' import is served the same tracking stub whenever
// the importing parent is the settlement module, and its dynamic
// '@openbooks/jobs' import reaches the real package, so the expected job
// identities under test are the production fanout plan, not a copy.
globalThis.__reportEmailStageTest = { queue: [], stagedCount: 0, live: new Set(), deleted: [], recorded: new Map() }
const state = globalThis.__reportEmailStageTest

const emailAttachmentsStub = `
    export async function storeEmailAttachments(attachments) {
      const s = globalThis.__reportEmailStageTest;
      return (attachments ?? []).map((a) => {
        const key = 'staged-key-' + (s.stagedCount++);
        s.live.add(key);
        return { filename: a.filename, contentType: a.contentType, storageKey: key };
      });
    }
    export async function deleteStoredEmailAttachments(attachments) {
      const s = globalThis.__reportEmailStageTest;
      for (const a of attachments ?? []) {
        if (a.storageKey) { s.live.delete(a.storageKey); s.deleted.push(a.storageKey); }
      }
    }
  `

const sources = {
  'drizzle-orm': `
    export const sql = Object.assign((...args) => ({}), { join: (...args) => ({}) });
  `,
  '@openbooks/reports': 'export const computeNextRunAt = () => new Date();',
  '@openbooks/jobs': `
    export const enqueueEmail = async () => {};
    export const enqueueReportRun = async () => {};
    export const getEmailQueue = () => ({ remove: async () => {} });
  `,
  '@openbooks/emails': `
    export const deriveEmailDeliveryKey = () => 'delivery-key';
    export const isValidEmailAddress = () => true;
    export const scheduledReportEmail = () => ({ subject: 's', html: '<p>x</p>', text: 'x' });
  `,
  './email-attachments.ts': emailAttachmentsStub,
  '../platform/business-date.ts': `export const businessToday = async () => '2026-01-01';`,
  '../platform/db.ts': `
    export const db = { execute: async () => globalThis.__reportEmailStageTest.queue.shift() ?? { rows: [] } };
  `,
  '../platform/terminal-failure.ts': `
    export const EMAIL_DELIVERY_WORKER_IDENTITY = 'test';
    export const REPORT_RUN_WORKER_IDENTITY = 'test';
    export const logTerminalFailure = () => {};
  `,
  '../platform/telemetry.ts': `
    export const ATTR_DEFINITION_ID = 'a';
    export const ATTR_KIND = 'a';
    export const ATTR_ORG_ID = 'a';
    export const ATTR_RUN_ID = 'a';
    export const ATTR_SURFACE = 'a';
    export const recordOutboxAttempt = () => {};
    export const runInSpan = (_name, _attrs, fn) => fn();
  `,
}

const hooks = registerHooks({ resolve(specifier, context, next) {
  const parent = context.parentURL ?? ''
  if (specifier === './email-attachments.ts' && parent.endsWith('/email-enqueue-settlement.ts')) {
    return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(emailAttachmentsStub)}` }
  }
  if (parent.endsWith('/report-delivery.ts') && sources[specifier]) {
    return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(sources[specifier])}` }
  }
  return next(specifier, context)
} })
const { dispatchReportDeliveries } = await import('./report-delivery.ts')
hooks.deregister()

function dueRow() {
  return {
    id: 'delivery-1',
    org_id: 'org-1',
    run_id: 'run-1',
    recipient: 'a@example.com',
    dispatch_count: 0,
    filename: 'report.pdf',
    content_type: 'application/pdf',
    bytes: Buffer.from('pdf-bytes'),
    report_name: 'P&L',
    org_name: 'Acme',
  }
}

// Consumed in call order: two crash-rebuild scans, the due scan, the
// pre-staging claim, the post-handoff confirm, then per-outcome extras
// (the claim-restore on a provably-failed handoff).
function primeDb(...extra) {
  state.queue.push(
    { rows: [] }, { rows: [] }, { rows: [dueRow()] },
    { rows: [{ id: 'delivery-1' }] }, { rows: [{ id: 'delivery-1' }] }, ...extra,
  )
}

function reset() {
  state.queue.length = 0
  state.stagedCount = 0
  state.live.clear()
  state.deleted.length = 0
  state.recorded.clear()
}

// The queue-state probe the tests inject: the fake queue's recorded jobs.
const probeQueuedJob = async (jobId) => state.recorded.get(jobId) ?? null

test('provable non-acceptance: a failed handoff with no queued job deletes every ref staged in that attempt', async () => {
  reset()
  primeDb({ rows: [{ id: 'delivery-1' }] })
  await assert.rejects(
    dispatchReportDeliveries(
      async () => { throw new Error('Redis unavailable') },
      new Date(),
      { probeQueuedJob },
    ),
    /Redis unavailable/,
  )
  assert.equal(state.live.size, 0)
  assert.equal(state.deleted.length, 1)
})

test('lost acknowledgement: an enqueue that records the job then throws keeps the blobs for the queued worker', async () => {
  reset()
  primeDb()
  const dispatched = await dispatchReportDeliveries(
    async (data, options) => {
      // BullMQ accepted the job, then the connection dropped before the
      // reply came back: the job exists while this throw fires.
      state.recorded.set(options.jobId, data)
      throw new Error('Redis connection lost after accept')
    },
    new Date(),
    { probeQueuedJob },
  )
  // Reported as success: dispatch proceeds down the normal enqueued path.
  assert.equal(dispatched, 1)
  // The blobs are kept, and the recorded job's worker can still read them:
  // every ref the recorded job carries is still live.
  assert.equal(state.live.size, 1)
  assert.deepEqual(state.deleted, [])
  const recorded = state.recorded.get('report-delivery|delivery-1|0')
  assert.ok(recorded, 'the accepted job is the deterministic generation id')
  assert.equal(recorded.attachments.length, 1)
  assert.ok(state.live.has(recorded.attachments[0].storageKey))
})

test('uncheckable queue: when the queue cannot be reached the blobs are kept and the error is rethrown', async () => {
  reset()
  primeDb({ rows: [{ id: 'delivery-1' }] })
  await assert.rejects(
    dispatchReportDeliveries(
      async () => { throw new Error('Redis unavailable') },
      new Date(),
      { probeQueuedJob: async () => { throw new Error('cannot reach Redis for the check') } },
    ),
    /Redis unavailable/,
  )
  assert.equal(state.live.size, 1)
  assert.deepEqual(state.deleted, [])
})

test('a fenced-out dispatcher stages nothing and counts nothing', async () => {
  reset()
  // The due scan still sees the row (a snapshot from before the winner's
  // claim committed), but the pre-staging claim matches zero rows: the
  // winner owns this generation, so the loser must not stage, enqueue, or
  // count.
  state.queue.push({ rows: [] }, { rows: [] }, { rows: [dueRow()] }, { rows: [] })
  let enqueued = 0
  const dispatched = await dispatchReportDeliveries(
    async () => { enqueued++; return [] },
    new Date(),
    { probeQueuedJob },
  )
  assert.equal(dispatched, 0)
  assert.equal(enqueued, 0, 'the loser never reaches the queue')
  assert.equal(state.stagedCount, 0, 'the loser stages no blob set')
  assert.deepEqual(state.deleted, [])
})

test('an unconfirmed dispatch is not counted; its staged refs are deleted when the job never landed', async () => {
  reset()
  // The claim wins and the enqueue reports success, but the row leaves
  // 'enqueued' before the confirm (a concurrent suppression): the staged
  // refs belong to no live dispatch, and the queue holds no job for them,
  // so they are deleted and nothing is counted.
  state.queue.push(
    { rows: [] }, { rows: [] }, { rows: [dueRow()] },
    { rows: [{ id: 'delivery-1' }] }, { rows: [] },
  )
  const dispatched = await dispatchReportDeliveries(async () => [], new Date(), { probeQueuedJob })
  assert.equal(dispatched, 0)
  assert.equal(state.live.size, 0)
  assert.equal(state.deleted.length, 1)
})

test('an unconfirmed dispatch whose job provably exists keeps its blobs but is still not counted', async () => {
  reset()
  // Same fenced-out confirm, but the queued job provably needs the staged
  // refs (a suppression raced a live handoff): the blobs stay for the
  // worker while the count reports only applied dispatches.
  state.queue.push(
    { rows: [] }, { rows: [] }, { rows: [dueRow()] },
    { rows: [{ id: 'delivery-1' }] }, { rows: [] },
  )
  const dispatched = await dispatchReportDeliveries(
    async (data, options) => { state.recorded.set(options.jobId, data) },
    new Date(),
    { probeQueuedJob },
  )
  assert.equal(dispatched, 0)
  assert.equal(state.live.size, 1)
  assert.deepEqual(state.deleted, [])
})

test('a successful handoff keeps the staged refs for the worker to fetch', async () => {
  reset()
  primeDb()
  let sent
  const dispatched = await dispatchReportDeliveries(
    async (data) => { sent = data },
    new Date(),
  )
  assert.equal(dispatched, 1)
  assert.equal(sent.attachments.length, 1)
  assert.ok(sent.attachments[0].storageKey.startsWith('staged-key-'))
  assert.deepEqual(state.deleted, [])
  assert.equal(state.live.size, 1)
})
