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
  label: string
  placeholder?: string
  required?: boolean
  options?: { value: string; label: string }[]
  help?: string
}

export type EmailProviderSpec = {
  value: EmailProvider
  label: string
  /** Whether this provider authenticates with a single sealed secret. */
  hasSecret: boolean
  /** Label for the single sealed secret (api key / server token / password). */
  secretLabel: string
  /** Placeholder shown in the secret field. */
  keyHint: string
  /** Whether the secret is mandatory (SMTP can be open-relay / Mailpit). */
  secretRequired: boolean
  /** Extra non-secret config fields this provider needs. */
  fields: EmailProviderField[]
  /** Optional note shown under the provider picker. */
  docsHint?: string
}

export const EMAIL_PROVIDER_SPECS: EmailProviderSpec[] = [
  { value: 'resend', label: 'Resend', hasSecret: true, secretLabel: 'API key', keyHint: 're_…', secretRequired: true, fields: [] },
  { value: 'sendgrid', label: 'SendGrid', hasSecret: true, secretLabel: 'API key', keyHint: 'SG.…', secretRequired: true, fields: [] },
  {
    value: 'mailgun',
    label: 'Mailgun',
    hasSecret: true,
    secretLabel: 'API key',
    keyHint: 'Your Mailgun sending key',
    secretRequired: true,
    fields: [
      { key: 'mailgunDomain', kind: 'text', label: 'Sending domain', placeholder: 'mg.yourcompany.com', required: true },
      { key: 'mailgunRegion', kind: 'select', label: 'Region', options: [{ value: 'us', label: 'US' }, { value: 'eu', label: 'EU' }] },
    ],
  },
  { value: 'postmark', label: 'Postmark', hasSecret: true, secretLabel: 'Server token', keyHint: 'Your Postmark server token', secretRequired: true, fields: [] },
  {
    value: 'smtp',
    label: 'SMTP (custom)',
    hasSecret: true,
    secretLabel: 'Password',
    keyHint: 'SMTP password (leave blank for an unauthenticated relay)',
    secretRequired: false,
    fields: [
      {
        key: 'smtpHost',
        kind: 'text',
        label: 'Host',
        placeholder: 'smtp.yourprovider.com',
        required: true,
        help: 'Public DNS name on the provider certificate. IP literals are blocked.',
      },
      { key: 'smtpPort', kind: 'number', label: 'Port', placeholder: 'Automatic (465 or 587)', help: 'Blank defaults to 465 with implicit TLS, or 587 with required STARTTLS.' },
      { key: 'smtpSecure', kind: 'boolean', label: 'Use implicit TLS (port 465)' },
      { key: 'smtpUsername', kind: 'text', label: 'Username', placeholder: 'apikey or full email' },
    ],
    docsHint: 'Requires a publicly resolvable DNS host whose TLS certificate matches that name. IP literals are blocked.',
  },
]

const SPEC_BY_VALUE = Object.fromEntries(EMAIL_PROVIDER_SPECS.map((s) => [s.value, s])) as Record<EmailProvider, EmailProviderSpec>

export function isEmailProvider(value: unknown): value is EmailProvider {
  return typeof value === 'string' && Object.hasOwn(SPEC_BY_VALUE, value)
}
