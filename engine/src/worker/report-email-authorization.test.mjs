import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

const state = { handler: null, sent: 0, events: [], accepted: false }
globalThis.__reportEmailTest = state
const sources = {
  bullmq: 'export class Worker { constructor(_queue, handler) { globalThis.__reportEmailTest.handler = handler } }',
  '@openbooks/jobs': 'export const EMAIL_QUEUE = "test"; export const getBlockingConnection = () => ({}); export const resolveEmailDeliveryKey = () => "delivery-key";',
  '../delivery/email-attachments.ts': 'export const loadEmailAttachments = async () => []; export const deleteStoredEmailAttachments = async () => {};',
  '@openbooks/emails': `
    export const deriveEmailDeliveryKey = () => 'delivery';
    export const reconcileDeliveryAttempts = () => globalThis.__reportEmailTest.accepted
      ? { action: 'complete', providerMessageId: 'prior-acceptance' } : { action: 'send' };
    export async function sendVia() { globalThis.__reportEmailTest.sent++; return { kind: 'sent', providerMessageId: 'new' }; }
  `,
  '../platform/db.ts': `export const db = { execute: async () => ({rows:[{run_id:'run',definition_id:'definition'}]}) };
    export const withOrgContext = (_org, action) => action();`,
  '../organization/sandbox-guard.ts': 'export const isSandboxOrg = async () => false;',
  '../delivery/email-config.ts': `
    export const resolveOrgEmailTransport = async () => ({ provider: 'test' });
    export const claimEmailDeliveryLog = async () => ({id:'log',attempts:[]});
    export const appendEmailAttemptEvent = async (_org, _id, event) => globalThis.__reportEmailTest.events.push(event);
    ${['confirmEmailSentGuarded', 'markDunningClaimFailed', 'markDunningClaimSent', 'markEmailFailed', 'markEmailSent', 'markEmailSuppressed', 'markEmailUncertain', 'markPaymentRemittanceAttempt', 'markPaymentRemittanceFailed', 'markPaymentRemittanceSent'].map((name) => `export const ${name} = async () => {};`).join('\n')}
  `,
  '../delivery/report-delivery.ts': `
    export const markReportDeliveryFailed = async (...args) => globalThis.__reportEmailTest.events.push({failure:args});
    ${['markReportDeliverySent', 'markReportDeliverySuppressed'].map((name) => `export const ${name} = async () => {};`).join('\n')}
    // The start mark is a lease: a falsy answer means another worker holds
    // the delivery and this job stands down (0c06c2e63).
    export const markReportDeliveryStarted = async () => true;
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

test('a revoked schedule carries the re-authorization remedy into the delivery failure record', async () => {
  state.accepted = false
  const failuresBefore = state.events.filter((event) => event.failure).length
  const fetchBefore = globalThis.fetch
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: 'report schedule requires reauthorization' }), { status: 403 })
  try {
    await assert.rejects(state.handler(job), /requires reauthorization/)
    assert.equal(state.sent, 0)
    const failures = state.events.filter((event) => event.failure)
    assert.equal(failures.length, failuresBefore + 1)
    assert.match(String(failures[failures.length - 1].failure[3]), /requires reauthorization/)
  } finally { globalThis.fetch = fetchBefore }
})
