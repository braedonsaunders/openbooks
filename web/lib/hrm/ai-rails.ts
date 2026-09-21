import 'server-only'

import { sql } from 'drizzle-orm'
import { getTranslations } from 'next-intl/server'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { listFlags, type FlagRow } from '@openbooks/engine/src/hrm/ai/anomalies.ts'
import { explainPayslip, type ExplainPayTrace } from '@openbooks/engine/src/hrm/ai/explain-pay.ts'
import { listCapabilities, listDecisions, overdueReviews, type CapabilityRow, type DecisionRow } from '@openbooks/engine/src/hrm/ai/governance.ts'
import { loadAiRailsSettings } from '@openbooks/engine/src/hrm/ai/settings.ts'
import { actorPartyOf } from '@openbooks/engine/src/hrm/self-service/actor.ts'
import type { Authz } from '../authz'
import { isFeatureEnabled } from '../features'
import { groupTabs } from '../../components/module-home/group-tabs'

/**
 * HR-21 AI rails web loaders. Pages stay thin: every loader resolves
 * display cells through the deterministic services (never prose), caps
 * lists, and returns refusals as data the spec renders intact.
 */

export interface AnomalyFlagDisplay {
  id: string;
  severityLabel: string;
  severityVariant: string;
  kindLabel: string;
  periodLabel: string;
  employmentLabel: string;
  explanation: string;
  statusLabel: string;
  statusVariant: string;
  openLabel: string;
  flagHref: string;
  detail: unknown;
  reason: string | null;
  runDocumentId: string | null;
}

export interface AnomalyChecksData {
  tabs: Awaited<ReturnType<typeof groupTabs>>;
  title: string;
  description: string;
  runsLabel: string;
  listTitle: string;
  emptyTitle: string;
  emptyDescription: string;
  allLabel: string;
  severityLabel: string;
  kindLabel: string;
  statusLabel: string;
  openLabel: string;
  scanLabel: string;
  scanBusyLabel: string;
  scanFailedLabel: string;
  columns: {
    severity: string;
    kind: string;
    period: string;
    employment: string;
    explanation: string;
    status: string;
  };
  tiles: { blocking: string; warnings: string; acknowledged: string; falsePositiveRate: string };
  blockingTone: string;
  warningsTone: string;
  currentParams: Record<string, string>;
  severityOptions: { value: string; label: string }[];
  kindOptions: { value: string; label: string }[];
  statusOptions: { value: string; label: string }[];
  stats: { blocking: number; warnings: number; acknowledged: number; falsePositiveRate: string };
  rows: AnomalyFlagDisplay[];
  truncated: boolean;
  dialogFlag: (AnomalyFlagDisplay & { transitionLabels: { acknowledge: string; resolve: string; falsePositive: string; reasonLabel: string; reasonPlaceholder: string; submitLabel: string; failedLabel: string } }) | null;
  dialogCloseHref: string;
  dialogOpen: boolean;
  canScan: boolean;
  finalizeHref: string;
}

const KIND_LABELS: Record<string, string> = {
  terminated_with_pay: 'Terminated with pay',
  duplicate_bank: 'Duplicate bank details',
  retro_spike: 'Retro spike',
  net_pay_spike: 'Net pay spike',
  zero_hours_with_pay: 'Zero hours with pay',
  hours_spike: 'Hours spike',
  missing_rate: 'Missing rate',
  expired_rate: 'Expired rate',
  prevailing_wage_missing: 'Prevailing wage missing',
  apprentice_ratio_breach: 'Apprentice ratio breach',
  benefit_input_orphan: 'Benefit input orphan',
  leave_input_orphan: 'Leave input orphan',
  negative_balance: 'Negative leave balance',
  duplicate_entry: 'Duplicate time entry',
  geofence_outside: 'Outside geofence',
  unrounded: 'Unrounded clock event',
  custom: 'Custom',
};

export function anomalyKindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind;
}

async function employmentLabels(
  orgId: string,
  employmentIds: readonly (string | null)[],
): Promise<Map<string, string>> {
  const ids = [...new Set(employmentIds.filter((id): id is string => id !== null))];
  const labels = new Map<string, string>();
  if (ids.length === 0) return labels;
  const rows = (await db.execute<{ id: string; label: string }>(sql`
    select e.id::text as id, p.display_name as label
      from worker_employments e
      join parties p on p.org_id = e.org_id and p.id = e.worker_party_id
     where e.org_id = ${orgId} and e.id = any(${ids}::uuid[])`)).rows;
  for (const row of rows) labels.set(row.id, row.label);
  return labels;
}

const SEVERITY_VARIANTS: Record<string, string> = { block: 'danger', warn: 'warning', info: 'neutral' };
const STATUS_VARIANTS: Record<string, string> = {
  open: 'danger',
  acknowledged: 'warning',
  resolved: 'success',
  false_positive: 'neutral',
};

function toDisplay(
  t: (key: string) => string,
  flag: FlagRow,
  employmentLabel: string | null,
  currentParams: Record<string, string>,
): AnomalyFlagDisplay {
  return {
    id: flag.id,
    severityLabel: t(`anomalies.severity.${flag.severity}`),
    severityVariant: SEVERITY_VARIANTS[flag.severity] ?? 'neutral',
    kindLabel: anomalyKindLabel(flag.kind),
    periodLabel: `${flag.payPeriodFrom} → ${flag.payPeriodTo}`,
    employmentLabel: employmentLabel ?? t('anomalies.unassigned'),
    explanation: flag.explanation,
    statusLabel: t(`anomalies.status.${flag.status}`),
    statusVariant: STATUS_VARIANTS[flag.status] ?? 'neutral',
    openLabel: t('anomalies.open'),
    flagHref: `/payroll/anomalies?${new URLSearchParams({ ...currentParams, flag: flag.id }).toString()}`,
    detail: flag.detail,
    reason: flag.reason,
    runDocumentId: (flag.detail as { runDocumentId?: string } | null)?.runDocumentId ?? null,
  };
}

/** Payroll anomaly checks queue with stat tiles, filters and a flag drawer. */
export async function loadAnomalyChecks(
  authz: Authz,
  sp: Record<string, string | undefined>,
): Promise<AnomalyChecksData> {
  const orgId = authz.user.orgId;
  const actorId = authz.user.id;
  const t = await getTranslations('payroll');
  const severity = sp.severity === 'info' || sp.severity === 'warn' || sp.severity === 'block' ? sp.severity : undefined;
  const status = sp.status === 'acknowledged' || sp.status === 'resolved' || sp.status === 'false_positive' ? sp.status : 'open';
  const kind = sp.kind && KIND_LABELS[sp.kind] ? sp.kind : undefined;
  const [open, acknowledged, falsePositives] = await Promise.all([
    listFlags(db, { orgId, actorId, severity, kind, status: 'open' }),
    listFlags(db, { orgId, actorId, status: 'acknowledged' }),
    listFlags(db, { orgId, actorId, status: 'false_positive' }),
  ]);
  const flags = status === 'open' ? open : status === 'acknowledged' ? acknowledged : await listFlags(db, { orgId, actorId, severity, kind, status });
  const resolved = await listFlags(db, { orgId, actorId, status: 'resolved' });
  const closedTotal = resolved.length + falsePositives.length;
  const fpRate = closedTotal === 0 ? '—' : `${Math.round((falsePositives.length / closedTotal) * 100)}%`;
  const currentParams: Record<string, string> = {};
  for (const key of ['severity', 'kind', 'status']) {
    if (sp[key]) currentParams[key] = sp[key]!;
  }
  const labels = await employmentLabels(orgId, flags.map((f) => f.employmentId));
  const cap = 100;
  const rows: AnomalyFlagDisplay[] = flags.slice(0, cap).map((f) =>
    toDisplay(t, f, (f.employmentId && labels.get(f.employmentId)) || null, currentParams),
  );
  let dialogFlag: AnomalyChecksData['dialogFlag'] = null;
  if (sp.flag) {
    const found = flags.find((f) => f.id === sp.flag) ?? null;
    if (found) {
      dialogFlag = {
        ...toDisplay(t, found, (found.employmentId && labels.get(found.employmentId)) || null, currentParams),
        transitionLabels: {
          acknowledge: t('anomalies.transitions.acknowledge'),
          resolve: t('anomalies.transitions.resolve'),
          falsePositive: t('anomalies.transitions.falsePositive'),
          reasonLabel: t('anomalies.transitions.reason'),
          reasonPlaceholder: t('anomalies.transitions.reasonPlaceholder'),
          submitLabel: t('anomalies.transitions.submit'),
          failedLabel: t('anomalies.transitions.failed'),
        },
      };
    }
  }
  const blocking = open.filter((f) => f.severity === 'block').length;
  const warnings = open.filter((f) => f.severity === 'warn').length;
  return {
    tabs: await groupTabs('payroll', '/payroll/anomalies', { orgId }),
    title: t('anomalies.title'),
    description: t('anomalies.description'),
    runsLabel: t('anomalies.runs'),
    listTitle: t('anomalies.listTitle'),
    emptyTitle: t('anomalies.emptyTitle'),
    emptyDescription: t('anomalies.emptyDescription'),
    allLabel: t('anomalies.all'),
    severityLabel: t('anomalies.severityLabel'),
    kindLabel: t('anomalies.kindLabel'),
    statusLabel: t('anomalies.statusLabel'),
    openLabel: t('anomalies.open'),
    scanLabel: t('anomalies.scan'),
    scanBusyLabel: t('anomalies.scanBusy'),
    scanFailedLabel: t('anomalies.scanFailed'),
    columns: {
      severity: t('anomalies.columns.severity'),
      kind: t('anomalies.columns.kind'),
      period: t('anomalies.columns.period'),
      employment: t('anomalies.columns.employment'),
      explanation: t('anomalies.columns.explanation'),
      status: t('anomalies.columns.status'),
    },
    tiles: {
      blocking: t('anomalies.tiles.blocking'),
      warnings: t('anomalies.tiles.warnings'),
      acknowledged: t('anomalies.tiles.acknowledged'),
      falsePositiveRate: t('anomalies.tiles.falsePositiveRate'),
    },
    blockingTone: blocking > 0 ? 'danger' : 'neutral',
    warningsTone: warnings > 0 ? 'warning' : 'neutral',
    currentParams,
    severityOptions: ['block', 'warn', 'info'].map((value) => ({ value, label: t(`anomalies.severity.${value}`) })),
    kindOptions: Object.entries(KIND_LABELS).map(([value, label]) => ({ value, label })),
    statusOptions: ['open', 'acknowledged', 'resolved', 'false_positive'].map((value) => ({ value, label: t(`anomalies.status.${value}`) })),
    stats: { blocking, warnings, acknowledged: acknowledged.length, falsePositiveRate: fpRate },
    rows,
    truncated: flags.length > cap,
    dialogFlag,
    dialogCloseHref: '/payroll/anomalies',
    dialogOpen: dialogFlag !== null,
    canScan: authz.permissions.has('payroll.manage'),
    finalizeHref: '/payroll/runs',
  };
}

export interface OwnStubRow {
  id: string;
  payDate: string;
  gross: string;
  netPay: string;
}

/** The actor's own calculated stubs, newest first. */
export async function loadOwnStubs(authz: Authz): Promise<OwnStubRow[]> {
  const partyId = await actorPartyOf(db, authz.user.orgId, authz.user.id);
  if (!partyId) return [];
  const rows = (await db.execute<{ id: string; payDate: string; gross: string; netPay: string }>(sql`
    select id::text as id, pay_date::text as "payDate",
           gross::text as gross, net_pay::text as "netPay"
      from pay_stubs
     where org_id = ${authz.user.orgId} and employee_party_id = ${partyId}
     order by pay_date desc, id desc
     limit 6`)).rows;
  return rows.map((row) => ({ id: row.id, payDate: row.payDate, gross: row.gross, netPay: row.netPay }));
}

export interface MePaySection {
  hasPay: boolean;
  payTitle: string;
  payStubs: { id: string; payDate: string; gross: string; netPay: string; explainLabel: string; explainHref: string }[];
  payColumns: { payDate: string; gross: string; netPay: string };
  payEmpty: string;
  payExplain: {
    stubId: string;
    closeHref: string;
    title: string;
    missing: string | null;
    grossLabel: string;
    netLabel: string;
    employerCostLabel: string;
    earningsTitle: string;
    deductionsTitle: string;
    contributionsTitle: string;
    inputsTitle: string;
    diffTitle: string;
    sourcesTitle: string;
    trace: ExplainPayTrace | null;
  } | null;
}

/** Own payslips with the Explain drawer payload for the Me page. */
export async function loadMePaySection(
  authz: Authz,
  explainStubId: string | undefined,
): Promise<MePaySection> {
  const t = await getTranslations('hrm');
  const hasPay = await isFeatureEnabled(authz.user.orgId, 'payroll');
  if (!hasPay) {
    return {
      hasPay: false,
      payTitle: '',
      payStubs: [],
      payColumns: { payDate: '', gross: '', netPay: '' },
      payEmpty: '',
      payExplain: null,
    };
  }
  const stubs = await loadOwnStubs(authz);
  let payExplain: MePaySection['payExplain'] = null;
  if (explainStubId) {
    const found = stubs.find((s) => s.id === explainStubId) ?? null;
    if (!found) {
      payExplain = {
        stubId: explainStubId,
        closeHref: '/me',
        title: t('me.pay.explainTitle'),
        missing: t('me.pay.explainMissing'),
        grossLabel: t('me.pay.gross'),
        netLabel: t('me.pay.net'),
        employerCostLabel: t('me.pay.employerCost'),
        earningsTitle: t('me.pay.earnings'),
        deductionsTitle: t('me.pay.deductions'),
        contributionsTitle: t('me.pay.contributions'),
        inputsTitle: t('me.pay.inputs'),
        diffTitle: t('me.pay.diff'),
        sourcesTitle: t('me.pay.sources'),
        trace: null,
      };
    } else {
      const result = await loadExplainTrace(authz, explainStubId);
      payExplain = {
        stubId: explainStubId,
        closeHref: '/me',
        title: `${t('me.pay.explainTitle')} · ${found.payDate}`,
        missing: 'missing' in result ? result.missing : null,
        grossLabel: t('me.pay.gross'),
        netLabel: t('me.pay.net'),
        employerCostLabel: t('me.pay.employerCost'),
        earningsTitle: t('me.pay.earnings'),
        deductionsTitle: t('me.pay.deductions'),
        contributionsTitle: t('me.pay.contributions'),
        inputsTitle: t('me.pay.inputs'),
        diffTitle: t('me.pay.diff'),
        sourcesTitle: t('me.pay.sources'),
        trace: 'trace' in result ? result.trace : null,
      };
    }
  }
  return {
    hasPay: true,
    payTitle: t('me.pay.title'),
    payStubs: stubs.map((s) => ({
      ...s,
      explainLabel: t('me.pay.explain'),
      explainHref: `/me?explain=${s.id}`,
    })),
    payColumns: { payDate: t('me.pay.payDate'), gross: t('me.pay.gross'), netPay: t('me.pay.net') },
    payEmpty: t('me.pay.empty'),
    payExplain,
  };
}

/** One own-or-granted payslip trace for the Explain drawer. */
export async function loadExplainTrace(
  authz: Authz,
  stubId: string,
): Promise<{ trace: ExplainPayTrace } | { missing: string }> {
  const stub = (await db.execute<{ employmentId: string | null }>(sql`
    select employment_id::text as "employmentId" from pay_stubs
     where org_id = ${authz.user.orgId} and id = ${stubId}::uuid`)).rows[0];
  if (!stub?.employmentId) {
    return { missing: 'That payslip is missing or outside this organization — pick one from the list.' };
  }
  const trace = await explainPayslip({
    orgId: authz.user.orgId,
    actorId: authz.user.id,
    employmentId: stub.employmentId,
    stubId,
  });
  return { trace };
}

export interface AiLedgerData {
  title: string;
  description: string;
  capabilitiesTitle: string;
  decisionsTitle: string;
  overdueTitle: string;
  overdueDescription: string;
  exportLabel: string;
  syncLabel: string;
  syncDoneLabel: string;
  reviewLabel: string;
  saveLabel: string;
  failedLabel: string;
  capabilityColumns: { capability: string; autonomy: string; reviewer: string; notice: string; reviewed: string; enabled: string };
  decisionColumns: { when: string; capability: string; summary: string; outcome: string; reviewer: string };
  capabilities: (CapabilityRow & { noticeLabel: string; reviewedLabel: string; enabledLabel: string })[];
  decisions: DecisionRow[];
  overdue: CapabilityRow[];
  reviewMonths: number;
  settings: { zThreshold: number; retroThreshold: string; cohortKey: string; reviewMonths: number };
}

/** Governance ledger section for /admin/ai. */
export async function loadAiLedger(authz: Authz): Promise<AiLedgerData> {
  const orgId = authz.user.orgId;
  const t = await getTranslations('admin');
  const [capabilities, decisions, settings] = await Promise.all([
    listCapabilities(db, orgId),
    listDecisions(db, { orgId, limit: 50 }),
    loadAiRailsSettings(db, orgId),
  ]);
  const overdue = await overdueReviews(db, orgId, settings.reviewMonths);
  return {
    title: t('aiLedger.title'),
    description: t('aiLedger.description'),
    capabilitiesTitle: t('aiLedger.capabilitiesTitle'),
    decisionsTitle: t('aiLedger.decisionsTitle'),
    overdueTitle: t('aiLedger.overdueTitle'),
    overdueDescription: t('aiLedger.overdueDescription'),
    exportLabel: t('aiLedger.export'),
    syncLabel: t('aiLedger.sync'),
    syncDoneLabel: t('aiLedger.syncDone'),
    reviewLabel: t('aiLedger.review'),
    saveLabel: t('aiLedger.save'),
    failedLabel: t('aiLedger.failed'),
    capabilityColumns: {
      capability: t('aiLedger.columns.capability'),
      autonomy: t('aiLedger.columns.autonomy'),
      reviewer: t('aiLedger.columns.reviewer'),
      notice: t('aiLedger.columns.notice'),
      reviewed: t('aiLedger.columns.reviewed'),
      enabled: t('aiLedger.columns.enabled'),
    },
    decisionColumns: {
      when: t('aiLedger.columns.when'),
      capability: t('aiLedger.columns.capability'),
      summary: t('aiLedger.columns.summary'),
      outcome: t('aiLedger.columns.outcome'),
      reviewer: t('aiLedger.columns.reviewer'),
    },
    capabilities: capabilities.map((c) => ({
      ...c,
      noticeLabel: c.noticeRequired ? t('aiLedger.noticeRequired') : '—',
      reviewedLabel: c.lastReviewedAt ?? t('aiLedger.neverReviewed'),
      enabledLabel: c.enabled ? t('aiLedger.enabled') : t('aiLedger.disabled'),
    })),
    decisions,
    overdue,
    reviewMonths: settings.reviewMonths,
    settings: {
      zThreshold: settings.zThreshold,
      retroThreshold: String(settings.retroThreshold),
      cohortKey: settings.cohortKey,
      reviewMonths: settings.reviewMonths,
    },
  };
}

/** Props for the shared evidence-draft drawer island (web/app/(app)/hrm/ai/AiDraftDrawer). */
export interface AiDraftDrawerData {
  draftParam: string;
  closeHref: string;
  fieldId: string;
  title: string;
  insertLabel: string;
  discardLabel: string;
  failedLabel: string;
  sourcesTitle: string;
  biasTitle: string;
  loadingLabel: string;
  copiedLabel: string;
}

/**
 * Shared ?draft=<kind>:<subjectId> drawer data for the four evidence-draft
 * hosts (review form, requisition, onboarding process, offer). Returns null
 * unless the param parses to a known draft kind — an unknown kind renders
 * nothing rather than a broken drawer. The hrmDrafting gate hides the
 * BUTTON; the drawer itself stays mounted so a bookmarked link degrades to
 * the service refusal inside the drawer instead of a dead page.
 */
export async function loadAiDraftDrawer(opts: {
  draftParam: string | null | undefined;
  closeHref: string;
  fieldId: string;
}): Promise<AiDraftDrawerData | null> {
  if (!opts.draftParam) return null;
  const separator = opts.draftParam.indexOf(':');
  const kind = separator < 0 ? '' : opts.draftParam.slice(0, separator);
  const subjectId = separator < 0 ? '' : opts.draftParam.slice(separator + 1);
  const known = ['job_description', 'review_manager', 'review_self', 'onboarding_plan', 'offer_letter_clauses'];
  if (!known.includes(kind) || !subjectId) return null;
  const t = await getTranslations('hrm');
  return {
    draftParam: opts.draftParam,
    closeHref: opts.closeHref,
    fieldId: opts.fieldId,
    title: t('aiDraft.title'),
    insertLabel: t('aiDraft.insert'),
    discardLabel: t('aiDraft.discard'),
    failedLabel: t('aiDraft.failed'),
    sourcesTitle: t('aiDraft.sources'),
    biasTitle: t('aiDraft.biasFlags'),
    loadingLabel: t('aiDraft.loading'),
    copiedLabel: t('aiDraft.copied'),
  };
}

/** The "Draft from evidence" button label, shared by the four draft hosts. Absent while hrmDrafting is off. */
export async function loadAiDraftButton(orgId: string): Promise<string | null> {
  if (!(await isFeatureEnabled(orgId, 'hrmDrafting'))) return null;
  const t = await getTranslations('hrm');
  return t('aiDraft.button');
}

/** Open flags for one employment — timesheet approval chips and inbox subtitles. */
export async function loadOpenFlagsForEmployment(
  authz: Authz,
  employmentId: string,
): Promise<{ kind: string; severity: string; explanation: string }[]> {
  const flags = await listFlags(db, {
    orgId: authz.user.orgId,
    actorId: authz.user.id,
    employmentId,
    status: 'open',
  });
  return flags.map((f) => ({ kind: f.kind, severity: f.severity, explanation: f.explanation }));
}
