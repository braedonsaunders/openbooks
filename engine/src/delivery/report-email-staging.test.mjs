import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

// DS1: staged attachments are orphaned when the report-delivery handoff fails.
// dispatchReportDeliveries stages the rendered PDF under a fresh random id
// BEFORE the Redis enqueue; the stubs below stand in for staging (no S3 in
// unit) while recording exactly which keys stay live, and for the database
// (a canned answer queue consumed in call order).
globalThis.__reportEmailStageTest = { queue: [], stagedCount: 0, live: new Set(), deleted: [] }
const state = globalThis.__reportEmailStageTest

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
  './email-attachments.ts': `
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
  `,
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
  if (context.parentURL?.endsWith('/report-delivery.ts') && sources[specifier]) {
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
// post-enqueue status update.
function primeDb() {
  state.queue.push({ rows: [] }, { rows: [] }, { rows: [dueRow()] }, { rows: [] })
}

function reset() {
  state.queue.length = 0
  state.stagedCount = 0
  state.live.clear()
  state.deleted.length = 0
}

test('a failing queue handoff deletes every ref staged in that attempt', async () => {
  reset()
  primeDb()
  await assert.rejects(
    dispatchReportDeliveries(
      async () => { throw new Error('Redis unavailable') },
      new Date(),
    ),
    /Redis unavailable/,
  )
  assert.equal(state.live.size, 0)
  assert.equal(state.deleted.length, 1)
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
