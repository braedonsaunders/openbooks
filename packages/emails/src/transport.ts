// Email transport factory + provider implementations. Secret handling and
// host validation come from ./crypto; configuration is scoped per organization.
//
// `RawEmailConfig` is what we persist per org, with the single secret AES-sealed.
// `resolveEmailTransport` unseals it into an `EmailTransport` (plaintext secret);
// `sendVia` performs the network send, switching on provider. HTTP providers go
// through `fetch` (no SDKs); SMTP uses nodemailer (dynamically imported).

import { resolvePublicHost, unsealSecret } from './crypto'
import { isEmailProvider, type EmailProvider } from './providers'
import {
  isValidEmailAddress,
  normalizeEmailDeliveryInput,
  type EmailAttachmentPayload,
  type EmailDeliveryInput,
} from './delivery-input'

export type EmailAttachment = EmailAttachmentPayload
export type SendEmailInput = EmailDeliveryInput

/** Per-org email config persisted in JSON (orgs.settings.email). Secret sealed. */
export type RawEmailConfig = {
  enabled?: boolean
  provider?: EmailProvider
  fromName?: string
  fromEmail?: string
  replyTo?: string
  mailgunDomain?: string
  mailgunRegion?: 'us' | 'eu'
  smtpHost?: string
  smtpPort?: number
  smtpSecure?: boolean
  smtpUsername?: string
  keyCiphertext?: string
  keyNonce?: string
}

type PlainEmailConfig = Omit<RawEmailConfig, 'keyCiphertext' | 'keyNonce'> & { secret?: string }

const MAILGUN_DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i
const SMTP_HOST = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i
const MAX_FROM_NAME_LENGTH = 128
const MAX_SMTP_USERNAME_LENGTH = 320
const MAX_SEALED_SECRET_LENGTH = 8_192

function validateEmailConfigFields(raw: PlainEmailConfig | RawEmailConfig, requireComplete: boolean): void {
  if (raw.provider !== undefined && !isEmailProvider(raw.provider)) throw new Error('Select a valid email provider.')
  if (raw.fromName && (raw.fromName.length > MAX_FROM_NAME_LENGTH || /[<>\r\n]/.test(raw.fromName))) {
    throw new Error('From name must be 128 characters or fewer and cannot contain angle brackets or line breaks.')
  }
  if (raw.fromEmail && !isValidEmailAddress(raw.fromEmail)) throw new Error('Enter a valid From email address.')
  if (raw.replyTo && !isValidEmailAddress(raw.replyTo)) throw new Error('Enter a valid Reply-to email address.')
  if (raw.mailgunDomain && !MAILGUN_DOMAIN.test(raw.mailgunDomain)) throw new Error('Enter a valid Mailgun sending domain, such as mg.example.com.')
  if (raw.smtpHost && !SMTP_HOST.test(raw.smtpHost)) throw new Error('Enter a valid SMTP host without a protocol or path.')
  if (raw.smtpUsername && raw.smtpUsername.length > MAX_SMTP_USERNAME_LENGTH) throw new Error('SMTP username must be 320 characters or fewer.')
  if (raw.mailgunRegion !== undefined && raw.mailgunRegion !== 'us' && raw.mailgunRegion !== 'eu') throw new Error('Select a valid Mailgun region.')
  if (raw.smtpSecure !== undefined && typeof raw.smtpSecure !== 'boolean') throw new Error('SMTP TLS mode must be a boolean.')
  if (raw.smtpPort !== undefined && (!Number.isInteger(raw.smtpPort) || raw.smtpPort < 1 || raw.smtpPort > 65_535)) {
    throw new Error('SMTP port must be a whole number from 1 to 65535.')
  }
  if (!requireComplete) return
  if (!raw.provider) throw new Error('Select an email provider before enabling email delivery.')
  if (!raw.fromEmail) throw new Error('Enter a valid From email address before enabling email delivery.')
  if (raw.provider === 'smtp' && !raw.smtpHost) throw new Error('Enter a valid SMTP host without a protocol or path.')
  if (raw.provider === 'mailgun' && !raw.mailgunDomain) throw new Error('Enter a valid Mailgun sending domain, such as mg.example.com.')
  if (raw.provider === 'smtp' && 'secret' in raw) {
    const hasUsername = Boolean(raw.smtpUsername?.trim())
    const hasPassword = Boolean(raw.secret?.trim())
    if (hasUsername !== hasPassword) {
      throw new Error('SMTP username and password must both be provided, or both omitted for an unauthenticated relay.')
    }
  }
}

/** Validate a persisted provider before it is saved or accepted. */
export function validateStoredEmailConfig(raw: RawEmailConfig, options: { requireComplete?: boolean } = {}): void {
  const requireComplete = options.requireComplete ?? raw.enabled === true
  validateEmailConfigFields(raw, requireComplete)
  const hasCiphertext = Boolean(raw.keyCiphertext?.trim())
  const hasNonce = Boolean(raw.keyNonce?.trim())
  if (hasCiphertext !== hasNonce) throw new Error('The stored provider credential is incomplete; replace it before enabling email.')
  if ((raw.keyCiphertext && raw.keyCiphertext.length > MAX_SEALED_SECRET_LENGTH) || (raw.keyNonce && raw.keyNonce.length > MAX_SEALED_SECRET_LENGTH)) {
    throw new Error('The stored provider credential is invalid; replace it before enabling email.')
  }
  if (requireComplete && raw.provider !== 'smtp' && !(hasCiphertext && hasNonce)) {
    throw new Error("Enter this provider's credential before enabling email delivery.")
  }
  if (raw.provider === 'smtp') {
    const hasUsername = Boolean(raw.smtpUsername?.trim())
    const hasPassword = hasCiphertext && hasNonce
    if (hasUsername !== hasPassword) {
      throw new Error('SMTP username and password must both be provided, or both omitted for an unauthenticated relay.')
    }
  }
}

export type EmailTransport =
  | { provider: 'resend'; apiKey: string; from: string; replyTo?: string }
  | { provider: 'sendgrid'; apiKey: string; from: string; replyTo?: string }
  | { provider: 'mailgun'; apiKey: string; domain: string; region: 'us' | 'eu'; from: string; replyTo?: string }
  | { provider: 'postmark'; serverToken: string; from: string; replyTo?: string }
  | { provider: 'smtp'; host: string; port: number; secure: boolean; username?: string; password?: string; from: string; replyTo?: string }

function formatFrom(name?: string, email?: string): string | null {
  const e = email?.trim()
  if (!e) return null
  const n = name?.trim()
  return n ? `${n} <${e}>` : e
}

function buildTransport(c: PlainEmailConfig): EmailTransport | null {
  try {
    validateEmailConfigFields(c, true)
  } catch {
    return null
  }
  const from = formatFrom(c.fromName, c.fromEmail)
  if (!from) return null
  const replyTo = c.replyTo?.trim() || undefined
  const secret = c.secret?.trim() || undefined
  switch (c.provider) {
    case 'resend':
      return secret ? { provider: 'resend', apiKey: secret, from, replyTo } : null
    case 'sendgrid':
      return secret ? { provider: 'sendgrid', apiKey: secret, from, replyTo } : null
    case 'mailgun':
      if (!secret || !c.mailgunDomain?.trim()) return null
      return { provider: 'mailgun', apiKey: secret, domain: c.mailgunDomain.trim(), region: c.mailgunRegion === 'eu' ? 'eu' : 'us', from, replyTo }
    case 'postmark':
      return secret ? { provider: 'postmark', serverToken: secret, from, replyTo } : null
    case 'smtp': {
      if (!c.smtpHost?.trim()) return null
      const secure = c.smtpSecure === true
      return {
        provider: 'smtp',
        host: c.smtpHost.trim(),
        port: c.smtpPort ?? (secure ? 465 : 587),
        secure,
        username: c.smtpUsername?.trim() || undefined,
        password: secret,
        from,
        replyTo,
      }
    }
    default:
      return null
  }
}

/** Unseal a stored config and build its transport, or null when not configured. */
export function resolveEmailTransport(raw: RawEmailConfig | null | undefined): EmailTransport | null {
  if (!raw || !raw.provider || raw.enabled !== true) return null
  try {
    validateStoredEmailConfig(raw, { requireComplete: true })
  } catch {
    return null
  }
  let secret: string | undefined
  if (raw.keyCiphertext && raw.keyNonce) {
    secret = unsealSecret({ ciphertext: raw.keyCiphertext, nonce: raw.keyNonce }) ?? undefined
  }
  return buildTransport({ ...raw, secret })
}

// --- send -------------------------------------------------------------------

function toArray(v: string | string[]): string[] {
  return Array.isArray(v) ? v : [v]
}

function parseAddress(addr: string): { email: string; name?: string } {
  const trimmed = addr.trim()
  if (!trimmed.endsWith('>')) return { email: trimmed }
  const opening = trimmed.lastIndexOf('<')
  if (opening === -1) return { email: trimmed }
  const email = trimmed.slice(opening + 1, -1).trim()
  const name = trimmed.slice(0, opening).trim()
  return { email, name: name || undefined }
}

type HttpProvider = 'Resend' | 'SendGrid' | 'Mailgun' | 'Postmark'
type ProviderLabel = HttpProvider | 'SMTP'
const TRANSPORT_TIMEOUT_MS = 30_000

function sanitizedText(value: string, redactions: string[] = []): string {
  let printable = ''
  for (const character of value) {
    const codePoint = character.codePointAt(0)!
    printable += codePoint < 32 || codePoint === 127 ? ' ' : character
  }
  for (const sensitiveValue of [...redactions].filter(Boolean).sort((a, b) => b.length - a.length)) {
    if (sensitiveValue) printable = printable.split(sensitiveValue).join('[redacted]')
  }
  return printable.replace(/\s+/g, ' ').trim().slice(0, 300)
}

function errorDetail(body: unknown, redactions: string[]): string | null {
  if (typeof body === 'string') return sanitizedText(body, redactions) || null
  if (!body || typeof body !== 'object') return null
  const record = body as Record<string, unknown>
  if (Array.isArray(record.errors)) {
    const messages = record.errors
      .map((item) => {
        if (!item || typeof item !== 'object') return null
        const message = (item as Record<string, unknown>).message
        return typeof message === 'string' ? sanitizedText(message, redactions) : null
      })
      .filter((message): message is string => Boolean(message))
    if (messages.length > 0) return sanitizedText(messages.join('; '), redactions)
  }
  for (const key of ['message', 'error', 'Message'] as const) {
    const value = record[key]
    if (typeof value === 'string') return sanitizedText(value, redactions) || null
  }
  return null
}

function providerHttpError(provider: HttpProvider, response: Response, body: unknown, redactions: string[]): Error {
  const detail = errorDetail(body, redactions)
  return new Error(`${provider}: HTTP ${response.status}${detail ? ` — ${detail}` : ''}`)
}
function providerContractError(provider: ProviderLabel, detail: string): Error {
  return new Error(`${provider}: invalid success response — ${detail}`)
}
function providerNetworkError(provider: HttpProvider, error: unknown): Error {
  const name = error && typeof error === 'object' && 'name' in error ? String(error.name) : undefined
  const reason = name === 'TimeoutError' || name === 'AbortError' ? `request timed out after ${TRANSPORT_TIMEOUT_MS / 1000} seconds` : 'network request failed'
  return new Error(`${provider}: ${reason}`)
}
async function readResponseBody(provider: HttpProvider, response: Response): Promise<unknown> {
  let text: string
  try {
    text = await response.text()
  } catch (error) {
    throw providerNetworkError(provider, error)
  }
  if (!text) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return text
  }
}
async function providerFetch(provider: HttpProvider, url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(TRANSPORT_TIMEOUT_MS) })
  } catch (error) {
    throw providerNetworkError(provider, error)
  }
}
function responseString(body: unknown, key: string): string {
  if (!body || typeof body !== 'object') return ''
  const value = (body as Record<string, unknown>)[key]
  return typeof value === 'string' ? value.trim() : ''
}
function providerOperationError(provider: ProviderLabel, error: unknown, redactions: string[]): Error {
  const rawMessage = error instanceof Error ? error.message : String(error)
  const detail = sanitizedText(rawMessage, redactions) || 'delivery failed'
  return new Error(`${provider}: ${detail}`)
}

/** Send an email through a resolved transport. Throws on provider error. */
export async function sendVia(transport: EmailTransport, input: SendEmailInput): Promise<{ id: string }> {
  const from = transport.from
  const replyTo = transport.replyTo
  const normalizedInput = normalizeEmailDeliveryInput(input, { requireSingleRecipient: true })
  switch (transport.provider) {
    case 'resend':
      return sendResend(transport, normalizedInput, from, replyTo)
    case 'sendgrid':
      return sendSendgrid(transport, normalizedInput, from, replyTo)
    case 'mailgun':
      return sendMailgun(transport, normalizedInput, from, replyTo)
    case 'postmark':
      return sendPostmark(transport, normalizedInput, from, replyTo)
    case 'smtp':
      return sendSmtp(transport, normalizedInput, from, replyTo)
  }
}

async function sendResend(t: Extract<EmailTransport, { provider: 'resend' }>, input: SendEmailInput, from: string, replyTo?: string): Promise<{ id: string }> {
  const res = await providerFetch('Resend', 'https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${t.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from,
      to: toArray(input.to),
      subject: input.subject,
      html: input.html,
      text: input.text,
      reply_to: replyTo,
      attachments: input.attachments?.map((a) => ({ filename: a.filename, content: a.content, content_type: a.contentType })),
    }),
  })
  const body = await readResponseBody('Resend', res)
  if (res.status !== 200) {
    if (res.ok) throw providerContractError('Resend', `expected HTTP 200, received HTTP ${res.status}`)
    throw providerHttpError('Resend', res, body, [t.apiKey])
  }
  const id = responseString(body, 'id')
  if (!id) throw providerContractError('Resend', 'missing id')
  return { id }
}

async function sendSendgrid(t: Extract<EmailTransport, { provider: 'sendgrid' }>, input: SendEmailInput, from: string, replyTo?: string): Promise<{ id: string }> {
  const content: { type: string; value: string }[] = []
  content.push({ type: 'text/plain', value: input.text || ' ' })
  if (input.html) content.push({ type: 'text/html', value: input.html })
  const res = await providerFetch('SendGrid', 'https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${t.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      personalizations: [{ to: toArray(input.to).map((email) => ({ email })) }],
      from: parseAddress(from),
      reply_to: replyTo ? parseAddress(replyTo) : undefined,
      subject: input.subject,
      content,
      attachments: input.attachments?.map((a) => ({ filename: a.filename, content: a.content, type: a.contentType, disposition: 'attachment' })),
    }),
  })
  if (res.status !== 202) {
    const body = await readResponseBody('SendGrid', res)
    if (res.ok) throw providerContractError('SendGrid', `expected HTTP 202, received HTTP ${res.status}`)
    throw providerHttpError('SendGrid', res, body, [t.apiKey])
  }
  const id = res.headers.get('x-message-id')?.trim()
  if (!id) throw providerContractError('SendGrid', 'missing x-message-id header')
  return { id }
}

async function sendMailgun(t: Extract<EmailTransport, { provider: 'mailgun' }>, input: SendEmailInput, from: string, replyTo?: string): Promise<{ id: string }> {
  const form = new FormData()
  form.set('from', from)
  for (const to of toArray(input.to)) form.append('to', to)
  form.set('subject', input.subject)
  if (input.text) form.set('text', input.text)
  if (input.html) form.set('html', input.html)
  if (replyTo) form.set('h:Reply-To', replyTo)
  for (const a of input.attachments ?? []) {
    const blob = new Blob([Buffer.from(a.content, 'base64')], { type: a.contentType || 'application/octet-stream' })
    form.append('attachment', blob, a.filename)
  }
  const base = t.region === 'eu' ? 'https://api.eu.mailgun.net' : 'https://api.mailgun.net'
  const res = await providerFetch('Mailgun', `${base}/v3/${t.domain}/messages`, {
    method: 'POST',
    headers: { Authorization: `Basic ${Buffer.from(`api:${t.apiKey}`).toString('base64')}` },
    body: form,
  })
  const body = await readResponseBody('Mailgun', res)
  if (res.status !== 200) {
    if (res.ok) throw providerContractError('Mailgun', `expected HTTP 200, received HTTP ${res.status}`)
    throw providerHttpError('Mailgun', res, body, [t.apiKey])
  }
  const id = responseString(body, 'id')
  if (!id) throw providerContractError('Mailgun', 'missing id')
  return { id }
}

async function sendPostmark(t: Extract<EmailTransport, { provider: 'postmark' }>, input: SendEmailInput, from: string, replyTo?: string): Promise<{ id: string }> {
  const res = await providerFetch('Postmark', 'https://api.postmarkapp.com/email', {
    method: 'POST',
    headers: { 'X-Postmark-Server-Token': t.serverToken, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      From: from,
      To: toArray(input.to).join(', '),
      Subject: input.subject,
      HtmlBody: input.html || undefined,
      TextBody: input.text || undefined,
      ReplyTo: replyTo,
      Attachments: input.attachments?.map((a) => ({ Name: a.filename, Content: a.content, ContentType: a.contentType || 'application/octet-stream' })),
    }),
  })
  const body = await readResponseBody('Postmark', res)
  if (res.status !== 200) {
    if (res.ok) throw providerContractError('Postmark', `expected HTTP 200, received HTTP ${res.status}`)
    throw providerHttpError('Postmark', res, body, [t.serverToken])
  }
  const json = body && typeof body === 'object' ? (body as Record<string, unknown>) : null
  if (!json || json.ErrorCode !== 0) throw providerHttpError('Postmark', res, body, [t.serverToken])
  const id = responseString(body, 'MessageID')
  if (!id) throw providerContractError('Postmark', 'missing MessageID')
  return { id }
}

async function sendSmtp(t: Extract<EmailTransport, { provider: 'smtp' }>, input: SendEmailInput, from: string, replyTo?: string): Promise<{ id: string }> {
  if (Boolean(t.username) !== Boolean(t.password)) {
    throw new Error('SMTP: username and password must both be provided, or both omitted for an unauthenticated relay')
  }
  const redactions = [t.password ?? '', t.username ?? ''].filter(Boolean)
  const loopback = ['localhost', '127.0.0.1', '::1'].includes(t.host.trim().toLowerCase())
  let connectionOptions: Record<string, unknown>
  if (loopback) {
    // Dev catcher (Mailpit/Ethereal-local): plaintext loopback, no TLS verify.
    connectionOptions = {
      host: t.host,
      port: t.port,
      secure: t.secure,
      ignoreTLS: !t.secure,
      auth: t.username ? { user: t.username, pass: t.password! } : undefined,
      connectionTimeout: TRANSPORT_TIMEOUT_MS,
      greetingTimeout: TRANSPORT_TIMEOUT_MS,
      socketTimeout: TRANSPORT_TIMEOUT_MS,
    }
  } else {
    let resolved
    try {
      resolved = await resolvePublicHost(t.host, { timeoutMs: TRANSPORT_TIMEOUT_MS })
      if (resolved.ipLiteral) throw new Error('External SMTP host must be a DNS name so its TLS identity can be verified.')
    } catch (error) {
      throw providerOperationError('SMTP', error, redactions)
    }
    connectionOptions = {
      host: resolved.address,
      port: t.port,
      secure: t.secure,
      requireTLS: !t.secure,
      auth: t.username ? { user: t.username, pass: t.password! } : undefined,
      tls: { rejectUnauthorized: true, servername: resolved.hostname },
      connectionTimeout: TRANSPORT_TIMEOUT_MS,
      greetingTimeout: TRANSPORT_TIMEOUT_MS,
      socketTimeout: TRANSPORT_TIMEOUT_MS,
    }
  }
  const nodemailer = (await import('nodemailer')).default
  let info: { messageId?: unknown }
  try {
    const tx = nodemailer.createTransport(connectionOptions)
    info = await tx.sendMail({
      from,
      to: toArray(input.to),
      subject: input.subject,
      text: input.text,
      html: input.html,
      replyTo,
      attachments: input.attachments?.map((a) => ({ filename: a.filename, content: Buffer.from(a.content, 'base64'), contentType: a.contentType })),
    })
  } catch (error) {
    throw providerOperationError('SMTP', error, redactions)
  }
  const id = typeof info.messageId === 'string' ? info.messageId.trim() : ''
  if (!id) throw providerContractError('SMTP', 'missing messageId')
  return { id }
}
