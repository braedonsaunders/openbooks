import assert from "node:assert/strict";
import hrmCatalog from "../../../../messages/en/hrm.json";
import type { PortfolioCatalog } from "../../../../lib/hrm/benefits-workspace";
import { stubModules } from "../../../../testing/stub-modules";
import test, { beforeEach, afterEach } from "node:test";
import { createTranslator } from "next-intl";

// Behaviour contract for the benefits desk (/hrm/benefits). These tests
// CALL the benefits loader with hand-built service rows and assert on
// what the page observes: refusal data for an unknown segment, exact
// per-status counts on the windows view, and the enrolments view swap
// (a different entity, not a status). Seams stub I/O only (group and
// rewards tabs, the engine benefits reads, the departments lookup,
// translations backed by the REAL en catalog). Authz stubbing is the
// sanctioned seam, with permission logic proven by the existing scope DB
// tests, not doubled here.
const translate = createTranslator({ locale: 'en', messages: hrmCatalog, onError: error => { throw error } });
const portfolioCatalog: PortfolioCatalog = Object.assign(
  (key: string, params?: Record<string, string | number>) => translate(key as Parameters<typeof translate>[0], params),
  { has: (key: string) => translate.has(key as Parameters<typeof translate.has>[0]) },
);
(globalThis as Record<string, unknown>).__benefitsTranslations = portfolioCatalog;

const authzSource = `export const can = (authz, perm) => authz.permissions.has('*') || authz.permissions.has(perm);
             export async function requirePermission() { throw new Error('stubbed requirePermission must not run here'); }
             export async function getAuthz() { return null; }`
const featuresSource = `export async function isFeatureEnabled() { return true; }
             export async function requireFeatureEnabled() {}
             export async function subsidiaryFeatureEnabled() { return false; }`
const databaseSource = "export const db = { execute: async () => ({ rows: [] }) }; export async function withBypass(work) { return work() } export async function withBypassContext(work) { return work() } export function ambientTenantOrgId() { return null } let resolver = null; export function currentRequestOrgResolver() { return resolver } export function registerRequestOrgResolver(fn) { resolver = fn } export async function withOrgContext(_orgId, work) { return work() } export async function withOrgTransaction(_orgId, work) { return work() }"
stubModules({
  intl: `export async function getLocale() { return 'en'; }
        export async function getTranslations() { return globalThis.__benefitsTranslations; }`,
  authz: authzSource,
  features: featuresSource,
  extra: {
    'server-only': "export {}",
    '../authz': authzSource,
    '../features': featuresSource,
    './features': featuresSource,
    '../../components/module-home/group-tabs': "export async function hrmGroupTabs() { return []; }",
    '../money-server': `export const getMoneyFormatter = async () => ({ money: (value, opts) => value + ' ' + (opts && opts.currency ? opts.currency : '') });`,
    '@openbooks/engine/hrm/benefits': `
        export async function listBenefitApprovalPolicies() { return { configured: false, href: '/admin/flows', policies: [] } }
        export async function listBenefitPrograms() { const s = globalThis.__portfolioReads; if (s?.programsError) throw new Error(s.programsError); return { programs: s?.programs ?? [] } }
        export async function listBenefitAwards() { const s = globalThis.__portfolioReads; if (s?.awardsError) throw new Error(s.awardsError); return { awards: s?.awards ?? [] } }
        export async function listProgramMemberships() { return [] }
        export async function listProgramSources() { const s = globalThis.__portfolioReads; if (s?.sourcesError) throw new Error(s.sourcesError); return s?.sources ?? [] }
        export async function previewIncentiveSettlement() { throw new Error('Simulation was not requested') }
      `,
    './benefits-reports': 'export async function loadBenefitsReportLinks() { return [] }',
    '@openbooks/engine/src/platform/business-date.ts': "export async function businessToday() { return '2026-09-22'; } export function utcDateFromParts() { throw new Error('unstubbed'); }",
    '@openbooks/engine/src/hrm/benefits/benefits-read.ts': `export async function listEnrollmentWindows(db, orgId, actorId, filter) {
              const s = globalThis.__benefitsReads;
              const windows = (s && s.windows) || [];
              if (filter && filter.status) return windows.filter((w) => w.status === filter.status);
              return windows;
            }
            export async function listBenefitPlans() { return (globalThis.__benefitsReads?.catalogPlans) || []; }
            export async function listEnrollmentPlanOptions() { return (globalThis.__benefitsReads?.plans) || []; }
            export async function listEnrollments() {
              const s = globalThis.__benefitsReads;
              return (s && s.enrolments) || [];
            }
            export async function benefitsCockpit() {
              return { openWindows: [], pendingCount: 0, missingCount: 0 };
            }`,
    '@openbooks/engine/src/platform/db.ts': databaseSource,
    '@openbooks/engine/platform/database': databaseSource,
  },
})

const { loadBenefits } = await import("../../../../lib/hrm/benefits.ts");

const gap = globalThis as Record<string, unknown>;
beforeEach(() => {
  stubReads([], [])
  gap.__portfolioReads = undefined
})
afterEach(() => {
  gap.__portfolioReads = undefined
  stubReads([], [])
})

function authzWith(permissions: string[]) {
  return {
    user: { orgId: "org-benefits", id: "actor-benefits" },
    permissions: new Set(permissions),
    allowedSubsidiaryIds: null,
  } as never;
}

const HR_BENEFITS = authzWith(["hrm.benefits.read", "hrm.benefits.manage"]);

function stubReads(windows: Array<Record<string, unknown>>, enrolments: Array<Record<string, unknown>>) {
  gap.__benefitsReads = { windows, enrolments };
}

function windowRow(id: string, status: string): Record<string, unknown> {
  return { id, kind: "annual", status, opensOn: "2026-11-01", closesOn: "2026-11-30" };
}

function enrolmentRow(id: string, windowId: string): Record<string, unknown> {
  return { id, windowId, employmentId: "emp-1", employeeName: "Ada", status: "elected" };
}

test("an unknown segment refuses naming the segment, never an empty table", async () => {
  const data = await loadBenefits(HR_BENEFITS, { segment: "enrolments" });
  assert.ok(data.refusal, "the refusal travels as data the page renders");
  assert.ok(data.refusal.message.includes("enrolments"), "the refusal names the rejected value");
  assert.equal(data.hasContent, false, "no rows render beside the refusal");
  assert.equal(data.showingEnrolments, false, "a refused segment shows neither view");
});

for (const [name, segment, expectedIds] of [
  ['the windows view binds rows with exact per-status counts', undefined, ['w-open', 'w-draft', 'w-closed']],
  ['status segment counts describe all visible windows while rows stay filtered', 'open', ['w-open']],
] as const) {
  test(name, async () => {
    stubReads(['open', 'draft', 'closed'].map((status) => windowRow(`w-${status}`, status)), [enrolmentRow('e-1', 'w-open')])
    const data = await loadBenefits(HR_BENEFITS, segment ? { segment } : {})
    assert.equal(data.refusal, null, 'a valid status carries no refusal')
    assert.equal(data.showingEnrolments, false, 'status filters retain the window entity')
    assert.deepEqual(data.segments.map((item) => [item.value, item.count]), [['all', 3], ['open', 1], ['draft', 1], ['closed', 1]], 'counts describe all visible windows and exclude enrolments')
    assert.deepEqual(data.windowRows.map((window) => window.id), expectedIds)
    assert.equal(data.windowRows.length, expectedIds.length, 'every matching window lists')
    assert.equal(data.windowRows[0]!.rangeLabel, '2026-11-01 – 2026-11-30', 'the range renders verbatim')
    assert.ok(data.windowRows[0]!.windowHref.includes('window=w-open'), 'each window opens its own drawer')
  })
}

test("the enrolments view swaps the table for the other entity", async () => {
  stubReads([windowRow("w-open", "open")], [enrolmentRow("e-1", "w-open")]);
  const data = await loadBenefits(HR_BENEFITS, { view: "enrolments" });
  assert.equal(data.refusal, null, "the enrolments view carries no refusal");
  assert.equal(data.showingEnrolments, true, "the view flag swaps the table");
  assert.equal(data.enrollmentRows.length, 1, "enrolments list on their own view");
  assert.equal(data.enrollmentRows[0]!.employeeLabel, "Ada", "rows resolve the employee name");
  assert.ok(data.newWindowHref.includes("view=enrolments"), "dialogs opened from the view close back onto it");
});

test("the benefits copy ships with translated statuses in every section", () => {
  for (const key of ['title', 'windowsTitle', 'enrolmentsTitle', 'segments.open', 'segments.draft', 'segments.closed']) {
    assert.ok(portfolioCatalog(`benefits.${key}`).length > 0, `${key} resolves from the catalog`)
    assert.notEqual(portfolioCatalog(`benefits.${key}`), `benefits.${key}`, `${key} is translated`)
  }
});

const { loadBenefitsPortfolio } = await import('../../../../lib/hrm/benefits-workspace.ts')
test('loaded portfolio keeps all rows searchable beyond 500 and totals exact values', async () => {
  gap.__portfolioReads = { programs: [], awards: Array.from({ length: 501 }, (_, index) => ({
    id: `award-${index}`, programId: 'program', employmentId: 'employment', value: '0.01', currency: 'USD', status: 'approved',
  })) }
  const data = await loadBenefitsPortfolio(HR_BENEFITS, {}, { openCount: 0, pendingEnrollments: 0 }, portfolioCatalog)
  assert.equal(data.awards.length, 501)
  assert.equal(data.awardsTotal, 501)
  assert.equal(data.awardsTruncated, false)
  assert.equal(data.vitals.awaitingByCurrency[0]?.amount, '5.0100')
  assert.equal(data.canQueue, false, 'HR manage cannot release finance payouts')
})

test('refused source read travels into the edit refusal and never implies a cleared set', async () => {
  gap.__portfolioReads = { programs: [], awards: [], sourcesError: 'Select an account in this legal entity before editing.' }
  const data = await loadBenefitsPortfolio(HR_BENEFITS, { program: 'program', edit: '1' }, { openCount: 0, pendingEnrollments: 0 }, portfolioCatalog)
  assert.equal(data.editSourcesRefusal?.message, 'Select an account in this legal entity before editing.')
  assert.equal(data.optionsRefusal?.message, data.editSourcesRefusal?.message)
})

const { benefitsSpec } = await import('./view.ts')
test('each focused Benefits page has one list and a create action matching its purpose', async () => {
  for (const [view, label, list] of [
    ['programs', 'newProgramButton', 'hrm-program-table'],
    ['enrolments', 'newEnrollmentButton', 'hrm_benefits_enrolments'],
    ['rewards', 'newAwardButton', 'hrm-award-table'],
    ['incentives', 'newProgramButton', 'hrm-program-table'],
  ] as const) {
    const data = await loadBenefits(HR_BENEFITS, { view })
    const spec = benefitsSpec(data)
    const header = spec.header?.find((block) => block.kind === 'page-header')
    assert.ok(header)
    const creates = header.actions?.filter((action) => action.widget === 'link-button' && action.props?.iconKey === 'plus') ?? []
    assert.equal(creates.length, 1, view)
    assert.ok(JSON.stringify(creates[0]).includes(label))
    const body = JSON.stringify(spec.body)
    assert.ok(body.includes(list))
    if (view === 'incentives') {
      assert.ok(!body.includes('hrm-award-table'))
      assert.equal(data.newProgramButton, 'New incentive')
      assert.equal(data.programBuilderFamily, 'incentive')
      assert.equal(data.programBuilderLocked, true)
    }
    if (view === 'rewards') assert.equal(data.newAwardButton, 'New reward')
  }
  const payouts = benefitsSpec(await loadBenefits(HR_BENEFITS, { view: 'payouts' }))
  const header = payouts.header?.find((block) => block.kind === 'page-header')
  assert.ok(header)
  assert.equal(header.actions?.filter((action) => action.widget === 'link-button').length, 0, 'payouts deliver existing approved grants')
})

test('a refused award read shows unknown vitals and omits zero-shaped currency totals', async () => {
  gap.__portfolioReads = { awardsError: 'Ask finance to restore access before reviewing payouts.' }
  const data = await loadBenefits(HR_BENEFITS, {})
  assert.equal(data.awardsRefusal?.message, 'Ask finance to restore access before reviewing payouts.')
  assert.equal(data.tiles.pendingApprovals, '—')
  assert.equal(data.tiles.queuedPayouts, '—')
  const spec = JSON.stringify(benefitsSpec(data))
  assert.ok(!spec.includes('deliveredRows'), 'a failed read cannot render a no-awards currency table')
})

test('Benefits overview uses the native cockpit hero and rail without enrollment tables or creation cards', async () => {
  const data = await loadBenefits(HR_BENEFITS, {})
  const spec = benefitsSpec(data)
  const body = spec.body.find((block) => block.kind === 'grid')
  assert.ok(body?.kind === 'grid')
  const cockpit = body.blocks.find((block) => block.kind === 'grid' && block.className?.includes('lg:grid-cols-3'))
  assert.ok(cockpit?.kind === 'grid')
  const hero = cockpit.blocks[0]
  assert.ok(hero?.kind === 'panel')
  assert.match(hero.className ?? '', /lg:col-span-2/)
  assert.ok(hero.blocks.some((block) => block.kind === 'widget' && block.widget === 'hrm-program-table'))
  const rail = cockpit.blocks[1]
  assert.ok(rail?.kind === 'grid')
  assert.match(rail.className ?? '', /overflow-y-auto/)
  const serialized = JSON.stringify(spec)
  assert.ok(serialized.includes('attention-list'))
  assert.ok(serialized.includes('directory-section'))
  assert.ok(!serialized.includes('hrm_benefits_windows'))
  assert.ok(!serialized.includes('hrm_benefits_enrolments'))
  assert.ok(!data.programTypePickerOpen, 'type picker is closed on overview')
  assert.ok(!serialized.includes('hrm-facts'), 'empty award balances do not create empty money panels')
})

test('Benefits overview preserves exact currency lines in native populated summaries', async () => {
  gap.__portfolioReads = { programs: [], awards: [
    { id: 'usd', programId: 'program', employmentId: 'emp', status: 'approved', value: '25.00', currency: 'USD', periodFrom: '2026-01-01', createdAt: '2026-01-01T00:00:00Z', programCode: 'BONUS', programName: 'Bonus', programFamily: 'reward' },
    { id: 'jpy', programId: 'program', employmentId: 'emp', status: 'approved', value: '1000', currency: 'JPY', periodFrom: '2026-01-01', createdAt: '2026-01-01T00:00:00Z', programCode: 'BONUS', programName: 'Bonus', programFamily: 'reward' },
  ] }
  const data = await loadBenefits(HR_BENEFITS, {})
  const serialized = JSON.stringify(benefitsSpec(data))
  assert.ok(serialized.includes('hrm-facts'))
  for (const row of data.awaitingRows) {
    assert.ok(serialized.includes(JSON.stringify({ label: row.currency, value: row.display })))
  }
  assert.deepEqual(data.awaitingRows.map((row) => [row.currency, row.amount]), [['JPY', '1000.0000'], ['USD', '25.0000']])
})

test('Enrollment windows are a header action and drawer, never a second page or body button', async () => {
  const data = await loadBenefits(HR_BENEFITS, { view: 'enrolments' })
  const spec = benefitsSpec(data)
  const header = spec.header?.find((block) => block.kind === 'page-header')
  assert.ok(header)
  assert.ok(JSON.stringify(header.actions).includes('enrollmentWindowsHref'))
  assert.ok(!JSON.stringify(spec.body).includes('enrollmentWindowsButton'))
  assert.equal(data.enrollmentWindowsHref, '/hrm/benefits?view=enrolments&windows=1')
  const manager = await loadBenefits(HR_BENEFITS, { view: 'enrolments', windows: '1' })
  assert.equal(manager.windowsManagerOpen, true)
  const legacy = await loadBenefits(HR_BENEFITS, { view: 'windows' })
  assert.equal(legacy.portfolioView, 'enrolments')
  assert.equal(legacy.windowsManagerOpen, true)
})

test('New enrollment binds the native controlled election form to the HR filing API', async () => {
  stubReads([windowRow('open', 'open'), windowRow('draft', 'draft')], [])
  const data = await loadBenefits(HR_BENEFITS, { view: 'enrolments', enrollment: 'new' })
  assert.equal(data.enrollmentDialog?.title, 'New enrollment')
  assert.deepEqual(data.enrollmentDialog?.windows.map((window) => window.value), ['open'])
  const serialized = JSON.stringify(benefitsSpec(data))
  assert.ok(serialized.includes('"mode":"manage"'))
  const readonly = await loadBenefits(authzWith(['hrm.benefits.read']), { view: 'enrolments', enrollment: 'new' })
  assert.equal(readonly.enrollmentDialog, null)
})


test('Programs combines insured plans and employer programs in one filterable population', async () => {
  gap.__benefitsReads = { windows: [], enrolments: [], catalogPlans: [
    { id: 'health', code: 'HEALTH', name: 'Health coverage', kind: 'health', currency: 'USD', isActive: true, effectiveFrom: '2026-01-01', effectiveTo: null },
    { id: 'retired', code: 'OLD', name: 'Retired plan', kind: 'dental', currency: 'USD', isActive: false, effectiveFrom: '2025-01-01', effectiveTo: '2025-12-31' },
  ] }
  gap.__portfolioReads = { programs: [{ id: 'reward', code: 'RECOG', name: 'Recognition', family: 'reward', currency: 'USD', status: 'active', valuation: 'fixed', fixedAmount: '25.0000', effectiveFrom: '2026-01-01', effectiveTo: null }], awards: [] }
  const data = await loadBenefits(HR_BENEFITS, { view: 'programs' })
  assert.deepEqual(data.unifiedProgramRows.map((row) => row.id), ['plan:health', 'reward', 'plan:retired'])
  assert.equal(data.unifiedProgramRows[2]?.statusLabel, 'Closed')
  assert.equal(data.unifiedProgramRows[0]?.programHref, '/hrm/benefits?view=programs&plan=health')
  const filtered = await loadBenefits(HR_BENEFITS, { view: 'programs', type: 'insured' })
  assert.equal(filtered.unifiedProgramRows.length, 2)
  assert.equal(filtered.programTypeFilter.currentParams.type, 'insured')
  const body = JSON.stringify(benefitsSpec(data).body)
  assert.equal((body.match(/"widget":"hrm-program-table"/g) ?? []).length, 1)
  assert.ok(body.includes('typeFilter'))
  assert.ok(!body.includes('setup-entity-section'))
  const unknown = await loadBenefits(HR_BENEFITS, { view: 'programs', type: 'typo' })
  assert.match(unknown.programsRefusal?.message ?? '', /typo.*filter/)
})

test('New program chooses a native Benefits type before creating a record', async () => {
  const data = await loadBenefits(HR_BENEFITS, { view: 'programs', program: 'new' })
  assert.equal(data.programTypePickerOpen, true)
  assert.equal(data.programBuilderOpen, false)
  for (const card of data.overview.cards) assert.ok(card.href.startsWith('/hrm/benefits?'))
  const health = data.overview.cards.find((card) => card.key === 'health')!
  assert.equal(health.href, '/hrm/benefits?view=programs&plan=new&kind=health')
  const reward = await loadBenefits(HR_BENEFITS, { view: 'programs', program: 'new', family: 'reward' })
  assert.equal(reward.programTypePickerOpen, false)
  assert.equal(reward.programBuilderOpen, true)
  assert.equal(reward.programBuilderFamily, 'reward')
})

test('cash payroll processing labels do not claim bank payment', async () => {
  gap.__portfolioReads = { programs: [{ id: 'program', code: 'BONUS', name: 'Bonus', family: 'reward', currency: 'USD', status: 'active', deliveryMethod: 'payroll', valuation: 'fixed', fixedAmount: '25.00' }], awards: [{ id: 'reward', programId: 'program', employmentId: 'employment', value: '25.00', currency: 'USD', status: 'delivered' }] }
  const data = await loadBenefits(HR_BENEFITS, { view: 'payouts' })
  assert.equal(data.awardRows[0]?.statusLabel, 'Processed in payroll')
})


test('external payout progress comes only from verified native payroll consumption', async () => {
  const program = { id: 'external-program', code: 'GIFTS', name: 'Gift cards', family: 'reward', currency: 'USD', status: 'active', deliveryMethod: 'external', valuation: 'fixed', fixedAmount: '25.00' }
  const award = { id: 'gift', programId: program.id, employmentId: 'employment', value: '25.00', currency: 'USD', status: 'queued' }
  for (const [payrollProcessed, expected] of [[false, 'Queued on a pay run'], [true, 'Processed in payroll · awaiting fulfillment']] as const) {
    gap.__portfolioReads = { programs: [program], awards: [{ ...award, payrollProcessed }] }
    const data = await loadBenefits(HR_BENEFITS, { view: 'payouts' })
    assert.equal(data.awardRows[0]?.statusLabel, expected)
  }
})

test('approval policy editing authority follows the native Flows grant rather than HR management', async () => {
  const hr = await loadBenefits(HR_BENEFITS, { view: 'programs', program: 'new', family: 'reward' })
  assert.equal(hr.canConfigureApprovalPolicies, false)
  const workflowManager = await loadBenefits(authzWith(['hrm.benefits.read', 'hrm.benefits.manage', 'flows.manage']), { view: 'programs', program: 'new', family: 'reward' })
  assert.equal(workflowManager.canConfigureApprovalPolicies, true)
  assert.ok(JSON.stringify(benefitsSpec(workflowManager)).includes('canConfigureApprovalPolicies'))
})

test('Payouts contains only released delivery obligations and recorded payroll history', async () => {
  const program = { id: 'program', code: 'THANKS', name: 'Recognition', family: 'reward', currency: 'USD', status: 'active', deliveryMethod: 'payroll', approvalMode: 'none', valuation: 'fixed', fixedAmount: '25.00' }
  const statuses = ['draft', 'pending', 'approved', 'queued', 'delivered', 'rejected', 'voided']
  const awards = statuses.map((status) => ({ id: status, programId: program.id, employmentId: 'employment', value: '25.00', currency: 'USD', status, payRunDocumentId: null, payRunAdjustmentId: null }))
  awards.push({ ...awards[6]!, id: 'recorded-void', payRunDocumentId: 'run', payRunAdjustmentId: 'adjustment' } as never)
  gap.__portfolioReads = { programs: [program], awards }
  const payouts = await loadBenefits(HR_BENEFITS, { view: 'payouts' })
  assert.deepEqual(payouts.payoutAwardRows.map((award) => award.id), ['approved', 'queued', 'delivered', 'recorded-void'])
  const spec = JSON.stringify(benefitsSpec(payouts))
  assert.ok(!spec.includes('"label":"New award"'))
  assert.ok(!spec.includes('"label":"New reward"'))
  assert.ok(!spec.includes('"id":"draft"'))
  const rewards = await loadBenefits(HR_BENEFITS, { view: 'rewards' })
  assert.ok(['draft', 'pending', 'rejected'].every((id) => rewards.rewardAwardRows.some((row) => row.id === id)))
  assert.equal(payouts.overview.attention.find((item) => item.key === 'pending-awards')?.href, '/approvals')
})
