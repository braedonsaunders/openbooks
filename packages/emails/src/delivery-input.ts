// Provider-neutral email delivery input validation.
import { normalizeEmailSubject } from './subject'

export type EmailAttachmentPayload = {
  filename: string
  /** Base64-encoded file contents. */
  content: string
  contentType?: string
}

export type EmailDeliveryInput = {
  to: string | string[]
  subject: string
  html: string
  text: string
  attachments?: EmailAttachmentPayload[]
}

export type NormalizedEmailDeliveryInput = Omit<EmailDeliveryInput, 'to'> & {
  to: string[]
}

/**
 * Provider-neutral ceilings applied before a provider request is allocated. The
 * 10 MiB decoded attachment cap leaves room for base64 + MIME overhead below
 * common 20–25 MiB provider limits.
 */
export const EMAIL_DELIVERY_LIMITS = {
  recipientsPerEnqueue: 1_000,
  htmlBytes: 4 * 1024 * 1024,
  textBytes: 2 * 1024 * 1024,
  attachments: 10,
  attachmentBytes: 10 * 1024 * 1024,
  totalAttachmentBytes: 10 * 1024 * 1024,
  filenameBytes: 255,
  contentTypeBytes: 255,
} as const

const MAX_EMAIL_ADDRESS_LENGTH = 254
const BASE64_QUANTUM = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

/**
 * Provider-compatible ASCII mailbox validation for envelope/sender addresses.
 * Deliberately excludes quoted local parts and Unicode because not every
 * supported provider accepts them (SendGrid rejects Unicode From addresses).
 */
export function isValidEmailAddress(value: string): boolean {
  if (!value || value.length > MAX_EMAIL_ADDRESS_LENGTH || !/^[\x21-\x7e]+$/.test(value)) {
    return false
  }
  const at = value.indexOf('@')
  if (at < 1 || at !== value.lastIndexOf('@')) return false
  const local = value.slice(0, at)
  const domain = value.slice(at + 1)
  if (
    local.length > 64 ||
    local.startsWith('.') ||
    local.endsWith('.') ||
    local.includes('..') ||
    !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local)
  ) {
    return false
  }
  if (domain.length > 253 || !domain.includes('.')) return false
  const labels = domain.split('.')
  if (labels.some((label) => !label || label.length > 63 || !/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label))) {
    return false
  }
  const topLevel = labels.at(-1)!
  return topLevel.length >= 2 && !/^\d+$/.test(topLevel)
}

function byteLength(value: string): number {
  let bytes = 0
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index)
    if (codeUnit <= 0x7f) bytes += 1
    else if (codeUnit <= 0x7ff) bytes += 2
    else if (
      codeUnit >= 0xd800 &&
      codeUnit <= 0xdbff &&
      index + 1 < value.length &&
      value.charCodeAt(index + 1) >= 0xdc00 &&
      value.charCodeAt(index + 1) <= 0xdfff
    ) {
      bytes += 4
      index += 1
    } else bytes += 3
  }
  return bytes
}

function decodedBase64Bytes(value: string): number {
  if (value.length === 0) return 0
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
  return (value.length / 4) * 3 - padding
}

function validateAttachment(attachment: EmailAttachmentPayload, index: number): number {
  const label = `Email attachment ${index + 1}`
  if (
    !attachment.filename ||
    byteLength(attachment.filename) > EMAIL_DELIVERY_LIMITS.filenameBytes ||
    /[\x00-\x1f\x7f/\\]/.test(attachment.filename)
  ) {
    throw new Error(`${label} has an invalid filename.`)
  }
  if (
    attachment.contentType !== undefined &&
    (!attachment.contentType ||
      byteLength(attachment.contentType) > EMAIL_DELIVERY_LIMITS.contentTypeBytes ||
      /[\x00-\x1f\x7f]/.test(attachment.contentType))
  ) {
    throw new Error(`${label} has an invalid content type.`)
  }
  const maxEncodedChars = Math.ceil(EMAIL_DELIVERY_LIMITS.attachmentBytes / 3) * 4
  if (attachment.content.length > maxEncodedChars || !BASE64_QUANTUM.test(attachment.content)) {
    throw new Error(`${label} is not valid bounded base64 content.`)
  }
  const decodedBytes = decodedBase64Bytes(attachment.content)
  if (decodedBytes > EMAIL_DELIVERY_LIMITS.attachmentBytes) {
    throw new Error(`${label} exceeds the ${EMAIL_DELIVERY_LIMITS.attachmentBytes}-byte limit.`)
  }
  return decodedBytes
}

/**
 * Validate and normalize an outbound message. Recipient de-duplication is
 * case-insensitive; the first supplied mailbox spelling is retained.
 */
export function normalizeEmailDeliveryInput(
  input: EmailDeliveryInput,
  options: { requireSingleRecipient?: boolean } = {},
): NormalizedEmailDeliveryInput {
  const rawRecipients = Array.isArray(input.to) ? input.to : [input.to]
  if (rawRecipients.length === 0) throw new Error('At least one email recipient is required.')
  if (rawRecipients.length > EMAIL_DELIVERY_LIMITS.recipientsPerEnqueue) {
    throw new Error(`Email delivery exceeds the ${EMAIL_DELIVERY_LIMITS.recipientsPerEnqueue}-recipient limit.`)
  }

  const seen = new Set<string>()
  const to: string[] = []
  for (const raw of rawRecipients) {
    const recipient = raw.trim()
    if (!isValidEmailAddress(recipient)) throw new Error('Email delivery contains an invalid recipient address.')
    const key = recipient.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    to.push(recipient)
  }
  if (to.length === 0) throw new Error('At least one email recipient is required.')
  if (options.requireSingleRecipient && to.length !== 1) {
    throw new Error('Provider delivery requires exactly one recipient per message.')
  }

  const subject = normalizeEmailSubject(input.subject)
  if (!subject) throw new Error('Email subject is required.')
  if (byteLength(input.html) > EMAIL_DELIVERY_LIMITS.htmlBytes) throw new Error(`Email HTML exceeds the ${EMAIL_DELIVERY_LIMITS.htmlBytes}-byte limit.`)
  if (byteLength(input.text) > EMAIL_DELIVERY_LIMITS.textBytes) throw new Error(`Email text exceeds the ${EMAIL_DELIVERY_LIMITS.textBytes}-byte limit.`)
  if (!input.html && !input.text) throw new Error('Email HTML or text content is required.')

  const attachments = input.attachments
  if (attachments && attachments.length > EMAIL_DELIVERY_LIMITS.attachments) {
    throw new Error(`Email delivery exceeds the ${EMAIL_DELIVERY_LIMITS.attachments}-attachment limit.`)
  }
  let totalAttachmentBytes = 0
  for (const [index, attachment] of (attachments ?? []).entries()) {
    totalAttachmentBytes += validateAttachment(attachment, index)
    if (totalAttachmentBytes > EMAIL_DELIVERY_LIMITS.totalAttachmentBytes) {
      throw new Error(`Email attachments exceed the ${EMAIL_DELIVERY_LIMITS.totalAttachmentBytes}-byte total limit.`)
    }
  }

  return { to, subject, html: input.html, text: input.text, ...(attachments ? { attachments } : {}) }
}
