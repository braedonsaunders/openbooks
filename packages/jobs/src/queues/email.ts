import { createHash, randomUUID } from 'node:crypto'
import { Queue, type JobsOptions } from 'bullmq'
import {
  assertEmailDeliveryKey,
  deriveEmailDeliveryKey,
  normalizeEmailDeliveryInput,
  type EmailAttachment,
} from '@openbooks/emails'
import { getConnection } from '../connection'

export const EMAIL_QUEUE = 'emails'

export type { EmailAttachment }

export type EmailJobData = {
  /** The org this send belongs to — selects the provider transport + logs. */
  orgId: string
  /** One recipient per durable job prevents address disclosure between users. */
  to: string
  subject: string
  html: string
  text: string
  attachments?: EmailAttachment[]
  /** Per-message Reply-To overriding the org transport default. */
  replyTo?: string
  /**
   * Durable delivery identity, computed at enqueue from the caller's
   * idempotency key — never from the BullMQ job id. BullMQ auto-increment
   * ids restart from 1 after a Redis reset, so a key derived from `job.id`
   * collides with older sent-log rows and new mail is skipped as "already
   * delivered" without ever sending. The worker reconciles + claims the
   * email_log row through this key.
   */
  deliveryKey: string
  meta?: {
    userId?: string
    category?: string
    reportRunId?: string
    reportDeliveryId?: string
    /** Payment remittance row completed by the email worker after provider acceptance. */
    paymentRemittanceId?: string
    /** Dunning claim row settled by the email worker from the provider verdict. */
    dunningLogId?: string
  }
}

export type EnqueueEmailData = Omit<EmailJobData, 'to' | 'deliveryKey'> & { to: string | string[] }

/**
 * The caller's durable idempotency key for one logical send. It must be
 * stable across retries of the same intent (a remittance row id, an outbox
 * row id, a report-delivery generation id) and unique across different
 * intents. Calls with no natural key (one-off notifications) MUST pass a
 * fresh `randomUUID()` — see `newEmailIntentKey` — so a Redis reset can
 * never align new mail with an old sent-log row.
 */
export type EnqueueEmailOptions = Omit<JobsOptions, 'jobId'> & { jobId: string }

/** Fresh intent key for one-off sends with no natural idempotency key. */
export function newEmailIntentKey(prefix: string): string {
  if (!prefix.trim()) throw new Error('email intent keys require a non-empty prefix')
  return `${prefix}|${randomUUID()}`
}

let emailQueue: Queue<EmailJobData> | undefined

export function getEmailQueue(): Queue<EmailJobData> {
  emailQueue ??= new Queue<EmailJobData>(EMAIL_QUEUE, {
    connection: getConnection(),
    defaultJobOptions: {
      attempts: 5,
      backoff: { type: 'exponential', delay: 30_000 },
      // Completed email jobs carry the full message body: the durable record
      // is the email_log row, so completed payloads are trimmed after a day
      // instead of lingering a week in Redis. Failed payloads keep 30 days
      // for diagnosis (they now carry references, not file bytes).
      removeOnComplete: { age: 24 * 3600 },
      removeOnFail: { age: 30 * 24 * 3600 },
    },
  })
  return emailQueue
}

function fanoutOptions(options: EnqueueEmailOptions, recipient: string): EnqueueEmailOptions {
  const digest = createHash('sha256').update(options.jobId).update('\0').update(recipient.toLowerCase()).digest('hex')
  return { ...options, jobId: `email-fanout|${digest}` }
}

export type BuiltEmailJob = { data: EmailJobData; opts: EnqueueEmailOptions }

/**
 * Pure enqueue plan: validate, fan out one job per recipient, and derive
 * each job's durable delivery key from the caller's idempotency key — never
 * from any queue-assigned id. Exported so the identity contract is
 * unit-testable without Redis.
 */
export function buildEmailJobs(data: EnqueueEmailData, options: EnqueueEmailOptions): BuiltEmailJob[] {
  if (!options?.jobId?.trim()) {
    throw new Error('enqueueEmail requires options.jobId: a durable caller-supplied idempotency key (never omit it — BullMQ ids restart after a Redis reset)')
  }
  const normalized = normalizeEmailDeliveryInput(data)
  return normalized.to.map((recipient) => {
    const opts = normalized.to.length === 1 ? options : fanoutOptions(options, recipient)
    const deliveryKey = deriveEmailDeliveryKey({ orgId: data.orgId, scope: opts.jobId, to: recipient })
    return { data: { ...data, ...normalized, to: recipient, deliveryKey }, opts }
  })
}

/** Enqueue one durable job per recipient (deterministic ids dedupe retries). */
export async function enqueueEmail(data: EnqueueEmailData, options: EnqueueEmailOptions) {
  const jobs = buildEmailJobs(data, options)
  const queue = getEmailQueue()
  if (jobs.length === 1) {
    return [await queue.add('send', jobs[0]!.data, jobs[0]!.opts)]
  }
  return queue.addBulk(jobs.map((job) => ({ name: 'send', data: job.data, opts: job.opts })))
}

/**
 * The delivery identity the worker claims its email_log row through. New
 * jobs carry it in `data.deliveryKey`; jobs enqueued before that field
 * existed fall back to the legacy derivation (same scopes the worker used
 * before) so they still drain exactly once.
 */
export function resolveEmailDeliveryKey(
  data: Pick<EmailJobData, 'orgId' | 'to'> & { deliveryKey?: string; meta?: EmailJobData['meta'] },
  queueJobId: string | null,
): string {
  if (data.deliveryKey) return assertEmailDeliveryKey(data.deliveryKey)
  const scope = data.meta?.reportDeliveryId
    ? `report:${data.meta.reportDeliveryId}`
    : data.meta?.paymentRemittanceId
      ? `payment-remittance:${data.meta.paymentRemittanceId}`
      : (queueJobId ?? '')
  return deriveEmailDeliveryKey({ orgId: data.orgId, scope, to: data.to })
}
