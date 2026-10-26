import "server-only";
import { isUuid } from "../list-params";
import { sql } from "drizzle-orm";
import type { SqlExecutor } from "@openbooks/engine/platform/db";
import type { SetupEntity } from "./registry";
import { benefitPlanShapeProblem } from "./hrm-benefits";
import { benefitProgramShapeProblem } from "./benefit-programs";
import { leavePolicyRuleProblem } from "./hrm-leave-policy";
import { INTEGRITY_CONTINUES, type SetupIntegrityVerdict } from "./write-shared";

/** Ordered setup integrity rules: HRM process templates, leave policies, benefit plans and programs, process template steps and pipeline stages. */
export async function validatePeopleIntegrity(
  entity: SetupEntity,
  body: Record<string, unknown>,
  orgId: string,
  rowId: string | undefined,
  executor: SqlExecutor,
): Promise<SetupIntegrityVerdict> {
  // HRM process templates (0193): prove the applies_to filter targets are
  // visible in this org — a template that can never apply is refused by
  // field name instead of saved as applicable. The body arrives normalized
  // (slot fields folded into appliesTo); a direct appliesTo object from
  // API callers is accepted as-is.
  if (entity.key === "hrm-process-templates") {
    let values = body;
    if (rowId) {
      const current = await executor.execute(
        sql`
        select applies_to as "appliesTo", designer_managed from hrm_process_templates where id = ${rowId} and org_id = ${orgId}
      `,
        "objects",
      );
      if (!current[0]) return "Process template not found";
      if (current[0].designer_managed)
        return "Open this template in HRM Checklist templates to edit and publish its whole draft, or use Retire template there.";
      values = { ...(current[0] as Record<string, unknown>), ...body };
    }
    const raw = values.appliesTo;
    const parsed: { employer_subsidiary_id?: unknown; department_id?: unknown } =
      raw === undefined || raw === null
        ? {}
        : typeof raw === "string"
          ? (() => {
              try {
                return JSON.parse(raw) as Record<string, unknown>;
              } catch {
                return { __bad: true };
              }
            })()
          : (raw as Record<string, unknown>);
    if (
      (parsed as Record<string, unknown>).__bad !== undefined ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      return "The applies-to filter must be a JSON object";
    }
    const subsidiary = (parsed.employer_subsidiary_id ?? null) as string | null;
    const department = (parsed.department_id ?? null) as string | null;
    if (
      (subsidiary !== null && !isUuid(subsidiary)) ||
      (department !== null && !isUuid(department))
    ) {
      return "The applies-to subsidiary and department must be ids, or null for all";
    }
    const refs = await executor.execute(
      sql`
      select
        ${subsidiary ? sql`exists(select 1 from subsidiaries where id = ${subsidiary} and org_id = ${orgId})` : sql`true`} as subsidiary_ok,
        ${department ? sql`exists(select 1 from departments where id = ${department} and org_id = ${orgId})` : sql`true`} as department_ok
    `,
      "objects",
    );
    if (!refs[0]?.subsidiary_ok)
      return "The applies-to subsidiary is not visible in this organization";
    if (!refs[0]?.department_ok)
      return "The applies-to department is not visible in this organization";
  }
  // HRM leave policies (0194): the rule shapes are refused with the engine's
  // own words before the write, and the applies_to targets must be visible
  // in this org — a policy that can never apply is refused by field name.
  // Every policy change records a reason into the audit before/after image.
  if (entity.key === "leave-policies") {
    const problem = leavePolicyRuleProblem({
      appliesTo: body.appliesTo,
      accrualRule: body.accrualRule,
      carryoverRule: body.carryoverRule,
    });
    if (problem) return problem;
    if (typeof body.reason !== "string" || body.reason.trim().length === 0) {
      return "A leave policy change needs a reason — record why this policy changes";
    }
    const applies = (body.appliesTo ?? null) as {
      employer_subsidiary_id?: unknown;
      department_id?: unknown;
      employment_ids?: unknown;
      classification_ids?: unknown;
    } | null;
    if (applies) {
      const subsidiary = (applies.employer_subsidiary_id ?? null) as string | null;
      const department = (applies.department_id ?? null) as string | null;
      const refs = await executor.execute(
        sql`
        select
          ${subsidiary ? sql`exists(select 1 from subsidiaries where id = ${subsidiary} and org_id = ${orgId})` : sql`true`} as subsidiary_ok,
          ${department ? sql`exists(select 1 from departments where id = ${department} and org_id = ${orgId})` : sql`true`} as department_ok
      `,
        "objects",
      );
      if (!refs[0]?.subsidiary_ok)
        return "The applies-to subsidiary is not visible in this organization";
      if (!refs[0]?.department_ok)
        return "The applies-to department is not visible in this organization";
      const employments = Array.isArray(applies.employment_ids)
        ? (applies.employment_ids as unknown[]).map(String)
        : null;
      if (employments) {
        const missing = await executor.execute(
          sql`
          select value as id from jsonb_array_elements_text(${JSON.stringify(employments)}::jsonb)
           where not exists (select 1 from worker_employments where org_id = ${orgId} and id = value::uuid)
        `,
          "objects",
        );
        if (missing.length > 0)
          return "The applies-to employments must be employments in this organization";
      }
      const classifications = Array.isArray(applies.classification_ids)
        ? (applies.classification_ids as unknown[]).map(String)
        : null;
      if (classifications) {
        const missing = await executor.execute(
          sql`
          select value as id from jsonb_array_elements_text(${JSON.stringify(classifications)}::jsonb)
           where not exists (select 1 from hrm_work_classifications where org_id = ${orgId} and id = value::uuid)
        `,
          "objects",
        );
        if (missing.length > 0)
          return "The applies-to classifications must be classifications in this organization";
      }
    }
  }
  // Offer identity and contribution pricing have separate owners. The native
  // contribution validator is shared by setup, enrollment and payroll.
  if (entity.key === "benefit-plans") {
    let values = body;
    if (rowId) {
      const current = await executor.execute(
        sql`select is_active as "isActive", effective_from::text as "effectiveFrom", currency, waiting_period_days as "waitingPeriodDays", waiting_period_months as "waitingPeriodMonths",
        provider_party_id as "providerPartyId", employer_subsidiary_id as "employerSubsidiaryId"
        from hrm_benefit_plans where id = ${rowId} and org_id = ${orgId}`,
        "objects",
      );
      if (!current[0]) return "Benefit plan not found";
      values = { ...current[0], ...body };
    }
    const shape = benefitPlanShapeProblem(values);
    if (shape) return shape;
    const { requireBenefitCurrency, validateBenefitPlanActivation, BenefitsError } =
      await import("@openbooks/engine/hrm/benefits");
    try {
      await requireBenefitCurrency(
        executor,
        orgId,
        String(values.currency ?? ""),
        values.employerSubsidiaryId ? String(values.employerSubsidiaryId) : null,
      );
      if (values.isActive === true || values.isActive === "true") {
        if (!rowId) return "Save the offer inactive, add Contributions, and then activate it";
        await validateBenefitPlanActivation(
          executor,
          orgId,
          rowId,
          String(values.effectiveFrom ?? ""),
        );
      }
    } catch (error) {
      if (error instanceof BenefitsError) return error.message;
      throw error;
    }
    const provider = values.providerPartyId ? String(values.providerPartyId) : null;
    const subsidiary = values.employerSubsidiaryId ? String(values.employerSubsidiaryId) : null;
    const refs = await executor.execute(
      sql`select
      ${provider ? sql`exists(select 1 from parties where id=${provider} and org_id=${orgId})` : sql`true`} as provider_ok,
      ${subsidiary ? sql`exists(select 1 from subsidiaries where id=${subsidiary} and org_id=${orgId})` : sql`true`} as subsidiary_ok`,
      "objects",
    );
    if (!refs[0]?.provider_ok) return "Choose a provider in this organization";
    if (!refs[0]?.subsidiary_ok) return "Choose an employer in this organization";
  }
  // Employer-defined benefit programs: shape plus tenant references. The
  // service owns status moves; the registry edits draft configuration with
  // the same component and entity proofs.
  if (entity.key === "benefit-programs") {
    let values: Record<string, unknown> = body as Record<string, unknown>;
    if (rowId) {
      const current = await executor.execute(
        sql`
        select family, currency, frequency, period_basis as "periodBasis",
               legal_entity_id as "legalEntityId", pay_component_id as "payComponentId", delivery_method as "deliveryMethod"
          from hrm_benefit_programs where id = ${rowId} and org_id = ${orgId}
      `,
        "objects",
      );
      if (!current[0]) return "Benefit program not found";
      values = { ...(current[0] as Record<string, unknown>), ...values };
    }
    const shape = benefitProgramShapeProblem(values);
    if (shape) return shape;
    const legalEntity = (values.legalEntityId ?? null) as string | null;
    const component = (values.payComponentId ?? null) as string | null;
    const refs = await executor.execute(
      sql`
      select
        ${legalEntity ? sql`exists(select 1 from subsidiaries where id = ${legalEntity} and org_id = ${orgId} and is_active and not is_elimination)` : sql`true`} as entity_ok,
        ${component ? sql`(select json_build_object('kind', kind, 'active', is_active, 'paymentKind', payment_kind) from pay_components where id = ${component} and org_id = ${orgId})` : sql`null`} as component
    `,
      "objects",
    );
    if (!refs[0]?.entity_ok)
      return "The responsible legal entity is not visible in this organization";
    const componentRow = refs[0]?.component as {
      kind?: string | null;
      active?: boolean;
      paymentKind?: string;
    } | null;
    if (!component)
      return "Link a cash earning for payroll delivery or a non-cash earning for provider delivery before saving the program";
    if (component && !componentRow?.kind)
      return "The program pay component is not visible in this organization";
    if (component && componentRow?.active !== true)
      return "The program pay component is inactive — reactivate it or link its replacement";
    if (component && componentRow?.kind !== "earning") {
      return "The program component must be kind earning so the value reaches pay with its established tax treatment";
    }
    if (componentRow?.paymentKind !== (values.deliveryMethod === "external" ? "non_cash" : "cash"))
      return "Choose a cash earning for payroll delivery or a non-cash earning for provider delivery; a provider benefit must not also pay cash";
  }
  if (entity.key === "benefit-program-scopes") {
    let values = body;
    if (rowId) {
      const current = await executor.execute(
        sql`
        select program_id as "programId" from hrm_benefit_program_scopes where id = ${rowId} and org_id = ${orgId}
      `,
        "objects",
      );
      if (!current[0]) return "Benefit program scope not found";
      values = { ...(current[0] as Record<string, unknown>), ...body };
    }
    const program = (values.programId ?? null) as string | null;
    const department = (values.departmentId ?? null) as string | null;
    const project = (values.projectId ?? null) as string | null;
    if ((department ? 1 : 0) + (project ? 1 : 0) !== 1)
      return "A program scope names exactly one department or one project";
    const refs = await executor.execute(
      sql`
      select
        ${program ? sql`exists(select 1 from hrm_benefit_programs where id = ${program} and org_id = ${orgId})` : sql`false`} as program_ok,
        ${department ? sql`exists(select 1 from departments where id = ${department} and org_id = ${orgId})` : sql`true`} as department_ok,
        ${project ? sql`exists(select 1 from projects where id = ${project} and org_id = ${orgId})` : sql`true`} as project_ok
    `,
      "objects",
    );
    if (!refs[0]?.program_ok)
      return "The parent benefit program is not visible in this organization";
    if (!refs[0]?.department_ok) return "The scope department is not visible in this organization";
    if (!refs[0]?.project_ok) return "The scope project is not visible in this organization";
  }
  if (entity.key === "benefit-program-sources") {
    let values = body;
    if (rowId) {
      const current = await executor.execute(
        sql`
        select program_id as "programId" from hrm_benefit_program_sources where id = ${rowId} and org_id = ${orgId}
      `,
        "objects",
      );
      if (!current[0]) return "Benefit program source not found";
      values = { ...(current[0] as Record<string, unknown>), ...body };
    }
    const program = (values.programId ?? null) as string | null;
    const account = (values.accountId ?? null) as string | null;
    const refs = await executor.execute(
      sql`
      select
        ${program ? sql`exists(select 1 from hrm_benefit_programs where id = ${program} and org_id = ${orgId})` : sql`false`} as program_ok,
        ${account ? sql`exists(select 1 from accounts where id = ${account} and org_id = ${orgId} and is_active and not is_summary)` : sql`false`} as account_ok
    `,
      "objects",
    );
    if (!refs[0]?.program_ok)
      return "The parent benefit program is not visible in this organization";
    if (!refs[0]?.account_ok)
      return "The source account is not a postable account of this organization";
  }
  if (entity.key === "benefit-program-members") {
    let values = body;
    if (rowId) {
      const current = await executor.execute(
        sql`
        select program_id as "programId" from hrm_benefit_program_members where id = ${rowId} and org_id = ${orgId}
      `,
        "objects",
      );
      if (!current[0]) return "Benefit program membership not found";
      values = { ...(current[0] as Record<string, unknown>), ...body };
    }
    const program = (values.programId ?? null) as string | null;
    const employment = (values.employmentId ?? null) as string | null;
    const refs = await executor.execute(
      sql`
      select
        ${program ? sql`exists(select 1 from hrm_benefit_programs where id = ${program} and org_id = ${orgId})` : sql`false`} as program_ok,
        ${employment ? sql`exists(select 1 from worker_employments where id = ${employment} and org_id = ${orgId})` : sql`false`} as employment_ok
    `,
      "objects",
    );
    if (!refs[0]?.program_ok)
      return "The parent benefit program is not visible in this organization";
    if (!refs[0]?.employment_ok) return "The member employment is not visible in this organization";
  }
  // HRM process template steps (0193): named owners must be visible parties
  // (named_party needs exactly one, other owners need none), and the parent
  // template must live in this org.
  if (entity.key === "hrm-process-template-steps") {
    let values = body;
    if (rowId) {
      const current = await executor.execute(
        sql`
        select template_id as "templateId", owner_kind as "ownerKind", owner_party_id as "ownerPartyId"
          from hrm_process_template_steps where id = ${rowId} and org_id = ${orgId}
      `,
        "objects",
      );
      if (!current[0]) return "Template step not found";
      values = { ...(current[0] as Record<string, unknown>), ...body };
    }
    if (
      values.ownerKind !== undefined &&
      !["manager", "hr", "employee", "named_party"].includes(String(values.ownerKind))
    ) {
      return "Assign the step to manager, hr, employee, or named_party";
    }
    const ownerParty = (values.ownerPartyId ?? null) as string | null;
    if (values.ownerKind === "named_party" && ownerParty === null)
      return "A named-party step needs exactly one owner party";
    if (
      values.ownerKind !== undefined &&
      values.ownerKind !== "named_party" &&
      ownerParty !== null
    ) {
      return "Only a named-party step takes an owner party — clear it";
    }
    const refs = await executor.execute(
      sql`
      select
        ${values.templateId ? sql`exists(select 1 from hrm_process_templates where id = ${values.templateId} and org_id = ${orgId})` : sql`false`} as template_ok,
        ${ownerParty ? sql`exists(select 1 from parties where id = ${ownerParty} and org_id = ${orgId})` : sql`true`} as party_ok
    `,
      "objects",
    );
    if (!refs[0]?.template_ok) return "The parent template is not visible in this organization";
    const parent = await executor.execute(
      sql`select designer_managed from hrm_process_templates where org_id=${orgId} and id=${values.templateId}`,
      "objects",
    );
    if (parent[0]?.designer_managed)
      return "Edit steps in HRM Checklist templates and publish the complete draft instead.";
    if (!refs[0]?.party_ok) return "The owner party is not visible in this organization";
  }
  // HRM pipeline stages (0195): the parent funnel must live in this org
  // and the kind must name the fixed vocabulary — terminality derives
  // from kind in storage, so an unknown kind is refused before the write.
  if (entity.key === "hrm-pipeline-stages") {
    let values = body;
    if (rowId) {
      const current = await executor.execute(
        sql`
        select template_id as "templateId", kind from hrm_pipeline_stages
         where id = ${rowId} and org_id = ${orgId}
      `,
        "objects",
      );
      if (!current[0]) return "Pipeline stage not found";
      values = { ...(current[0] as Record<string, unknown>), ...body };
    }
    if (
      values.kind !== undefined &&
      !["screening", "interview", "assessment", "offer", "hired", "rejected"].includes(
        String(values.kind),
      )
    ) {
      return "The stage kind must be screening, interview, assessment, offer, hired, or rejected";
    }
    const refs = await executor.execute(
      sql`
      select
        ${values.templateId ? sql`exists(select 1 from hrm_pipeline_templates where id = ${values.templateId} and org_id = ${orgId})` : sql`false`} as template_ok
    `,
      "objects",
    );
    if (!refs[0]?.template_ok) return "The parent funnel is not visible in this organization";
  }
  return INTEGRITY_CONTINUES;
}
