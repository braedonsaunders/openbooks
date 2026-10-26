import { sql } from "drizzle-orm";
import { db } from "../../platform/db.ts";
import { cmp } from "../../money/money.ts";
import { PayrollError } from "../error.ts";

type Subject = {
  orgId: string;
  actorId: string;
  employeePartyId: string;
  employmentId: string;
  subsidiaryId: string;
};
type Input = {
  separationEventId: string;
  separationPaymentId: string | null;
  reportPeriodStart: string;
  reportPeriodEnd: string;
  payStubLineId: string;
  reason: string;
  separationBlock: "17A" | "17C";
  separationCategoryCode: string;
};
type Payment = {
  id: string;
  componentId: string;
  amount: string;
  payDate: string;
  status: string;
  sourceLineId: string | null;
  block: string | null;
  categoryCode: string | null;
  originalSnapshot: Record<string, unknown>;
};

/** A payment-specific source declaration does not change the component's ordinary treatment. */
export function validateRoeSeparationCategory(
  block: unknown,
  code: unknown,
): asserts block is "17A" | "17C" {
  if (
    typeof code !== "string" ||
    !((block === "17A" && code === "2") || (block === "17C" && /^[A-Z][0-9]{2}$/.test(code)))
  )
    throw new PayrollError(
      "Declare vacation paid because no longer working (17A/2) or the original Block 17C category for this separation cash",
    );
}

/** The declaration represents one actual paid line, never an invented earning or payment date. */
export async function prepareRoeSeparationReportingBasis(
  subject: Subject,
  input: Input,
  retained: Record<string, unknown>,
  existingPaymentId: string | null,
): Promise<{ paymentId: string; snapshot: Record<string, unknown> }> {
  validateRoeSeparationCategory(input.separationBlock, input.separationCategoryCode);
  if (
    typeof retained.amount !== "string" ||
    cmp(retained.amount, "0") <= 0 ||
    (retained.hours !== null &&
      retained.hours !== undefined &&
      cmp(String(retained.hours), "0") !== 0) ||
    typeof retained.componentId !== "string" ||
    typeof retained.payDate !== "string"
  )
    throw new PayrollError(
      "Separation reporting needs a positive committed cash line with no paid service hours",
    );
  const events = await db.execute<{ status: string }>(
    sql`select status from payroll_roe_separation_events
    where org_id=${subject.orgId} and id=${input.separationEventId} and employee_party_id=${subject.employeePartyId}
      and employment_id=${subject.employmentId} and subsidiary_id=${subject.subsidiaryId}
      and status in ('confirmed','issued') for share`,
    "objects",
  );
  if (events.length !== 1)
    throw new PayrollError(
      "Choose the exact confirmed separation event for this employment and legal employer",
    );
  let paymentId = input.separationPaymentId ?? existingPaymentId;
  if (paymentId === null) {
    if (events[0]!.status !== "confirmed")
      throw new PayrollError("Issued separation reporting cannot acquire a new paid declaration");
    const declared = await db.execute(
      sql`select id from payroll_roe_separation_payments where org_id=${subject.orgId}
      and separation_event_id=${input.separationEventId} and pay_component_id=${retained.componentId}
      and expected_payment_on=${retained.payDate}::date limit 1`,
      "objects",
    );
    if (declared.length)
      throw new PayrollError(
        "This event already declares the payment — select its exact declaration ID to avoid counting it twice",
      );
    const created = await db.execute<{ id: string }>(
      sql`insert into payroll_roe_separation_payments
      (org_id,separation_event_id,pay_component_id,amount,payment_status,expected_payment_on,change_reason,created_by,updated_by,
        source_line_id,generated_from_line,reporting_block,reporting_category_code)
      values(${subject.orgId},${input.separationEventId},${retained.componentId},${retained.amount},'paid',${retained.payDate}::date,
        ${input.reason},${subject.actorId},${subject.actorId},${input.payStubLineId},true,${input.separationBlock},${input.separationCategoryCode}) returning id`,
      "objects",
    );
    if (created.length !== 1)
      throw new PayrollError("The exact paid separation declaration was not retained");
    paymentId = created[0]!.id;
    const audit = await db.execute(
      sql`insert into audit_log(org_id,table_name,row_id,action,changes,actor_id)
      select org_id,'payroll_roe_separation_payments',id,'insert',jsonb_build_object('before',null,'after',to_jsonb(p),
        'payStubLineId',${input.payStubLineId}::text,'reason',${input.reason}::text),${subject.actorId}
      from payroll_roe_separation_payments p where org_id=${subject.orgId} and id=${paymentId} returning id`,
      "objects",
    );
    if (audit.length !== 1)
      throw new PayrollError("The paid separation source declaration audit was not retained");
  }
  const payments = await db.execute<Payment>(
    sql`select id,pay_component_id as "componentId",amount::text as amount,
    expected_payment_on::text as "payDate",payment_status as status,source_line_id as "sourceLineId",
    reporting_block as block,reporting_category_code as "categoryCode",to_jsonb(p) as "originalSnapshot" from payroll_roe_separation_payments p
    where org_id=${subject.orgId} and id=${paymentId} and separation_event_id=${input.separationEventId} for update`,
    "objects",
  );
  const payment = payments[0];
  if (
    payments.length !== 1 ||
    !payment ||
    payment.status !== "paid" ||
    payment.componentId !== retained.componentId ||
    payment.payDate !== retained.payDate ||
    cmp(payment.amount, retained.amount) !== 0 ||
    (payment.sourceLineId !== null && payment.sourceLineId !== input.payStubLineId)
  )
    throw new PayrollError(
      "The selected separation declaration must match this exact paid component, cash amount and payment date",
    );
  if (payment.sourceLineId === null && payment.block === null && payment.categoryCode === null) {
    if (events[0]!.status !== "confirmed")
      throw new PayrollError(
        "Issued separation reporting cannot acquire a new line or classification",
      );
    const changed = await db.execute(
      sql`update payroll_roe_separation_payments set source_line_id=${input.payStubLineId},
      reporting_block=${input.separationBlock},reporting_category_code=${input.separationCategoryCode},change_reason=${input.reason},
      updated_by=${subject.actorId},updated_at=greatest(clock_timestamp(),updated_at+interval '1 microsecond')
      where org_id=${subject.orgId} and id=${paymentId} and source_line_id is null returning id`,
      "objects",
    );
    if (changed.length !== 1)
      throw new PayrollError(
        "The selected paid declaration changed before its line source was bound",
      );
    const audit = await db.execute(
      sql`insert into audit_log(org_id,table_name,row_id,action,changes,actor_id)
      select org_id,'payroll_roe_separation_payments',id,'update',jsonb_build_object('before',${JSON.stringify(payment.originalSnapshot)}::jsonb,
        'after',to_jsonb(p),'reason',${input.reason}::text),${subject.actorId} from payroll_roe_separation_payments p
      where org_id=${subject.orgId} and id=${paymentId} returning id`,
      "objects",
    );
    if (audit.length !== 1)
      throw new PayrollError("The paid declaration source-binding audit was not retained");
  } else if (
    payment.block !== input.separationBlock ||
    payment.categoryCode !== input.separationCategoryCode
  )
    throw new PayrollError(
      "The selected paid declaration has different source classification — withdraw unissued attribution before correcting it",
    );
  const proof = await db.execute<{ snapshot: Record<string, unknown> | null }>(
    sql`select public.payroll_roe_separation_reporting_basis(
    ${subject.orgId}::uuid,${input.separationEventId}::uuid,${input.payStubLineId}::uuid,${paymentId}::uuid,
    ${input.reportPeriodStart}::date,${input.reportPeriodEnd}::date) as snapshot`,
    "objects",
  );
  if (proof.length !== 1 || !proof[0]!.snapshot)
    throw new PayrollError(
      "Separation cash must report in the selected event’s retained final pay period with its original payment identity",
    );
  return { paymentId, snapshot: proof[0]!.snapshot };
}
