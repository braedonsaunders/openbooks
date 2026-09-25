// Email provider catalogue — the single source of truth for the settings UI and
// the transport factory. Add a provider here (+ a `sendVia` branch) and it lights
// up in the admin form. This module is pure data (no SDK / Node imports) so it is
// safe to map into the client bundle.

export type EmailProvider = 'resend' | 'sendgrid' | 'mailgun' | 'postmark' | 'smtp'

export type EmailFieldKind = 'text' | 'number' | 'boolean' | 'select'

// A non-secret config input a provider needs, beyond the universal sender
// (from name/email) + reply-to. `key` is both the form field name and the
// RawEmailConfig key it persists to.
export type EmailProviderField = {
  key: string
  kind: EmailFieldKind
  required?: boolean
  options?: { value: string }[]
}

export type EmailProviderSpec = {
  value: EmailProvider
  /** Whether this provider authenticates with a single sealed secret. */
  hasSecret: boolean
  /** Whether the secret is mandatory (SMTP can be open-relay / Mailpit). */
  secretRequired: boolean
  /** Extra non-secret config fields this provider needs. */
  fields: EmailProviderField[]
}

export const EMAIL_PROVIDER_SPECS: EmailProviderSpec[] = [
  { value: 'resend', hasSecret: true, secretRequired: true, fields: [] },
  { value: 'sendgrid', hasSecret: true, secretRequired: true, fields: [] },
  {
    value: 'mailgun',
    hasSecret: true,
    secretRequired: true,
    fields: [
      { key: 'mailgunDomain', kind: 'text', required: true },
      { key: 'mailgunRegion', kind: 'select', options: [{ value: 'us' }, { value: 'eu' }] },
    ],
  },
  { value: 'postmark', hasSecret: true, secretRequired: true, fields: [] },
  {
    value: 'smtp',
    hasSecret: true,
    secretRequired: false,
    fields: [
      { key: 'smtpHost', kind: 'text', required: true },
      { key: 'smtpPort', kind: 'number' },
      { key: 'smtpSecure', kind: 'boolean' },
      { key: 'smtpUsername', kind: 'text' },
    ],
  },
]

const SPEC_BY_VALUE = Object.fromEntries(EMAIL_PROVIDER_SPECS.map((s) => [s.value, s])) as Record<EmailProvider, EmailProviderSpec>

export function isEmailProvider(value: unknown): value is EmailProvider {
  return typeof value === 'string' && Object.hasOwn(SPEC_BY_VALUE, value)
}
