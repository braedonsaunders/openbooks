import 'server-only'

import { getTranslations } from 'next-intl/server'
import { listOwnDocuments } from '@openbooks/engine/src/hrm/documents/documents.ts'
import { listOwnExports } from '@openbooks/engine/src/hrm/documents/dsar.ts'
import { meTabs } from './self-service'
import { getAuthz, type Authz } from '../authz'
import { isFeatureEnabled } from '../features'

/**
 * Me documents loader (0230, HR-19): the person's own documents with
 * inline sign/acknowledge plus their subject-access exports with an
 * export-my-data request. Fenced to the actor's own party by the
 * services; HR readers land on /hrm/documents instead. Renders when
 * hrm and hrmDocuments are on and the actor holds hrm.self.read —
 * the loader 404s otherwise. The export request renders only while
 * hrmDataSubjectExport is on.
 */

export interface MeDocumentsAuthz {
  orgId: string
  userId: string
  session: Authz
}

export async function meDocumentsAuthz(): Promise<MeDocumentsAuthz | null> {
  const gate = await getAuthz()
  if (!gate) return null
  if (!(await isFeatureEnabled(gate.user.orgId, 'hrm'))) return null
  if (!(await isFeatureEnabled(gate.user.orgId, 'hrmDocuments'))) return null
  return { orgId: gate.user.orgId, userId: gate.user.id, session: gate }
}

export async function loadMeDocumentsHome(authz: MeDocumentsAuthz, sp: Record<string, string | undefined>) {
  const t = await getTranslations('hrm')
  const tabs = await meTabs(authz.session, '/me/documents')
  const [{ documents, partyId }, { exports }] = await Promise.all([
    listOwnDocuments({ orgId: authz.orgId, actorId: authz.userId }),
    listOwnExports({ orgId: authz.orgId, actorId: authz.userId }),
  ])
  const exportOn = await isFeatureEnabled(authz.orgId, 'hrmDataSubjectExport')
  const statusLabel = (value: string): string =>
    t.has(`meDocuments.status.${value}`) ? t(`meDocuments.status.${value}`) : value
  // The stored scope manifest names each omitted document with its reason;
  // surface that evidence on the requester's row so an incomplete export
  // arrives with its explanation, never as a bare status.
  const incompleteDetail = (scope: unknown): string | null => {
    if (!Array.isArray(scope)) return null
    for (const entry of scope) {
      if (typeof entry !== 'object' || entry === null) continue
      const { module, status, detail } = entry as {
        module?: unknown
        status?: unknown
        detail?: unknown
      }
      if (module === 'documents' && status === 'incomplete' && typeof detail === 'string' && detail.length > 0) {
        return detail
      }
    }
    return null
  }

  return {
    title: t('meDocuments.title'),
    description: t('meDocuments.description'),
    tabs,
    partyId,
    canRequestExport: exportOn && partyId.length > 0,
    columns: {
      title: t('meDocuments.columns.title'),
      status: t('meDocuments.columns.status'),
      sent: t('meDocuments.columns.sent'),
    },
    rows: documents.map((doc) => ({
      id: doc.id,
      title: doc.title,
      status: doc.status,
      statusLabel: statusLabel(doc.status),
      sent: doc.sentAt,
      signable: ['sent', 'viewed', 'partially_signed'].includes(doc.status),
      acknowledgeable: doc.status !== 'acknowledged' && doc.status !== 'signed',
    })),
    empty: t('meDocuments.empty'),
    signNameLabel: t('meDocuments.signName'),
    signLabel: t('meDocuments.sign'),
    acknowledgeLabel: t('meDocuments.acknowledge'),
    actionFailed: t('meDocuments.actionFailed'),
    exportsTitle: t('meDocuments.exportsTitle'),
    exportsEmpty: t('meDocuments.exportsEmpty'),
    exportColumns: {
      requested: t('meDocuments.exportsColumns.requested'),
      status: t('meDocuments.exportsColumns.status'),
      detail: t('meDocuments.exportsColumns.detail'),
    },
    exportRows: exports.map((e) => ({
      id: e.id,
      requested: e.requestedAt,
      status: e.status,
      statusLabel: statusLabel(e.status),
      // Incomplete exports are downloadable too — the partial zip is the
      // requester's, and the row keeps showing its incomplete status.
      downloadable: e.status === 'ready' || e.status === 'incomplete' || e.status === 'delivered',
      downloadHref: `/api/hrm/data-subject-exports/${e.id}/download`,
      incompleteDetail: incompleteDetail(e.scope),
      error: e.error,
    })),
    requestExportLabel: t('meDocuments.requestExport'),
    requestExportDone: t('meDocuments.requestExportDone'),
    downloadLabel: t('meDocuments.download'),
    exportOpen: sp.export === '1' && exportOn && partyId.length > 0,
  }
}
