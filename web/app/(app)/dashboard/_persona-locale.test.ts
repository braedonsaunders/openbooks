import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'
import type { Authz } from '@/lib/authz'

const realPlatformDbUrl = import.meta.resolve('@openbooks/engine/src/platform/db.ts')
const { stubModules } = await import('../../../testing/stub-modules')
stubModules({ features: 'export const isFeatureEnabled = async () => false', extra: { 'server-only': 'export {}' } })
registerHooks({
  resolve(specifier, _context, next) {
    const virtual = (source: string) => ({
      shortCircuit: true,
      url: `data:text/javascript,${encodeURIComponent(source)}`,
    })

    if (specifier === 'drizzle-orm') return virtual('export const sql = () => ({})')
    if (specifier === 'next-intl/server') {
      return virtual(`
        const copy = {
          reviewDue: 'Évaluation à réaliser',
          attentionHrmItems: 'Dossiers RH en attente',
          attentionPayrollSetup: 'La paie nécessite des comptes de contrôle',
          attentionBankLines: 'Lignes bancaires non rapprochées',
          attentionCloseRuns: 'Clôtures ouvertes',
          calendarPayrollRemittance: 'Versement des retenues de paie en attente'
        }
        export async function getTranslations() { return (key) => copy[key] }
        export async function getLocale() { return 'fr' }
      `)
    }
    if (specifier === './_persona-copy') return virtual('export const celebrationDetail = () => ""; export const teamNudgeTexts = () => []')
    if (specifier === '@openbooks/engine/src/platform/db.ts') return virtual(`export * from ${JSON.stringify(realPlatformDbUrl)}; export const db = { execute: async () => ({ rows: [] }) }`)
    if (specifier === '@openbooks/engine/src/platform/business-date.ts') return virtual('export const businessToday = async () => "2026-09-24"')
    if (specifier === '@openbooks/engine/src/inbox/index.ts') return virtual('export const countInbox = async () => 0; export const listInbox = async () => [{id:"item-1"}];')
    if (specifier === '@openbooks/engine/src/inbox/adapters/hrm-qualification-alert.ts') return virtual('export const qualificationSourceAvailable = async () => false')
    if (specifier === '@openbooks/engine/src/hrm/employment-read.ts') return virtual('export const findEmploymentsByParty = async () => []')
    if (specifier === '@openbooks/engine/src/hrm/authorization.ts') return virtual('export const loadApprovalPerson = async () => ({partyId:null}); export const loadTeamEmploymentIdsForManager = async () => []')
    if (specifier === '@openbooks/engine/src/hrm/performance/performance-read.ts') return virtual('export const listMyReviews = async () => ({asReviewer:[],asSubject:[]})')
    if (specifier === '@openbooks/engine/src/hrm/leave-read.ts') return virtual('export const listLeaveTypes = async () => []; export const timeBalanceAsOf = async () => null')
    if (specifier === '@/lib/setup/home-announcements') return virtual('export const liveHomeAnnouncements = async () => []')
    if (specifier === '@/lib/inbox-context') return virtual('export const inboxContext = async () => ({}); export const INBOX_TASK_KINDS = []; export const inboxCounts = async () => { throw new Error("The admin attention metric must not query inbox totals") }')

    return next(specifier)
  },
})

const { loadPersonaMetrics } = await import('./_persona')

test('persona HRM attention labels use the viewer locale', async () => {
  const viewer: Authz = {
    user: {
      orgId: 'org-1', id: 'user-1', email: 'admin@example.test', name: 'Admin',
      roles: [], envKind: 'production', productionOrgId: 'org-1',
      isSuperAdmin: false, homeUserId: 'user-1', homeOrgId: 'org-1',
    },
    permissions: new Set(['admin.setup.manage', 'hrm.employment.read']),
    // Unrestricted scope (null) per the admin-summary gate.
    allowedSubsidiaryIds: null,
  }
  const metrics = await loadPersonaMetrics(viewer, new Set(['adminAttention']))

  assert.deepEqual(metrics.adminAttention, [{
    label: 'Dossiers RH en attente',
    count: 1,
    href: '/inbox?filter=my_tasks',
  }])
})
