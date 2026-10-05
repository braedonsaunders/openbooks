import { sql } from 'drizzle-orm';
import type { SqlExecutor } from '../platform/db.ts';
import { parseMoney } from '../money/brands.ts';
import { add, sum } from '../money/money.ts';
import { compileExpression, type ExpressionInput } from '../money/expression.ts';
import { civilDayIndex } from '../platform/civil-date.ts';
import { lockCompensationPackageConfiguration } from './compensation-package-store.ts';
import { PayrollError } from './error.ts';
import { compensationPackageEmploymentSource, type CompensationPackageAssignmentSource } from './compensation-package-source.ts';
import { compensationPackageNativeSettlement, validateCompensationPackagePayrollPolicy, validateCompensationPackageCurrencyRounding } from './compensation-package-payroll-policy.ts';
import { compensationPackageDefinitionHash, evaluateCompensationPackage, type CompensationPackageEvaluation } from './compensation-package.ts';
import { compensationPackageSchemaRefusal } from './compensation-package-error.ts';
import { recurringBenefitSource } from './benefit-plan-inputs.ts';
import { applyAssignedComponentLines, applyRunLineAdjustments } from './run-earning-lines.ts';
import { applicableDerivedRules, loadActiveDerivedRules } from './derived-earnings.ts';
import { fringesForEmployee } from './union.ts';
import { componentYearToDate } from './opening-balances.ts';
import { coveredPayrollLines } from './covered-payroll-lines.ts';
import { cappableHourLines, earningsBase, programApplicabilityFromExclusions, type Line } from './run-stub-records.ts';
import type { PayrollSubsidiaryScope } from './scope.ts';

type ComponentWindow = { componentId: string; from: string; to: string; basis: string };
export interface CompensationPackagePayrollContext {
  orgId: string; actorId: string; documentId: string; employeePartyId: string; employmentId: string;
  subsidiaryId: string | null; country: string; currency: string; periodStart: string; periodEnd: string;
  taxYear: number; hourlyWage: string | null; payScheduleId: string; oneOffRun: boolean; simulate: boolean;
  assignedRows: Record<string, unknown>[]; unionAgreementId: string | null; unionClassificationId: string | null;
  allowedSubsidiaryIds?: PayrollSubsidiaryScope;
}
export interface PreparedCompensationPackages {
  context: CompensationPackagePayrollContext;
  sources: CompensationPackageAssignmentSource[];
  windows: ComponentWindow[];
  replacementIds: Set<string>;
  preliminaryLines: Line[];
  authoredLines: Set<Line>;
  results: Map<string, { stages: { stage: 'earnings' | 'remaining'; evaluation: CompensationPackageEvaluation }[]; lines: Line[] }>;
}

/** Native payroll calls this inside its locked transaction; absent schema is maintenance, never a zero package calculation. */
export async function prepareCompensationPackages(tx: SqlExecutor, context: CompensationPackagePayrollContext,
  lines: readonly Line[]): Promise<PreparedCompensationPackages> {
  let sources: CompensationPackageAssignmentSource[] = [];
  if (!context.oneOffRun) {
    try { sources = await compensationPackageEmploymentSource(tx, { ...context, lockComponents: true }); }
    catch (error) { throw compensationPackageSchemaRefusal(error) ?? error; }
  }
  const prepared: PreparedCompensationPackages = { context, sources, windows: [], replacementIds: new Set(),
    preliminaryLines: [], authoredLines: new Set(), results: new Map() };
  if (!sources.length) return prepared;
  for (const source of sources) {
    if (source.employeePartyId !== context.employeePartyId || source.subsidiaryId !== context.subsidiaryId
      || source.country !== context.country || source.currency !== context.currency) {
      throw new PayrollError(`Compensation package ${source.packageCode} does not match this native employment, employer, country and currency — end the mismatched assignment and approve terms for this payroll context before recalculating.`);
    }
    validateCompensationPackagePayrollPolicy(source.definition, source.components);
    validateCompensationPackageCurrencyRounding(source.definition, source.currencyMinorUnits);
    if (compensationPackageDefinitionHash(source.definition) !== source.definitionHash) {
      throw new PayrollError(`Compensation package ${source.packageCode} no longer matches its approval evidence — approve a verified new version and assign it before recalculating.`);
    }
  }
  prepared.windows = context.assignedRows.map(row => ({ componentId: String(row.id), basis: String(row.basis),
    from: [context.periodStart, String(row.effective_from)].sort().at(-1)!,
    to: [context.periodEnd, row.effective_to == null ? context.periodEnd : String(row.effective_to)].sort()[0]! }));
  const derived = await applicableDerivedRules(tx, context.orgId, context.employeePartyId,
    await loadActiveDerivedRules(tx, context.orgId, context.periodEnd));
  for (const rule of derived.rules) prepared.windows.push({ componentId: rule.componentId,
    from: context.periodStart, to: context.periodEnd, basis: 'derived' });
  if (context.unionAgreementId) for (const fringe of await fringesForEmployee(tx, context.orgId,
    context.unionAgreementId, context.unionClassificationId ?? null)) {
    if (fringe.component_id) prepared.windows.push({ componentId: fringe.component_id,
      from: context.periodStart, to: context.periodEnd, basis: 'union' });
  }
  const benefits = await recurringBenefitSource(tx, context);
  for (const enrollment of benefits.enrollments) for (const term of enrollment.terms) {
    const rule = enrollment.rules.find(rule => rule.id === term.ruleId);
    if (!rule) continue; // The native Benefits phase raises its authoritative missing-rule refusal.
    const from = [context.periodStart, enrollment.effectiveFrom, term.effectiveFrom, rule.effectiveFrom].sort().at(-1)!;
    const to = [context.periodEnd, enrollment.effectiveTo, term.effectiveTo, rule.effectiveTo].filter((date): date is string => date !== null).sort()[0]!;
    if (from <= to) prepared.windows.push({ componentId: rule.payComponentId, from, to, basis: 'benefit' });
  }
  prepared.replacementIds = new Set((await tx.execute<{ component_id: string }>(sql`select component_id from pay_run_adjustments
    where org_id=${context.orgId} and pay_run_document_id=${context.documentId} and employee_party_id=${context.employeePartyId}
      and adjustment_type='line' and replace_component order by component_id`)).rows.map(row => row.component_id));
  prepared.preliminaryLines = lines.map(line => ({ ...line }));
  await applyAssignedComponentLines(tx, { ...context, assignedRows: context.assignedRows.filter(row => row.basis !== 'percent_of_gross'),
    lines: prepared.preliminaryLines });
  await applyRunLineAdjustments(tx, { ...context, bonusRun: false, retroRun: false, lines: prepared.preliminaryLines });
  return prepared;
}

function coveredWindow(source: CompensationPackageAssignmentSource, context: CompensationPackagePayrollContext): { from: string; to: string } {
  return { from: [context.periodStart, source.effectiveFrom].sort().at(-1)!,
    to: [context.periodEnd, source.effectiveTo ?? context.periodEnd].sort()[0]! };
}
function occupiedComponents(prepared: PreparedCompensationPackages, source: CompensationPackageAssignmentSource,
  lines: readonly Line[], stage: 'earnings' | 'remaining'): string[] {
  const { from, to } = coveredWindow(source, prepared.context);
  const ids = new Set(source.components.filter(component => stage === 'earnings' ? component.kind !== 'earning' : component.kind === 'earning').map(component => component.id));
  for (const rule of source.definition.rules) {
    const windows = prepared.windows.filter(window => window.componentId === rule.componentId && window.from <= to && window.to >= from);
    if (windows.length && !prepared.replacementIds.has(rule.componentId)) {
      let through = civilDayIndex(from) - 1;
      for (const window of windows.sort((a, b) => a.from < b.from ? -1 : a.from > b.from ? 1 : 0)) {
        if (civilDayIndex(window.from) > through + 1) break;
        through = Math.max(through, civilDayIndex(window.to));
      }
      if (through < civilDayIndex(to)) {
        throw new PayrollError(`Compensation package ${source.packageCode} shares component ${source.components.find(component => component.id === rule.componentId)!.code} with a partially overlapping native assignment — align their effective windows or choose separate components before recalculating; payroll cannot discard part of an obligation.`);
      }
      ids.add(rule.componentId);
    }
  }
  for (const line of lines) {
    if (!line.componentId || line.runAdjustmentId || line.sourceEffectiveFrom || prepared.authoredLines.has(line)) continue;
    if (coveredPayrollLines([line], from, to, prepared.context.periodStart, prepared.context.periodEnd, true).length) ids.add(line.componentId);
  }
  return [...ids];
}

/** Earnings enter gross before native percent components; remaining formulas consume the completed earning pool. */
export async function appendCompensationPackageStage(tx: SqlExecutor, prepared: PreparedCompensationPackages,
  stage: 'earnings' | 'remaining', lines: Line[]): Promise<void> {
  const context = prepared.context;
  for (const source of prepared.sources) {
    const { from, to } = coveredWindow(source, context);
    const sourceLines = stage === 'earnings' ? prepared.preliminaryLines : lines;
    const covered = coveredPayrollLines(sourceLines, from, to, context.periodStart, context.periodEnd, true);
    const earningFacts = covered.filter(line => line.kind === 'earning' && !line.accrualOnly);
    const values: Record<string, string | boolean> = { ...source.inputs };
    for (const input of source.definition.inputs) {
      if (input.source === 'period_gross') values[input.name] = earningsBase(earningFacts);
      if (input.source === 'period_hours') values[input.name] = sum(earningFacts.filter(line => line.paymentKind !== 'non_cash'
        && !line.benefitAllocationId && !prepared.authoredLines.has(line)).map(line => line.hours ?? '0'));
      if (input.source === 'hourly_wage' && context.hourlyWage !== null) values[input.name] = context.hourlyWage;
    }
    const occupied = occupiedComponents(prepared, source, sourceLines, stage);
    const suppliedComponentAmounts: Record<string, string> = {};
    for (const id of [...occupied, ...prepared.replacementIds]) {
      // A configured source retains ownership when it pays nil. Pending sources
      // cannot supply a fabricated zero to a dependant before their native phase.
      const pending = stage === 'earnings' && prepared.windows.some(window => window.componentId === id
        && window.from <= to && window.to >= from && ['benefit', 'percent_of_gross', 'union'].includes(window.basis));
      if (pending && !prepared.replacementIds.has(id)) continue;
      const actual = covered.filter(line => line.componentId === id);
      const resolvedOwner = prepared.windows.some(window => window.componentId === id && window.from <= to && window.to >= from);
      const resolvedPackage = prepared.results.get(source.assignmentId)?.stages.some(result => result.stage === 'earnings'
        && result.evaluation.lines.some(line => line.componentId === id));
      if (actual.length || resolvedOwner || resolvedPackage || prepared.replacementIds.has(id)) {
        suppliedComponentAmounts[id] = sum(actual.map(line => line.amount));
      }
    }
    const declarations: ExpressionInput[] = [...source.definition.inputs, ...source.definition.rules.map(rule => ({ name: rule.key,
      type: { kind: 'money' as const, currency: source.currency } }))];
    if (stage === 'earnings') for (const window of prepared.windows.filter(window => window.basis === 'percent_of_gross' && occupied.includes(window.componentId) && !prepared.replacementIds.has(window.componentId))) {
      const suppressedRule = source.definition.rules.find(rule => rule.componentId === window.componentId);
      if (suppressedRule && source.definition.rules.some(rule => source.components.find(component => component.id === rule.componentId)?.kind === 'earning'
        && [...compileExpression(rule.expression, declarations).dependencies, ...(rule.condition ? compileExpression(rule.condition, declarations).dependencies : [])].includes(suppressedRule.key))) {
        throw new PayrollError(`Package earning depends on recurring percent-of-gross component ${source.components.find(component => component.id === window.componentId)!.code}, whose amount changes after package earnings — combine these earning formulas in the package or choose an independent assignment input before recalculating.`);
      }
    }
    const contexts = new Map<string, { currencyMinorUnits: number; lines: ReturnType<typeof cappableHourLines>; periodToDate: string; yearToDate: string }>();
    for (const component of source.components) {
      const current = sum(lines.filter(line => line.componentId === component.id).map(line => line.amount));
      const year = component.basisCapAmountPerYear !== null ? await componentYearToDate(tx, { ...context,
        componentId: component.id, excludeRunDocumentId: context.documentId }) : '0';
      const period = component.basisCapAmountPerPeriod !== null ? (await tx.execute<{ amount: string }>(sql`select coalesce(sum(l.amount),0)::text as amount
        from pay_stub_lines l join pay_stubs s on s.org_id=l.org_id and s.id=l.stub_id
        join pay_runs r on r.org_id=s.org_id and r.document_id=s.pay_run_document_id
        where l.org_id=${context.orgId} and s.employee_party_id=${context.employeePartyId} and l.component_id=${component.id}
          and r.run_status='committed' and r.document_id<>${context.documentId} and r.pay_schedule_id=${context.payScheduleId}
          and r.period_start<=${context.periodEnd}::date and r.period_end>=${context.periodStart}::date`)).rows[0]?.amount : '0';
      if (period === undefined) throw new PayrollError('Native component period consumption could not be resolved — reload payroll sources before retrying.');
      contexts.set(component.id, { currencyMinorUnits: source.currencyMinorUnits, lines: cappableHourLines(earningFacts), periodToDate: add(period, current), yearToDate: add(year, current) });
    }
    const settlement = compensationPackageNativeSettlement(source.definition, source.components, values, id => contexts.get(id)!);
    const evaluation = evaluateCompensationPackage(source.definition, source.components, { periodStart: context.periodStart, periodEnd: context.periodEnd,
      effectiveFrom: source.effectiveFrom, effectiveTo: source.effectiveTo, values, occupiedComponentIds: occupied,
      replacementComponentIds: [...prepared.replacementIds], suppliedComponentAmounts }, settlement);
    const result = prepared.results.get(source.assignmentId) ?? { stages: [], lines: [] };
    result.stages.push({ stage, evaluation });
    prepared.results.set(source.assignmentId, result);
    for (const evaluated of evaluation.lines) {
      if (!evaluated.applicable || evaluated.amount === '0.0000') continue;
      const component = source.components.find(component => component.id === evaluated.componentId)!;
      const line: Line = { componentId: component.id, kind: component.kind, description: component.name, amount: parseMoney(evaluated.amount),
        earnedFrom: from, earnedTo: to, sequence: component.sequence, taxable: component.taxable, pensionable: component.pensionable,
        insurable: component.insurable, vacationable: component.vacationable, nonPeriodic: component.nonPeriodic,
        taxTreatment: component.taxTreatment, programApplicability: programApplicabilityFromExclusions(component.programExclusions),
        paymentKind: component.paymentKind, nonCashAccountId: component.nonCashAccountId,
        protectionBase: component.protectionBase, protectionMaxPercent: component.protectionMaxPercent,
        protectionPriority: component.protectionPriority, protectionClass: component.protectionClass,
        includeInDisposableEarnings: component.includeInDisposableEarnings,
        supplementalWageCategory: component.supplementalWageCategory as Line['supplementalWageCategory'],
        statutoryReportingCategory: component.statutoryReportingCategory,
        statutoryExemptionCategory: component.statutoryExemptionCategory as Line['statutoryExemptionCategory'] };
      lines.push(line); prepared.authoredLines.add(line); result.lines.push(line);
    }
  }
}

/** Evidence preserves approved sources, requested formulas and the final native protection result. Simulation never rewrites it. */
export async function persistCompensationPackageCalculations(tx: SqlExecutor, prepared: PreparedCompensationPackages): Promise<void> {
  if (prepared.context.simulate) return;
  for (const source of prepared.sources) {
    const result = prepared.results.get(source.assignmentId);
    if (!result) throw new PayrollError('Compensation package results were not produced — recalculate the editable pay run before committing.');
    const inserted = await tx.execute(sql`insert into payroll_compensation_calculations(org_id,pay_run_document_id,assignment_id,employment_id,source_snapshot,result_snapshot,created_by)
      values(${prepared.context.orgId},${prepared.context.documentId},${source.assignmentId},${source.employmentId},${JSON.stringify(source)}::jsonb,
        ${JSON.stringify({ algorithm: 'compensation-package-payroll-v1', stages: result.stages,
          finalLines: result.lines.map(line => ({ componentId: line.componentId, kind: line.kind, amount: line.amount, earnedFrom: line.earnedFrom, earnedTo: line.earnedTo })) })}::jsonb,
        ${prepared.context.actorId}) returning id`);
    if (inserted.rows.length !== 1) throw new PayrollError('Compensation package calculation evidence was not stored — recalculate before committing; a payable package must retain its approved sources.');
  }
}

/** The native run lock and lifecycle guard precede this replacement of editable calculation evidence. */
export async function clearCompensationPackageCalculations(tx: SqlExecutor, context: {
  orgId: string; documentId: string; simulate: boolean;
}): Promise<void> {
  if (context.simulate) return;
  // Empty evidence is expected for a first calculation or a run without assignments.
  // The schema's lifecycle trigger independently refuses removal from posted history.
  await tx.execute(sql`delete from payroll_compensation_calculations
    where org_id=${context.orgId} and pay_run_document_id=${context.documentId}`);
}

/** Native payroll must report an absent controlled rollout before producing any employee results. */
export async function requireCompensationPackageConfiguration(tx: SqlExecutor, orgId: string): Promise<void> {
  try { await lockCompensationPackageConfiguration(tx, orgId); }
  catch (error) { throw compensationPackageSchemaRefusal(error) ?? error; }
}
