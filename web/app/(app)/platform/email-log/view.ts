import 'server-only'

import {
  badge,
  column,
  field,
  grid,
  page,
  pageHeader,
  pagination,
  ref,
  table,
  text,
  widgetBlock,
  widgetCell,
  type PageSpec,
} from '@openbooks/viewspec'
import { parseListParams, pickString } from '../../../../lib/list-params'
import { platformEmails, type PlatformEmail } from '../../../../lib/platform-admin'

/**
 * The cross-organization email log, split into a loader and a spec.
 *
 * No new vocabulary. The evidence column composes provider, send time and an
 * optional delivery error into one string plus an error line, so the spec
 * binds two fields rather than reconstructing the sentence.
 */

const BASE = '/platform/email-log'
const SORTS = ['created', 'organization', 'recipient', 'subject', 'status'] as const
const STATUSES: PlatformEmail['status'][] = ['queued', 'sent', 'failed', 'suppressed', 'uncertain']

function formatDate(value: string | Date | null): string {
  if (!value) return '—'
  return new Intl.DateTimeFormat('en-CA', { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(value),
  )
}

function statusVariant(
  status: PlatformEmail['status'],
): 'success' | 'destructive' | 'warning' | 'secondary' {
  if (status === 'sent') return 'success'
  if (status === 'failed') return 'destructive'
  if (status === 'queued') return 'warning'
  // Uncertain: the provider may have accepted the message — needs operator
  // reconciliation before anything is re-sent. Show it as an alert, not a
  // silent failure.
  if (status === 'uncertain') return 'warning'
  return 'secondary'
}

export interface EmailRow {
  id: string
  created: string
  orgName: string
  recipient: string
  subject: string
  category: string
  status: string
  statusVariant: 'success' | 'destructive' | 'warning' | 'secondary'
  evidence: string
  error: string
}

export interface EmailLogData {
  currentParams: Record<string, string | string[] | undefined>
  statusOptions: { value: string; label: string; count: number }[]
  isEmpty: boolean
  hasRows: boolean
  rows: EmailRow[]
  total: number
  currentPage: number
  perPage: number
  sort: string
  dir: string
}

export async function loadEmailLog(
  sp: Record<string, string | string[] | undefined>,
): Promise<EmailLogData> {
  const statusParam = pickString(sp.status)
  const status = STATUSES.includes(statusParam as PlatformEmail['status'])
    ? (statusParam as PlatformEmail['status'])
    : undefined
  const params = parseListParams(sp, {
    sort: 'created',
    dir: 'desc',
    perPage: 25,
    allowedSorts: SORTS,
  })
  const result = await platformEmails({ ...params, status })

  return {
    currentParams: sp,
    statusOptions: STATUSES.map((value) => ({
      value,
      label: value.charAt(0).toUpperCase() + value.slice(1),
      count: result.statusCounts[value] ?? 0,
    })),
    isEmpty: result.rows.length === 0,
    hasRows: result.rows.length > 0,
    rows: result.rows.map((email) => ({
      id: email.id,
      created: formatDate(email.createdAt),
      orgName: email.orgName,
      recipient: email.recipientPrimary || email.recipients.join(', ') || '—',
      subject: email.subject,
      category: email.categoryKey ?? '',
      status: email.status,
      statusVariant: statusVariant(email.status),
      evidence: `${email.provider || 'provider not recorded'} · ${
        email.sentAt ? `sent ${formatDate(email.sentAt)}` : 'not sent'
      }`,
      error: email.errorMessage ?? '',
    })),
    total: result.total,
    currentPage: params.page,
    perPage: params.perPage,
    sort: params.sort,
    dir: params.dir,
  }
}

const f = ref<EmailLogData>()
const item = field

export function emailLogSpec(data: EmailLogData): PageSpec {
  return page({
    layout: 'list',
    header: [
      pageHeader({
        title: 'Email log',
        description:
          'Cross-organization evidence for queued, sent, failed, suppressed, and uncertain email.',
        back: { href: '/platform', label: 'Super Admin' },
      }),
      grid('flex flex-wrap items-center gap-2', [
        widgetBlock('search-input', {
          placeholder: 'Search subject, recipient, provider, or organization…',
        }),
        widgetBlock('filter-chips', {
          basePath: BASE,
          currentParams: data.currentParams,
          paramKey: 'status',
          label: 'Status',
          options: data.statusOptions,
        }),
      ]),
    ],
    body: [
      {
        ...widgetBlock('empty-state', {
          icon: 'mail',
          title: 'No email events found',
          description: 'Try broadening the search or status filter.',
        }),
        when: f('isEmpty'),
      },
      {
        ...grid('overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900', [
          table({
            variant: 'app',
            rows: f('rows'),
            rowKey: item('id'),
            sorting: { basePath: BASE, sort: f('sort'), dir: f('dir') },
            columns: [
              column('Created', text(item('created')), {
                sort: 'created',
                className: 'whitespace-nowrap text-sm',
              }),
              column('Organization', text(item('orgName')), {
                sort: 'organization',
                className: 'font-medium',
              }),
              column('Recipient', text(item('recipient')), { sort: 'recipient' }),
              column(
                'Subject',
                widgetCell('email-subject-cell', {
                  subject: item('subject'),
                  category: item('category'),
                }),
                { sort: 'subject' },
              ),
              column('Status', badge(item('status'), { variant: item('statusVariant') }), {
                sort: 'status',
              }),
              column(
                'Evidence',
                widgetCell('email-evidence-cell', { summary: item('evidence'), error: item('error') }),
              ),
            ],
          }),
          pagination({
            basePath: BASE,
            total: f('total'),
            page: f('currentPage'),
            perPage: f('perPage'),
            bare: true,
          }),
        ]),
        when: f('hasRows'),
      },
    ],
  })
}
