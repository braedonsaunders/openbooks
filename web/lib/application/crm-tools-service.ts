import "server-only";
import { z } from "zod";
import { can } from "../authz";
import { UUID_RE } from "@openbooks/engine/platform/identifiers";
import {
  addAgreementVersion,
  closeServiceAgreement,
  createServiceAgreement,
  generateAgreementVisits,
} from "@openbooks/engine/service/agreements";
import {
  applyServiceDeposits,
  invoiceServiceWork,
  recordServiceDeposit,
} from "@openbooks/engine/service/billing";
import { completeVisit, removeVisitPart } from "@openbooks/engine/service/completion";
import {
  assignVisit,
  dispatchVisit,
  moveVisitBooking,
  previewAssignment,
  unassignVisitBooking,
} from "@openbooks/engine/service/dispatch";
import { ServiceError } from "@openbooks/engine/service/errors";
import {
  addJobVisit,
  cancelServiceJob,
  completeServiceJob,
  createServiceJob,
  reopenServiceJob,
  replaceJobLines,
  updateServiceJob,
} from "@openbooks/engine/service/jobs";
import {
  closeServiceRequest,
  createServiceRequest,
  addAssessmentVisit,
  updateServiceRequest,
} from "@openbooks/engine/service/requests";
import {
  getVisitSignatureStatus,
  issueVisitSignatureLink,
  emailVisitSignatureLink,
  voidVisitSignatureLink,
} from "@openbooks/engine/service/signatures";
import {
  cancelVisit,
  setVisitFieldStatus,
  updateVisitPlan,
} from "@openbooks/engine/service/visits";
import {
  convertServiceQuote,
  getServiceQuoteSignatureStatus,
  saveServiceQuoteTerms,
  sendServiceQuote,
  voidServiceQuoteSignatureRequest,
} from "@openbooks/engine/service/quotes";
import { savePolicyVersion } from "@openbooks/engine/service/policy";
import {
  getServiceAgreement,
  getServiceJob,
  getServiceRequest,
  getServiceVisit,
} from "@openbooks/engine/service/reads";
import { recordPricedVisitPart } from "../service/parts";
import { deliverCustomerNotices } from "@openbooks/engine/service/notices";
import { startServiceQuote } from "../service/quotes";
import { serviceActor } from "../service/authority";
import { deliverServiceQuote } from "../service/delivery";
import {
  agreementVersionBody,
  applyDepositsBody,
  assignBody,
  assessmentBody,
  closeAgreementBody,
  closeRequestBody,
  convertQuoteBody,
  createAgreementBody,
  createJobBody,
  createRequestBody,
  depositBody,
  dispatchVisitBody,
  invoiceBody,
  jobLinesBody,
  jobVisitBody,
  moveBody,
  previewAssignmentBody,
  quoteTermsBody,
  sendQuoteBody,
  signatureLinkBody,
  startQuoteBody,
  unassignBody,
  updateJobBody,
  updateRequestBody,
  visitCancelBody,
  visitCompleteBody,
  visitPartBody,
  visitPartRemoveBody,
  visitPlanBody,
  visitStatusBody,
} from "../service/schemas";
import { featureEnabled, resolvedFeatureState } from "../features";
import { ApplicationError, forbidden, invalidInput, notFound } from "./errors";
import { assertApplicationPermission, type ApplicationContext } from "./context";
import { definition, type ApplicationToolDefinition } from "./tool-definition";

const UUID = z.string().regex(UUID_RE).describe("Record UUID from the matching service read tool.");
const IDEMPOTENCY_KEY = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{8,200}$/)
  .describe("Unique retry key for this exact mutation.");
function withIdempotency<T extends z.ZodObject>(schema: T) {
  return schema.extend({ idempotencyKey: IDEMPOTENCY_KEY });
}

function jobLifecycleInput(action: "complete" | "reopen" | "cancel") {
  const base = {
    jobId: UUID,
    expectedRevision: z.number().int().min(0).describe("Revision from get_service_job."),
    idempotencyKey: IDEMPOTENCY_KEY,
  };
  return action === "complete"
    ? z.strictObject({
        action: z.literal(action).describe("Service job lifecycle action."),
        ...base,
      })
    : z.strictObject({
        action: z.literal(action).describe("Service job lifecycle action."),
        ...base,
        reason: z.string().trim().min(1).max(2000).describe("Reason for this job transition."),
      });
}

function assertAnyPermission(context: ApplicationContext, permissions: readonly string[]) {
  if (!permissions.some((permission) => can(context.authz, permission))) {
    assertApplicationPermission(context, permissions[0]!);
  }
}

async function requireServiceFeature(context: ApplicationContext) {
  const state = await resolvedFeatureState(context.authz.user.orgId);
  if (!featureEnabled(state, "serviceDispatch")) {
    throw notFound("service record");
  }
}

function settleServiceRefusal(error: unknown): never {
  if (error instanceof ServiceError) {
    const code =
      error.status === 403
        ? "forbidden"
        : error.status === 404
          ? "not_found"
          : error.status === 409
            ? "conflict"
            : "invalid_input";
    throw new ApplicationError(code, error.message, error.status, {
      code: error.code,
      ...(error.remedy ? { remedy: error.remedy } : {}),
      ...(error.details ? error.details : {}),
    });
  }
  throw error;
}

type ServiceMutationArgs<T extends z.ZodType> = {
  name: string;
  title: string;
  description: string;
  inputSchema: T;
  permissions: readonly string[];
  featureKey?: string;
  destructive?: boolean;
  openWorld?: boolean;
  unrestricted?: boolean;
  execute: (context: ApplicationContext, input: z.infer<T>) => Promise<Record<string, unknown>>;
};

function serviceMutation<T extends z.ZodType>(args: ServiceMutationArgs<T>) {
  return definition({
    name: args.name,
    title: args.title,
    description: args.description,
    inputSchema: args.inputSchema,
    readOnly: false,
    destructive: args.destructive ?? false,
    openWorld: args.openWorld ?? false,
    assistantConfirmation: "always",
    visibleTo: (authz) => args.permissions.some((permission) => can(authz, permission)),
    featureKey: args.featureKey ?? "serviceDispatch",
    execute: async (context, input) => {
      assertAnyPermission(context, args.permissions);
      await requireServiceFeature(context);
      if (args.unrestricted && context.authz.allowedSubsidiaryIds !== null) {
        throw forbidden("subsidiary.unrestricted");
      }
      try {
        return await args.execute(context, input);
      } catch (error) {
        settleServiceRefusal(error);
      }
    },
  });
}

function serviceRead<T extends z.ZodType>(args: {
  name: string;
  title: string;
  description: string;
  inputSchema: T;
  permissions: readonly string[];
  execute: (context: ApplicationContext, input: z.infer<T>) => Promise<Record<string, unknown>>;
}) {
  return definition({
    name: args.name,
    title: args.title,
    description: args.description,
    inputSchema: args.inputSchema,
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: (authz) => args.permissions.some((permission) => can(authz, permission)),
    featureKey: "serviceDispatch",
    execute: async (context, input) => {
      assertAnyPermission(context, args.permissions);
      await requireServiceFeature(context);
      try {
        return await args.execute(context, input);
      } catch (error) {
        settleServiceRefusal(error);
      }
    },
  });
}

const manage = ["service.manage"] as const;
const readService = ["service.read", "service.manage", "service.dispatch"] as const;
const fieldStaff = ["service.self", "service.manage", "service.dispatch"] as const;
const dispatch = ["service.dispatch"] as const;

export const CRM_SERVICE_APPLICATION_TOOLS: ApplicationToolDefinition[] = [
  serviceRead({
    name: "get_service_request",
    title: "Get Service Request",
    description:
      "Read a service request with its visits and quotes before editing or closing it. Find request ids with the Service Requests list.",
    inputSchema: z.object({ requestId: UUID }),
    permissions: readService,
    execute: async (context, input) => ({
      ...(await getServiceRequest({ ...serviceActor(context.authz), requestId: input.requestId })),
    }),
  }),
  serviceRead({
    name: "get_service_job",
    title: "Get Service Job",
    description:
      "Read a service job with its scope, visits, deposits, invoices and revision before changing it. Find job ids with the Service Jobs list.",
    inputSchema: z.object({ jobId: UUID }),
    permissions: readService,
    execute: async (context, input) => ({
      ...(await getServiceJob({ ...serviceActor(context.authz), jobId: input.jobId })),
    }),
  }),
  serviceRead({
    name: "get_service_visit",
    title: "Get Service Visit",
    description:
      "Read a service visit with its work, assignment, revision and customer sign-off before changing its plan or status. Find visit ids on a request, job or dispatch board.",
    inputSchema: z.object({ visitId: UUID }),
    permissions: [...readService, "service.self"],
    execute: async (context, input) => ({
      ...(await getServiceVisit({ ...serviceActor(context.authz), visitId: input.visitId })),
    }),
  }),
  serviceRead({
    name: "get_service_agreement",
    title: "Get Service Agreement",
    description:
      "Read an agreement, its effective versions and generated visits before changing or closing it. Find agreement ids with the Service Agreements list.",
    inputSchema: z.object({ agreementId: UUID }),
    permissions: readService,
    execute: async (context, input) => ({
      ...(await getServiceAgreement({
        ...serviceActor(context.authz),
        agreementId: input.agreementId,
      })),
    }),
  }),
  serviceMutation({
    name: "create_service_request",
    title: "Create Service Request",
    description:
      "Record a new customer service request with its legal entity, address, contact and priority. Use the Service Requests list to find the created request id.",
    inputSchema: withIdempotency(createRequestBody),
    permissions: manage,
    execute: async (context, input) => {
      const { idempotencyKey: _key, id, ...request } = input;
      const result = await createServiceRequest({
        ...serviceActor(context.authz),
        id,
        input: request,
      });
      return { ok: true, ...result, href: `/service/requests/${id}` };
    },
  }),
  serviceMutation({
    name: "update_service_request",
    title: "Update Service Request",
    description:
      "Edit an open service request using the expected revision from get_service_request. The request must remain in an editable state.",
    inputSchema: withIdempotency(updateRequestBody.extend({ requestId: UUID })),
    permissions: manage,
    execute: async (context, input) => {
      const { idempotencyKey: _key, requestId, expectedRevision, ...request } = input;
      return {
        ok: true,
        ...(await updateServiceRequest({
          ...serviceActor(context.authz),
          requestId,
          expectedRevision,
          input: request,
        })),
        href: `/service/requests/${requestId}`,
      };
    },
  }),
  serviceMutation({
    name: "close_service_request",
    title: "Close Service Request",
    description:
      "Decline or cancel an open service request with a reason and the expected revision from get_service_request. The change is recorded in the request history.",
    inputSchema: withIdempotency(closeRequestBody.extend({ requestId: UUID })),
    permissions: manage,
    destructive: true,
    execute: async (context, input) => {
      const { idempotencyKey: _key, requestId, ...request } = input;
      return {
        ok: true,
        ...(await closeServiceRequest({ ...serviceActor(context.authz), requestId, ...request })),
        href: `/service/requests/${requestId}`,
      };
    },
  }),
  serviceMutation({
    name: "add_service_assessment_visit",
    title: "Add Service Assessment Visit",
    description:
      "Schedule an assessment visit for an open service request using the revision from get_service_request. The visit enters the dispatch queue unscheduled.",
    inputSchema: withIdempotency(assessmentBody.extend({ requestId: UUID })),
    permissions: manage,
    execute: async (context, input) => {
      const { idempotencyKey: _key, requestId, ...body } = input;
      const result = await addAssessmentVisit({
        ...serviceActor(context.authz),
        requestId,
        ...body,
      });
      return { ok: true, ...result, href: `/service/requests/${requestId}` };
    },
  }),
  serviceMutation({
    name: "start_service_quote",
    title: "Start Service Quote",
    description:
      "Create a native estimate for an open service request. Read the request first and use its id; the estimate appears on the request and in Estimates.",
    inputSchema: withIdempotency(startQuoteBody.extend({ requestId: UUID })),
    permissions: manage,
    execute: async (context, input) => {
      const result = await startServiceQuote(context.authz, {
        requestId: input.requestId,
        idempotencyKey: input.idempotencyKey,
      });
      return { ok: true, ...result, href: `/estimates/${result.quoteDocumentId}` };
    },
  }),
  serviceMutation({
    name: "create_service_job",
    title: "Create Service Job",
    description:
      "Create a service job directly or from an open request, with exact string quantities and prices. Read the request or job list first to obtain the source ids.",
    inputSchema: withIdempotency(createJobBody),
    permissions: manage,
    execute: async (context, input) => {
      const { idempotencyKey: _key, id, ...body } = input;
      const result = await createServiceJob({
        ...serviceActor(context.authz),
        id,
        input: body,
      });
      return { ok: true, ...result, href: `/service/jobs/${id}` };
    },
  }),
  serviceMutation({
    name: "update_service_job",
    title: "Update Service Job",
    description:
      "Edit an open service job using the expected revision from get_service_job. The job's workflow and the native service rules validate each change.",
    inputSchema: withIdempotency(updateJobBody.extend({ jobId: UUID })),
    permissions: manage,
    execute: async (context, input) => {
      const { idempotencyKey: _key, jobId, expectedRevision, ...body } = input;
      return {
        ok: true,
        ...(await updateServiceJob({
          ...serviceActor(context.authz),
          jobId,
          expectedRevision,
          input: body,
        })),
        href: `/service/jobs/${jobId}`,
      };
    },
  }),
  serviceMutation({
    name: "replace_service_job_lines",
    title: "Replace Service Job Lines",
    description:
      "Replace an open job's complete scope using exact decimal strings and the expected revision from get_service_job. Use only while the job permits scope edits.",
    inputSchema: withIdempotency(jobLinesBody.extend({ jobId: UUID })),
    permissions: manage,
    execute: async (context, input) => {
      const { idempotencyKey: _key, jobId, ...body } = input;
      return {
        ok: true,
        ...(await replaceJobLines({ ...serviceActor(context.authz), jobId, ...body })),
        href: `/service/jobs/${jobId}`,
      };
    },
  }),
  serviceMutation({
    name: "add_service_job_visit",
    title: "Add Service Job Visit",
    description:
      "Add an unscheduled visit to an open service job using its current revision. Read the job first and use the returned visit id for dispatch and field updates.",
    inputSchema: withIdempotency(jobVisitBody.extend({ jobId: UUID })),
    permissions: manage,
    execute: async (context, input) => {
      const { idempotencyKey: _key, jobId, ...body } = input;
      const result = await addJobVisit({ ...serviceActor(context.authz), jobId, ...body });
      return { ok: true, ...result, href: `/service/jobs/${jobId}` };
    },
  }),
  ...(["complete", "reopen", "cancel"] as const).map((action) =>
    serviceMutation({
      name: `${action}_service_job`,
      title: `${action[0]!.toUpperCase()}${action.slice(1)} Service Job`,
      description:
        ` ${action} a service job using the expected revision from get_service_job. The native lifecycle refuses transitions that do not meet its service requirements.`.trim(),
      inputSchema: jobLifecycleInput(action),
      permissions: manage,
      destructive: action === "cancel",
      execute: async (context, input) => {
        const { idempotencyKey: _key, jobId, expectedRevision } = input;
        const actor = {
          ...serviceActor(context.authz),
          jobId,
          expectedRevision,
        };
        const result =
          input.action === "complete"
            ? await completeServiceJob(actor)
            : input.action === "reopen"
              ? await reopenServiceJob({ ...actor, reason: input.reason })
              : await cancelServiceJob({ ...actor, reason: input.reason });
        return { ok: true, ...result, href: `/service/jobs/${jobId}` };
      },
    }),
  ),
  serviceMutation({
    name: "create_service_invoice",
    title: "Create Service Invoice",
    description:
      "Create the native draft invoice for a completed job or visit. Read the job first; invoicing requires billable completed work and returns the invoice document id.",
    inputSchema: withIdempotency(invoiceBody.extend({ jobId: UUID })),
    permissions: manage,
    execute: async (context, input) => {
      const { idempotencyKey: _key, jobId, visitId } = input;
      const result = await invoiceServiceWork({
        ...serviceActor(context.authz),
        jobId,
        visitId: visitId ?? null,
      });
      const documentId = result.invoiceId;
      return {
        ok: true,
        ...result,
        href: `/invoices/${documentId}`,
      };
    },
  }),
  serviceMutation({
    name: "record_service_deposit",
    title: "Record Service Deposit",
    description:
      "Link a posted customer payment as a deposit on a service job. Find payment and job ids with the native payment and service job reads.",
    inputSchema: withIdempotency(depositBody.extend({ jobId: UUID })),
    permissions: manage,
    execute: async (context, input) => {
      const { idempotencyKey: _key, jobId, paymentDocumentId } = input;
      return {
        ok: true,
        ...(await recordServiceDeposit({
          ...serviceActor(context.authz),
          jobId,
          paymentDocumentId,
        })),
        href: `/service/jobs/${jobId}`,
      };
    },
  }),
  serviceMutation({
    name: "apply_service_deposits",
    title: "Apply Service Deposits",
    description:
      "Apply a job's available deposits to one of its posted invoices through native credit settlements. Read the job and invoice first to confirm they belong together.",
    inputSchema: withIdempotency(applyDepositsBody.extend({ jobId: UUID })),
    permissions: manage,
    execute: async (context, input) => {
      const { idempotencyKey: _key, jobId, invoiceDocumentId } = input;
      return {
        ok: true,
        ...(await applyServiceDeposits({
          ...serviceActor(context.authz),
          jobId,
          invoiceDocumentId,
        })),
        href: `/service/jobs/${jobId}`,
      };
    },
  }),
  serviceMutation({
    name: "create_service_agreement",
    title: "Create Service Agreement",
    description:
      "Create a recurring service agreement with effective dates, a versioned visit plan and an explicit reason. Find customer, address and contact ids through party reads.",
    inputSchema: withIdempotency(createAgreementBody),
    permissions: manage,
    execute: async (context, input) => {
      const { idempotencyKey: _key, id, ...body } = input;
      return {
        ok: true,
        ...(await createServiceAgreement({
          ...serviceActor(context.authz),
          id,
          input: body,
        })),
        href: `/service/agreements/${id}`,
      };
    },
  }),
  serviceMutation({
    name: "add_service_agreement_version",
    title: "Add Service Agreement Version",
    description:
      "Add a service agreement version effective on a future date with a reason. Read the agreement first; prior occurrences retain their original terms.",
    inputSchema: withIdempotency(agreementVersionBody.extend({ agreementId: UUID })),
    permissions: manage,
    execute: async (context, input) => {
      const { idempotencyKey: _key, agreementId, ...body } = input;
      return {
        ok: true,
        ...(await addAgreementVersion({
          ...serviceActor(context.authz),
          agreementId,
          ...body,
        })),
        href: `/service/agreements/${agreementId}`,
      };
    },
  }),
  serviceMutation({
    name: "close_service_agreement",
    title: "Close Service Agreement",
    description:
      "End or cancel an agreement using its current revision, effective end date and reason. The native lifecycle releases unbooked future visits.",
    inputSchema: withIdempotency(closeAgreementBody.extend({ agreementId: UUID })),
    permissions: manage,
    destructive: true,
    execute: async (context, input) => {
      const { idempotencyKey: _key, agreementId, ...body } = input;
      return {
        ok: true,
        ...(await closeServiceAgreement({
          ...serviceActor(context.authz),
          agreementId,
          ...body,
        })),
        href: `/service/agreements/${agreementId}`,
      };
    },
  }),
  serviceMutation({
    name: "generate_service_agreement_visits",
    title: "Generate Service Agreement Visits",
    description:
      "Generate missing recurring visits through the agreement's policy horizon. Read the agreement first; generation is safe to repeat and preserves already created occurrences.",
    inputSchema: withIdempotency(z.object({ agreementId: UUID })),
    permissions: manage,
    execute: async (context, input) => {
      const result = await generateAgreementVisits({
        ...serviceActor(context.authz),
        agreementId: input.agreementId,
      });
      return { ok: true, ...result, href: `/service/agreements/${input.agreementId}` };
    },
  }),
  serviceMutation({
    name: "save_service_quote_terms",
    title: "Save Service Quote Terms",
    description:
      "Save the optional service quote add-ons and exact deposit terms on an editable estimate. Use the estimate id from get_document and confirm its service quote state first.",
    inputSchema: withIdempotency(quoteTermsBody.extend({ quoteDocumentId: UUID })),
    permissions: manage,
    execute: async (context, input) => {
      const { idempotencyKey: _key, quoteDocumentId, ...terms } = input;
      return {
        ok: true,
        ...(await saveServiceQuoteTerms({
          ...serviceActor(context.authz),
          quoteDocumentId,
          ...terms,
        })),
        href: `/estimates/${quoteDocumentId}`,
      };
    },
  }),
  serviceMutation({
    name: "send_service_quote",
    title: "Send Service Quote",
    description:
      "Send an issued estimate with saved service terms to its customer for acceptance. The estimate must be approved and have current terms; find its id with get_document.",
    inputSchema: withIdempotency(sendQuoteBody.extend({ quoteDocumentId: UUID })),
    permissions: manage,
    openWorld: true,
    execute: async (context, input) => {
      const { idempotencyKey: _key, quoteDocumentId, message, ...signer } = input;
      if (!process.env.OPENBOOKS_APP_URL?.trim()) {
        throw invalidInput(
          "The public application URL is not configured for service quote delivery.",
          { remedy: "Set OPENBOOKS_APP_URL before sending signature links from the command API." },
        );
      }
      const actor = serviceActor(context.authz);
      const sent = await sendServiceQuote({ ...actor, quoteDocumentId, ...signer });
      const delivery = await deliverServiceQuote({
        ...actor,
        sent,
        quoteDocumentId,
        message,
      });
      return {
        ok: true,
        requestId: sent.requestId,
        expiresAt: sent.expiresAt,
        ...delivery,
        href: `/estimates/${quoteDocumentId}`,
      };
    },
  }),
  serviceMutation({
    name: "void_service_quote_signature_request",
    title: "Void Service Quote Signature Request",
    description:
      "Void an open signature request for a service estimate before sending revised terms. Find the estimate id and latest request status with get_service_quote_signature_status.",
    inputSchema: z.object({ quoteDocumentId: UUID, idempotencyKey: IDEMPOTENCY_KEY }),
    permissions: manage,
    destructive: true,
    execute: async (context, input) => ({
      ok: true,
      ...(await voidServiceQuoteSignatureRequest({
        ...serviceActor(context.authz),
        quoteDocumentId: input.quoteDocumentId,
      })),
      quoteDocumentId: input.quoteDocumentId,
      href: `/estimates/${input.quoteDocumentId}`,
    }),
  }),
  serviceRead({
    name: "get_service_quote_signature_status",
    title: "Get Service Quote Signature Status",
    description:
      "Read the current service quote terms and linked signer request before voiding or converting it. Find quote ids with get_document.",
    inputSchema: z.object({ quoteDocumentId: UUID }),
    permissions: readService,
    execute: async (context, input) => ({
      ok: true,
      ...(await getServiceQuoteSignatureStatus({
        ...serviceActor(context.authz),
        quoteDocumentId: input.quoteDocumentId,
      })),
      href: `/estimates/${input.quoteDocumentId}`,
    }),
  }),
  serviceMutation({
    name: "convert_service_quote",
    title: "Convert Service Quote",
    description:
      "Convert an accepted service quote into a service job carrying the customer-selected scope. Read the estimate first and pass its current service settings.",
    inputSchema: withIdempotency(convertQuoteBody.extend({ quoteDocumentId: UUID })),
    permissions: manage,
    execute: async (context, input) => {
      const { idempotencyKey: _key, quoteDocumentId, ...body } = input;
      const result = await convertServiceQuote({
        ...serviceActor(context.authz),
        quoteDocumentId,
        ...body,
      });
      const jobId = result.job.id;
      return {
        ok: true,
        ...result,
        href: jobId ? `/service/jobs/${jobId}` : `/estimates/${quoteDocumentId}`,
      };
    },
  }),
  serviceMutation({
    name: "update_service_visit_plan",
    title: "Update Service Visit Plan",
    description:
      "Change an unscheduled or active visit plan with its expected revision and an optional reason. Read the visit first; dispatch assignment and qualification rules still apply.",
    inputSchema: withIdempotency(visitPlanBody.extend({ visitId: UUID })),
    permissions: ["service.manage", "service.dispatch"],
    execute: async (context, input) => {
      const { idempotencyKey: _key, visitId, expectedRevision, visit, reason } = input;
      return {
        ok: true,
        ...(await updateVisitPlan({
          ...serviceActor(context.authz),
          visitId,
          expectedRevision,
          input: visit,
          reason: reason ?? null,
        })),
        href: `/service/visits/${visitId}`,
      };
    },
  }),
  serviceMutation({
    name: "set_service_visit_status",
    title: "Set Service Visit Status",
    description:
      "Move a technician visit to dispatched, en route, on site or unable to complete with the revision from get_service_visit. State transitions follow the field workflow.",
    inputSchema: withIdempotency(visitStatusBody.extend({ visitId: UUID })),
    permissions: fieldStaff,
    openWorld: true,
    execute: async (context, input) => {
      const { idempotencyKey: _key, visitId, ...body } = input;
      const actor = serviceActor(context.authz);
      const result = await setVisitFieldStatus({ ...actor, visitId, ...body });
      const notices = result.notices.length
        ? await deliverCustomerNotices(actor, result.notices)
        : [];
      return { ok: true, ...result, notices, href: `/service/visits/${visitId}` };
    },
  }),
  serviceMutation({
    name: "cancel_service_visit",
    title: "Cancel Service Visit",
    description:
      "Cancel a visit or skip an agreement occurrence using the expected revision and a reason. The native service lifecycle releases its bookings.",
    inputSchema: withIdempotency(visitCancelBody.extend({ visitId: UUID })),
    permissions: ["service.manage", "service.dispatch"],
    destructive: false,
    execute: async (context, input) => {
      const { idempotencyKey: _key, visitId, ...body } = input;
      return {
        ok: true,
        ...(await cancelVisit({ ...serviceActor(context.authz), visitId, ...body })),
        href: `/service/visits/${visitId}`,
      };
    },
  }),
  serviceMutation({
    name: "complete_service_visit",
    title: "Complete Service Visit",
    description:
      "Record work notes and complete a visit with the expected revision from get_service_visit. The native completion writes labor, issues parts and starts any required review flow atomically.",
    inputSchema: withIdempotency(visitCompleteBody.extend({ visitId: UUID })),
    permissions: fieldStaff,
    execute: async (context, input) => {
      const { idempotencyKey: _key, visitId, ...body } = input;
      return {
        ok: true,
        ...(await completeVisit({ ...serviceActor(context.authz), visitId, ...body })),
        href: `/service/visits/${visitId}`,
      };
    },
  }),
  serviceMutation({
    name: "record_service_visit_part",
    title: "Record Service Visit Part",
    description:
      "Record a part used on an active visit with exact quantity, stock location and revision from get_service_visit. Inventory issues when the visit completes.",
    inputSchema: withIdempotency(visitPartBody.extend({ visitId: UUID })),
    permissions: fieldStaff,
    execute: async (context, input) => {
      const { idempotencyKey: _key, visitId, expectedRevision, ...part } = input;
      return {
        ok: true,
        ...(await recordPricedVisitPart(serviceActor(context.authz), {
          visitId,
          expectedRevision,
          part,
        })),
        href: `/service/visits/${visitId}`,
      };
    },
  }),
  serviceMutation({
    name: "remove_service_visit_part",
    title: "Remove Service Visit Part",
    description:
      "Remove an unissued part from an active visit using the expected revision from get_service_visit. Find the part id in that visit's parts list.",
    inputSchema: withIdempotency(visitPartRemoveBody.extend({ visitId: UUID, partId: UUID })),
    permissions: fieldStaff,
    destructive: true,
    execute: async (context, input) => {
      const { idempotencyKey: _key, visitId, partId, expectedRevision } = input;
      return {
        ok: true,
        ...(await removeVisitPart({
          ...serviceActor(context.authz),
          visitId,
          partId,
          expectedRevision,
        })),
        href: `/service/visits/${visitId}`,
      };
    },
  }),
  serviceMutation({
    name: "issue_service_visit_signature_link",
    title: "Issue Service Visit Signature Link",
    description:
      "Issue a customer sign-off link for a visit, optionally emailing the recipient. Find the visit id and signing state with get_service_visit.",
    inputSchema: withIdempotency(signatureLinkBody.extend({ visitId: UUID })),
    permissions: fieldStaff,
    openWorld: true,
    execute: async (context, input) => {
      const { idempotencyKey: _key, visitId, recipient, email } = input;
      const actor = serviceActor(context.authz);
      const baseUrl = process.env.OPENBOOKS_APP_URL?.trim().replace(/\/+$/, "");
      if (!baseUrl && email && recipient) {
        throw invalidInput("The public application URL is not configured for signer email.", {
          remedy: "Set OPENBOOKS_APP_URL before emailing signing links from the command API.",
        });
      }
      const issued = await issueVisitSignatureLink({
        ...actor,
        visitId,
        recipient: recipient ?? null,
      });
      const link = `${baseUrl ?? ""}/sign/service-visits/${issued.token}`;
      const delivery =
        email && issued.recipient
          ? await emailVisitSignatureLink({ ...actor, requestId: issued.requestId, link })
          : null;
      return {
        ok: true,
        requestId: issued.requestId,
        expiresAt: issued.expiresAt,
        link,
        emailed: delivery?.sent ?? false,
        emailDetail: delivery?.detail ?? null,
        href: `/service/visits/${visitId}`,
      };
    },
  }),
  serviceMutation({
    name: "void_service_visit_signature_link",
    title: "Void Service Visit Signature Link",
    description:
      "Void the latest open customer-signature link for a visit. Use get_service_visit_signature_status to confirm the request before invalidating it.",
    inputSchema: z.object({ visitId: UUID, idempotencyKey: IDEMPOTENCY_KEY }),
    permissions: fieldStaff,
    destructive: true,
    execute: async (context, input) => ({
      ok: true,
      ...(await voidVisitSignatureLink({ ...serviceActor(context.authz), visitId: input.visitId })),
      href: `/service/visits/${input.visitId}`,
    }),
  }),
  serviceRead({
    name: "get_service_visit_signature_status",
    title: "Get Service Visit Signature Status",
    description:
      "Read the latest customer sign-off link state for a visit before issuing or voiding a link. Find the visit id with get_service_visit.",
    inputSchema: z.object({ visitId: UUID }),
    permissions: fieldStaff,
    execute: async (context, input) => ({
      ok: true,
      ...(await getVisitSignatureStatus({
        ...serviceActor(context.authz),
        visitId: input.visitId,
      })),
      href: `/service/visits/${input.visitId}`,
    }),
  }),
  serviceRead({
    name: "preview_service_visit_assignment",
    title: "Preview Service Visit Assignment",
    description:
      "Preview schedule, qualification, working-hour and leave conflicts for a visit booking without writing. Find visit and board ids from service reads.",
    inputSchema: previewAssignmentBody,
    permissions: dispatch,
    execute: async (context, input) => ({
      ok: true,
      conflicts: await previewAssignment({ ...serviceActor(context.authz), ...input }),
    }),
  }),
  serviceMutation({
    name: "assign_service_visit",
    title: "Assign Service Visit",
    description:
      "Assign an unscheduled visit to a technician and time using the expected visit revision. Conflicts block assignment unless the native policy allows an override with a reason.",
    inputSchema: withIdempotency(assignBody),
    permissions: dispatch,
    openWorld: true,
    execute: async (context, input) => {
      const { idempotencyKey: _key, ...body } = input;
      const actor = serviceActor(context.authz);
      const result = await assignVisit({ ...actor, ...body });
      const notices = result.notices.length
        ? await deliverCustomerNotices(actor, result.notices)
        : [];
      return { ok: true, ...result, notices, href: `/service/visits/${body.visitId}` };
    },
  }),
  serviceMutation({
    name: "move_service_visit_booking",
    title: "Move Service Visit Booking",
    description:
      "Move or reassign a booking with the expected entry and visit revisions. Preview conflicts first when the proposed technician or time is not settled.",
    inputSchema: withIdempotency(moveBody),
    permissions: dispatch,
    openWorld: true,
    execute: async (context, input) => {
      const { idempotencyKey: _key, ...body } = input;
      const actor = serviceActor(context.authz);
      const result = await moveVisitBooking({ ...actor, ...body });
      const notices = result.notices.length
        ? await deliverCustomerNotices(actor, result.notices)
        : [];
      return { ok: true, ...result, notices, href: `/service/visits/${result.visitId}` };
    },
  }),
  serviceMutation({
    name: "unassign_service_visit",
    title: "Unassign Service Visit",
    description:
      "Release a scheduled booking back to the dispatch queue using its expected entry and visit revisions. Find both ids on the dispatch board.",
    inputSchema: withIdempotency(unassignBody),
    permissions: dispatch,
    destructive: false,
    execute: async (context, input) => {
      const { idempotencyKey: _key, ...body } = input;
      const result = await unassignVisitBooking({ ...serviceActor(context.authz), ...body });
      return { ok: true, ...result, href: `/service/dispatch?board=${body.boardId}` };
    },
  }),
  serviceMutation({
    name: "send_service_visit_dispatch",
    title: "Send Service Visit Dispatch",
    description:
      "Dispatch a scheduled visit to its technicians using the expected revision from get_service_visit. Customer notices follow their delivery preferences.",
    inputSchema: withIdempotency(dispatchVisitBody),
    permissions: dispatch,
    openWorld: true,
    execute: async (context, input) => {
      const { idempotencyKey: _key, ...body } = input;
      const actor = serviceActor(context.authz);
      const result = await dispatchVisit({ ...actor, ...body });
      const notices = result.notices.length
        ? await deliverCustomerNotices(actor, result.notices)
        : [];
      return { ok: true, ...result, notices, href: `/service/visits/${body.visitId}` };
    },
  }),
  serviceMutation({
    name: "save_service_dispatch_policy",
    title: "Save Service Dispatch Policy",
    description:
      "Add a new effective-dated organization-wide dispatch policy with an explicit reason. Requires Setup management across the entire organization; list current versions in Service Settings.",
    inputSchema: withIdempotency(
      z.object({
        effectiveFrom: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .describe("Effective calendar date."),
        notifyArrivalWindow: z.boolean().describe("Notify customers of the arrival window."),
        notifyEnRoute: z.boolean().describe("Notify customers when technicians are en route."),
        arrivalWindowMinutes: z.number().int().describe("Arrival window duration in minutes."),
        defaultVisitMinutes: z
          .number()
          .int()
          .describe("Default planned visit duration in minutes."),
        urgentResponseHours: z
          .union([z.number().int(), z.null()])
          .describe("Urgent response target in hours, or null when unset."),
        highResponseHours: z
          .union([z.number().int(), z.null()])
          .describe("High-priority response target in hours, or null when unset."),
        normalResponseHours: z
          .union([z.number().int(), z.null()])
          .describe("Normal response target in hours, or null when unset."),
        lowResponseHours: z
          .union([z.number().int(), z.null()])
          .describe("Low-priority response target in hours, or null when unset."),
        agreementHorizonDays: z.number().int().describe("Days ahead to generate recurring visits."),
        reason: z
          .string()
          .trim()
          .min(1)
          .max(2000)
          .describe("Reason recorded with this effective-dated change."),
      }),
    ),
    permissions: ["admin.setup.manage"],
    execute: async (context, input) => {
      assertApplicationPermission(context, "admin.setup.manage");
      const { idempotencyKey: _key, ...policy } = input;
      const result = await savePolicyVersion({
        orgId: context.authz.user.orgId,
        actorId: context.authz.user.id,
        input: policy,
      });
      return { ok: true, ...result, href: "/admin/setup/service" };
    },
  }),
];
