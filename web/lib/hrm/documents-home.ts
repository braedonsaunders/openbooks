import 'server-only'

import { sql } from 'drizzle-orm'
import { getLocale, getTranslations } from 'next-intl/server'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { getDocumentDetail, listDocuments } from '@openbooks/engine/src/hrm/documents/documents.ts'
import { HrmDocumentsError } from '@openbooks/engine/src/hrm/documents/errors.ts'
import { listCategories } from '@openbooks/engine/src/hrm/documents/categories.ts'
import { listTemplates } from '@openbooks/engine/src/hrm/documents/templates.ts'
import { hrmGroupTabs } from '../../components/module-home/group-tabs'
import { hrmPeopleViewTabs } from './workspace-tabs'
import { can, requirePermission, type Authz } from '../authz'
import { requireFeatureEnabled } from '../feature-gates'
import { setupSectionParams } from '../list-params'
import { resolveTimeZone } from '../locale'
import { viewerDateTime } from '../format'
import { listScopedPartyOptions } from '../scoped-options'

/**
 * HR documents home loader (0230, HR-19).
 *
 * Rows resolve through the canonical engine reads (listDocuments,
 * getDocumentDetail, listTemplates, listCategories, listExports,
 * listRetentionActions); the loader only joins display names from
 * parties and computes the four statTiles. Renders only when hrm and
 * hrmDocuments are on and the actor holds hrm.documents.read — a
 * switched-off feature redirects to its remedy instead, the same gate
 * the route-gate scanner reads on
 * the cockpit. No org id, user id, or Authz crosses into the spec.
 */

export const DOCUMENT_STATUSES = [
  'draft',
  'sent',
  'viewed',
  'partially_signed',
  'signed',
  'acknowledged',
  'declined',
  'voided',
  'expired',
] as const

export interface DocumentsHomeAuthz {
  orgId: string
  userId: string
  canManage: boolean
  session: Authz
}

export async function documentsAuthz(): Promise<DocumentsHomeAuthz | null> {
  let gate
  try {
    gate = await requirePermission('hrm.documents.read')
  } catch (error) {
    // requirePermission answers a missing grant with a redirect to the
    // access-denied page: rethrowing lets it name the missing
    // permission, while swallowing it 404s instead. Matched on the
    // digest string like page-layouts — Next's own predicate is not
    // public API.
    const digest = (error as { digest?: unknown } | null)?.digest
    if (typeof digest === 'string' && digest.startsWith('NEXT_REDIRECT')) throw error
    return null
  }
  await requireFeatureEnabled(gate.user.orgId, 'hrm')
  await requireFeatureEnabled(gate.user.orgId, 'hrmDocuments')
  return { orgId: gate.user.orgId, userId: gate.user.id, canManage: can(gate, 'hrm.documents.manage'), session: gate }
}

export interface DocumentRow {
  id: string
  title: string
  person: string | null
  category: string
  status: string
  statusLabel: string
  statusVariant: 'default' | 'secondary' | 'outline' | 'destructive' | 'warning' | 'success'
  sent: string | null
  expires: string | null
  hold: boolean
  href: string
}

export interface DocumentTile {
  iconKey: string
  accent: string
  label: string
  value: string
  tone: 'default' | 'warning' | 'negative' | 'positive'
}

function statusVariant(status: string): DocumentRow['statusVariant'] {
  switch (status) {
    case 'signed':
    case 'acknowledged':
      return 'success'
    case 'sent':
    case 'viewed':
    case 'partially_signed':
      return 'warning'
    case 'declined':
    case 'voided':
    case 'expired':
      return 'destructive'
    case 'draft':
      return 'secondary'
    default:
      return 'outline'
  }
}

function hrefFor(status: string | null, document: string | null, generating: boolean): string {
  const params = new URLSearchParams()
  if (status) params.set('status', status)
  if (document) params.set('document', document)
  if (generating) params.set('generate', '1')
  const query = params.toString()
  return query ? `/hrm/documents?${query}` : '/hrm/documents'
}

async function partyNames(orgId: string, partyIds: string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>()
  const unique = [...new Set(partyIds.filter(Boolean))]
  if (unique.length === 0) return names
  const rows = (await db.execute<{ id: string; name: string }>(sql`
    select id::text as id, display_name as name from parties
     where org_id = ${orgId}::uuid and id in (${sql.join(unique.map((id) => sql`${id}::uuid`), sql`, `)})`)).rows
  for (const row of rows) names.set(row.id, row.name)
  return names
}

export async function loadDocumentsHome(
  authz: DocumentsHomeAuthz,
  sp: Record<string, string | undefined>,
) {
  const [t, retentionAction, locale, timeZone] = await Promise.all([
    getTranslations('hrm'),
    getTranslations('admin.setup.options.hrmDocAction'),
    getLocale(),
    resolveTimeZone(),
  ])
  const tabs = await hrmGroupTabs(authz.session, '/hrm/documents')
  const viewTabs = await hrmPeopleViewTabs(authz.session, '/hrm/documents')
  const status =
    typeof sp.status === 'string' && (DOCUMENT_STATUSES as readonly string[]).includes(sp.status)
      ? sp.status
      : null
  const generating = sp.generate === '1' && authz.canManage
  const documentId = typeof sp.document === 'string' && sp.document.length > 0 ? sp.document : null
  const unrestrictedStats = authz.session.allowedSubsidiaryIds === null

  const [documents, counts, categories, templates] = await Promise.all([
    listDocuments({ orgId: authz.orgId, actorId: authz.userId, ...(status ? { status } : {}) }),
    unrestrictedStats
      ? db.execute<{ status: string; count: string }>(sql`
          select status, count(*)::text as count from hrm_documents
           where org_id = ${authz.orgId}::uuid and status != 'deleted'
           group by status`)
      : Promise.resolve({ rows: [] as { status: string; count: string }[] }),
    listCategories({ orgId: authz.orgId, actorId: authz.userId }),
    authz.canManage
      ? listTemplates({ orgId: authz.orgId, actorId: authz.userId })
      : Promise.resolve([]),
  ])
  const names = await partyNames(
    authz.orgId,
    documents.map((d) => d.partyId ?? ''),
  )
  const statusLabel = (value: string): string => t(`documents.status.${value}`)
  const countBy = new Map(counts.rows.map((r) => [r.status, Number(r.count)]))
  const awaiting = (countBy.get('sent') ?? 0) + (countBy.get('viewed') ?? 0) + (countBy.get('partially_signed') ?? 0)
  const expiringRows = unrestrictedStats ? (await db.execute<{ count: string }>(sql`
    select count(*)::text as count from hrm_documents
     where org_id = ${authz.orgId}::uuid and status in ('sent', 'viewed', 'partially_signed')
       and expires_at is not null and expires_at < now() + interval '14 days'`)).rows[0] : undefined
  const retentionRows = unrestrictedStats ? (await db.execute<{ count: string }>(sql`
    select count(*)::text as count from hrm_retention_actions
     where org_id = ${authz.orgId}::uuid and executed_at is null`)).rows[0] : undefined
  // Queued AND building: a claimed export is still pending from the
  // operator's view — counting queued alone would hide in-flight builds.
  const exportRows = unrestrictedStats ? (await db.execute<{ count: string }>(sql`
    select count(*)::text as count from hrm_data_subject_exports
     where org_id = ${authz.orgId}::uuid and status in ('queued', 'building')`)).rows[0] : undefined

  const tiles: DocumentTile[] = [
    { iconKey: 'pen-line', accent: 'amber', label: t('documents.tiles.awaiting'), value: unrestrictedStats ? String(awaiting) : '—', tone: unrestrictedStats && awaiting > 0 ? 'warning' : 'default' },
    { iconKey: 'alarm-clock', accent: 'red', label: t('documents.tiles.expiring'), value: unrestrictedStats ? (expiringRows?.count ?? '0') : '—', tone: Number(expiringRows?.count ?? 0) > 0 ? 'negative' : 'default' },
    { iconKey: 'archive', accent: 'slate', label: t('documents.tiles.retentionDue'), value: unrestrictedStats ? (retentionRows?.count ?? '0') : '—', tone: 'default' },
    { iconKey: 'package-open', accent: 'blue', label: t('documents.tiles.exportsPending'), value: unrestrictedStats ? (exportRows?.count ?? '0') : '—', tone: 'default' },
  ]

  const rows: DocumentRow[] = documents.map((doc) => ({
    id: doc.id,
    title: doc.title,
    person: doc.partyId ? (names.get(doc.partyId) ?? null) : null,
    category: categories.find((c) => c.key === doc.categoryKey)?.label ?? doc.categoryKey,
    status: doc.status,
    statusLabel: statusLabel(doc.status),
    statusVariant: statusVariant(doc.status),
    sent: doc.sentAt ? viewerDateTime(doc.sentAt, locale, timeZone) : null,
    expires: doc.expiresAt ? viewerDateTime(doc.expiresAt, locale, timeZone) : null,
    hold: doc.legalHold,
    href: hrefFor(status, doc.id, false),
  }))

  let drawer: {
    closeHref: string
    title: string
    document: Awaited<ReturnType<typeof getDocumentDetail>> | null
    versions: { filename: string; versionNumber: number; createdAt: string }[]
    signerNames: Record<string, string>
    missingDetail: string | null
    loadError: boolean
    labels: Record<string, string>
    // F3-38: Send, Remind, Void and Legal-hold render only with the
    // manage grant, never on document status alone.
    canManage: boolean
  } | null = null
  if (documentId) {
    let document: Awaited<ReturnType<typeof getDocumentDetail>> | null = null
    let versions: { filename: string; versionNumber: number; createdAt: string }[] = []
    let signerNames = new Map<string, string>()
    let loadError = false
    try {
      document = await getDocumentDetail({ orgId: authz.orgId, actorId: authz.userId, documentId })
      signerNames = await partyNames(authz.orgId, document.signers.map((s) => s.signerPartyId))
      if (document.fileId) {
        versions = (await db.execute<{ filename: string; versionNumber: number; createdAt: string }>(sql`
          select f.name as filename, v.version_number as "versionNumber", v.created_at::text as "createdAt"
            from files f join file_versions v on v.file_id = f.id
           where f.org_id = ${authz.orgId}::uuid and f.id = ${document.fileId}::uuid
           order by v.version_number desc
        `)).rows
      }
    } catch (error) {
      if (error instanceof HrmDocumentsError && (error.code === 'NOT_FOUND' || error.code === 'FORBIDDEN')) {
        document = null
      } else {
        loadError = true
      }
    }
    drawer = {
      closeHref: hrefFor(status, null, false),
      title: document?.title ?? t('documents.drawer.title'),
      canManage: authz.canManage,
      document: loadError ? null : document,
      versions: loadError ? [] : versions,
      signerNames: Object.fromEntries(signerNames),
      missingDetail: loadError ? t('documents.drawer.loadFailed') : document ? null : t('documents.drawer.missing'),
      loadError,
      labels: {
        signers: t('documents.drawer.signers'),
        events: t('documents.drawer.events'),
        versions: t('documents.drawer.versions'),
        send: t('documents.drawer.send'),
        remind: t('documents.drawer.remind'),
        void: t('documents.drawer.void'),
        hold: t('documents.drawer.hold'),
        releaseHold: t('documents.drawer.releaseHold'),
        download: t('documents.drawer.download'),
        voidReason: t('documents.drawer.voidReason'),
        voidConfirm: t('documents.drawer.voidConfirm'),
        cancel: t('documents.drawer.cancel'),
        actionFailed: t('documents.drawer.actionFailed'),
        noSigners: t('documents.drawer.noSigners'),
        noEvents: t('documents.drawer.noEvents'),
        declined: t('documents.drawer.declined'),
        signed: t('documents.drawer.signed'),
        pending: t('documents.drawer.pending'),
        viewed: t('documents.drawer.viewed'),
        retention: t('documents.drawer.retention'),
        retentionActionDelete: retentionAction('delete'),
        retentionActionAnonymize: retentionAction('anonymize'),
        retentionUnverified: t('documents.drawer.retentionUnverified'),
        eventCreated: t('documents.drawer.eventCreated'),
        eventSent: t('documents.drawer.eventSent'),
        eventViewed: t('documents.drawer.eventViewed'),
        eventSigned: t('documents.drawer.eventSigned'),
        eventDeclined: t('documents.drawer.eventDeclined'),
        eventAcknowledged: t('documents.drawer.eventAcknowledged'),
        eventVoided: t('documents.drawer.eventVoided'),
        eventReminded: t('documents.drawer.eventReminded'),
        eventExpired: t('documents.drawer.eventExpired'),
        eventRetentionFlagged: t('documents.drawer.eventRetentionFlagged'),
        eventDeleted: t('documents.drawer.eventDeleted'),
      },
    }
  }

  // The generate dialog's inputs: active templates with their category
  // labels plus the people a document may name — ids, never PII beyond
  // the display name the HR reader already sees.
  let generate: {
    closeHref: string
    templates: { value: string; label: string; category: string; mergeFields: string[] }[]
    people: { value: string; label: string }[]
    labels: Record<string, string>
  } | null = null
  if (generating) {
    const people = await listScopedPartyOptions(authz.orgId, authz.session.allowedSubsidiaryIds, { activeOnly: true, kind: 'person' })
    generate = {
      closeHref: hrefFor(status, null, false),
      templates: templates
        .filter((tpl) => tpl.isActive)
        .map((tpl) => ({
          value: tpl.id,
          label: tpl.name,
          category: categories.find((c) => c.key === tpl.categoryKey)?.label ?? tpl.categoryKey,
          mergeFields: tpl.mergeFields,
        })),
      people: people.map((p) => ({ value: p.id, label: p.display_name })),
      labels: {
        title: t('documents.generate.title'),
        template: t('documents.generate.template'),
        person: t('documents.generate.person'),
        docTitle: t('documents.generate.docTitle'),
        preview: t('documents.generate.preview'),
        submit: t('documents.generate.submit'),
        failed: t('documents.generate.failed'),
        noTemplates: t('documents.generate.noTemplates'),
      },
    }
  }

  const drawerOpen = drawer !== null
  const generateOpen = generate !== null
  return {
    title: t('documents.title'),
    description: t('documents.description'),
    tabs,
    viewTabs,
    canManage: authz.canManage,
    addLabel: t('documents.generate.open'),
    addHref: hrefFor(status, null, true),
    tiles,
    segmentsLabel: t('documents.segmentsLabel'),
    allLabel: t('documents.statusAll'),
    // I4-webui-160 suppresses org-wide counts for restricted readers;
    // the status chips follow it: an empty countBy would read 0 beside a
    // non-empty scoped register, so restricted chips carry no count at
    // all rather than a false zero.
    segmentOptions: DOCUMENT_STATUSES.map((value) => ({
      value,
      label: statusLabel(value),
      ...(unrestrictedStats ? { count: countBy.get(value) ?? 0 } : {}),
    })),
    // OM-18/CK-09: the rehomed template/category/schedule sections read
    // their New/edit drawers from namespaced keys (SetupEntitySection via
    // rowParam) — one URL opens exactly one drawer. The register's own
    // segment rides beside the section's list params.
    currentParams: { ...(status ? { status } : {}), ...setupSectionParams(sp, ['template', 'category', 'retention']) },
    columns: {
      title: t('documents.columns.title'),
      person: t('documents.columns.person'),
      category: t('documents.columns.category'),
      sent: t('documents.columns.sent'),
      expires: t('documents.columns.expires'),
      status: t('documents.columns.status'),
    },
    rows,
    empty: t('documents.empty'),
    drawerOpen,
    drawer,
    generateOpen,
    generate,
  }
}
