import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

const state = { handler: null, sent: 0, events: [], accepted: false }
globalThis.__reportEmailTest = state
const sources = {
  bullmq: 'export class Worker { constructor(_queue, handler) { globalThis.__reportEmailTest.handler = handler } }',
  '@openbooks/jobs': 'export const EMAIL_QUEUE = "test"; export const getBlockingConnection = () => ({});',
  '@openbooks/emails': `
    export const deriveEmailDeliveryKey = () => 'delivery';
    export const reconcileDeliveryAttempts = () => globalThis.__reportEmailTest.accepted
      ? { action: 'complete', providerMessageId: 'prior-acceptance' } : { action: 'send' };
    export async function sendVia() { globalThis.__reportEmailTest.sent++; return { kind: 'sent', providerMessageId: 'new' }; }
  `,
  '../db.ts': `export const db = { execute: async () => ({rows:[{run_id:'run',definition_id:'definition'}]}) };
    export const withOrgContext = (_org, action) => action();`,
  '../sandbox/guard.ts': 'export const isSandboxOrg = async () => false;',
  '../email-config.ts': `
    export const resolveOrgEmailTransport = async () => ({ provider: 'test' });
    export const claimEmailDeliveryLog = async () => ({id:'log',attempts:[]});
    export const appendEmailAttemptEvent = async (_org, _id, event) => globalThis.__reportEmailTest.events.push(event);
    ${['confirmEmailSentGuarded', 'markEmailFailed', 'markEmailSent', 'markEmailSuppressed', 'markEmailUncertain'].map((name) => `export const ${name} = async () => {};`).join('\n')}
  `,
  '../report-delivery.ts': `
    export const markReportDeliveryFailed = async (...args) => globalThis.__reportEmailTest.events.push({failure:args});
    ${['markReportDeliverySent', 'markReportDeliveryStarted', 'markReportDeliverySuppressed'].map((name) => `export const ${name} = async () => {};`).join('\n')}
  `,
}
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.endsWith('/email-worker.ts') && sources[specifier]) {
    return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(sources[specifier])}` }
  }
  return next(specifier, context)
} })
const { createEmailWorker } = await import('./email-worker.ts')
createEmailWorker()
hooks.deregister()
const job = { id: 'job', attemptsMade: 0, opts: { attempts: 1 }, data: {
  orgId: 'org', to: 'recipient@example.test', subject: 'test', html: '', meta: { reportDeliveryId: 'delivery' },
} }

test('revoked queued reports never transmit and retain terminal failure evidence', async () => {
  const fetchBefore = globalThis.fetch
  globalThis.fetch = async (_url, options) => {
    assert.equal(options.redirect, 'error')
    return new Response('', { status: 403 })
  }
  try {
    await assert.rejects(state.handler(job), /authorization failed: HTTP 403/)
    assert.equal(state.sent, 0)
    assert.ok(state.events.some((event) => event.outcome === 'notSent'))
    assert.ok(state.events.some((event) => event.failure?.[4] === true))
  } finally { globalThis.fetch = fetchBefore }
})

test('accepted delivery retries reconcile without authorization or retransmission', async () => {
  state.accepted = true
  const fetchBefore = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('must not request authorization for an accepted replay') }
  try {
    assert.deepEqual(await state.handler(job), { id: 'prior-acceptance', reconciled: true })
    assert.equal(state.sent, 0)
  } finally { globalThis.fetch = fetchBefore }
})
