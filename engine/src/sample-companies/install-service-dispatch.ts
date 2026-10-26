import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { businessTimeZoneInTx, businessTodayInTx } from "../platform/business-date.ts";
import { addCalendarDays } from "../platform/civil-date.ts";
import { resolveLocalTime } from "../platform/time-zone.ts";
import { submitAndReleaseIfUngated } from "../flows/submit.ts";
import { verifyQualification } from "../hrm/qualifications/qualifications.ts";
import { postDocument } from "../ledger/posting-document.ts";
import { loadRequiredControlAccounts } from "../records/control-accounts.ts";
import { createServiceAgreement } from "../service/agreements.ts";
import { invoiceServiceWork } from "../service/billing.ts";
import { completeVisit, recordVisitPart } from "../service/completion.ts";
import { assignVisit, dispatchVisit } from "../service/dispatch.ts";
import { completeServiceJob, createServiceJob } from "../service/jobs.ts";
import { policyOn, savePolicyVersion } from "../service/policy.ts";
import {
  acceptServiceQuote,
  convertServiceQuote,
  saveServiceQuoteTerms,
  sendServiceQuote,
} from "../service/quotes.ts";
import { addAssessmentVisit, createServiceRequest } from "../service/requests.ts";
import { setVisitFieldStatus } from "../service/visits.ts";
import { sampleCompanyFeatures } from "./features.ts";
import { SERVICE_TECHNICIANS } from "./feature-scenarios.ts";
import { scenarioRecordId, type DemoContext } from "./scenarios.ts";
import { SampleCompanyError } from "./provisioning-failures.ts";

/**
 * A working day on the service desk, recorded through the service commands:
 * a dispatch policy and board, verified technician licences, an emergency
 * repair worked, completed with a stock part and invoiced, a tune-up booked
 * for tomorrow, a replacement quote accepted and converted into a scheduled
 * installation, a second quote awaiting the customer, an assessment waiting
 * in the queue, and a seasonal maintenance agreement generating its visits.
 */
export async function installServiceDispatch(c: DemoContext): Promise<void> {
  if (!sampleCompanyFeatures(c.industryKey).serviceDispatch) return;
  // Member companies keep the service history their source carried; a master
  // without the service day gains it once.
  if (c.memberSample) return;
  const id = (table: string, key = "main") => scenarioRecordId(c, table, key);
  const actor = { orgId: c.orgId, actorId: c.actorId };
  if (
    (
      await db.execute(
        sql`select id from service_requests where org_id = ${c.orgId} and id = ${id("service_requests", "no-heat")}`,
        "objects",
      )
    ).length
  )
    return;

  const timeZone = await businessTimeZoneInTx(db, c.orgId);
  const today = await businessTodayInTx(db, c.orgId);
  const at = (date: string, time: string): string => {
    const resolved = resolveLocalTime({ date, time }, timeZone);
    const choice = resolved.kind === "ready" ? resolved.choices[0] : undefined;
    if (!choice)
      throw new SampleCompanyError(
        `The service demonstration cannot place ${date} ${time} in ${timeZone}.`,
      );
    return choice.instant;
  };
  const customer = (n: number) => id("parties", `operations-customer-${n}`);
  const site = (n: number) => id("addresses", `service-site-${n}`);
  const technician = (n: number) => id("parties", SERVICE_TECHNICIANS[n - 1]!.key);
  const item = (key: string) => id("items", key);

  if (!(await policyOn(c.orgId, today))) {
    await savePolicyVersion({
      ...actor,
      input: {
        effectiveFrom: `${c.year}-01-01`,
        notifyArrivalWindow: false,
        notifyEnRoute: false,
        arrivalWindowMinutes: 120,
        defaultVisitMinutes: 90,
        urgentResponseHours: 4,
        highResponseHours: 24,
        normalResponseHours: 72,
        lowResponseHours: 168,
        agreementHorizonDays: 120,
        reason: "Service desk response standards and arrival windows",
      },
    });
  }
  const boardId = id("schedule_boards", "dispatch");
  const board = await db.execute(
    sql`insert into schedule_boards (id, org_id, code, name, description, row_kind, board_type, subsidiary_id, grain, views, default_view,
      time_zone, publish_policy, day_starts, day_ends, day_break_minutes, created_by, updated_by)
    values (${boardId}, ${c.orgId}, 'DEMO-DISPATCH', 'Service dispatch', 'Technician day board for service, repair and maintenance visits.',
      'people', 'dispatch', ${c.subsidiaryId}, 'timed', '{dispatch,timeline}', 'dispatch', ${timeZone}, 'live', '07:00', '18:00', 0, ${c.actorId}, ${c.actorId})
    returning id`,
    "objects",
  );
  if (board.length !== 1)
    throw new SampleCompanyError("The demonstration dispatch board could not be created.");
  await db.execute(sql`insert into audit_log(org_id,table_name,row_id,action,actor_id,changes) values(${c.orgId},'schedule_boards',${boardId},'insert',${c.actorId},
    ${JSON.stringify({ reason: "Dispatch board for the service desk", after: { code: "DEMO-DISPATCH", boardType: "dispatch", timeZone } })}::jsonb)`);

  // Licences and certifications are verified against their evidence before anyone is dispatched on them.
  for (const technicianSpec of SERVICE_TECHNICIANS) {
    for (const kind of technicianSpec.licensed ? ["refrigerant", "gas"] : ["refrigerant"]) {
      await verifyQualification(db, {
        ...actor,
        qualificationId: id("hrm_worker_qualifications", `${technicianSpec.key}-${kind}`),
        reason: "Certificate reviewed against the issuing body's register",
      });
    }
  }
  const gasFitter = id("hrm_qualification_types", "gas-fitter");

  // An emergency repair: taken, dispatched, worked on site with a stock part, completed and invoiced.
  const noHeat = await createServiceRequest({
    ...actor,
    id: id("service_requests", "no-heat"),
    input: {
      customerPartyId: customer(1),
      serviceAddressId: site(1),
      title: "No heat — furnace short cycling",
      priority: "high",
      preferredOn: today,
      preferredTime: "morning",
      description:
        "Clubhouse furnace starts, runs for a minute and shuts down. Building is cooling.",
    },
  });
  const repair = await createServiceJob({
    ...actor,
    id: id("service_jobs", "no-heat"),
    input: {
      requestId: noHeat.id,
      title: "Furnace short cycling — diagnose and repair",
      priority: "high",
      estimatedMinutes: 90,
      billingMode: "per_visit",
      requiredQualificationTypeIds: [gasFitter],
      lines: [
        {
          itemId: item("operations-service-1"),
          quantity: "1",
          unitPrice: "450.00",
          description: "Furnace diagnostic and repair — flat rate",
        },
      ],
      firstVisit: {
        preferredOn: today,
        instructions: "Gas furnace; check flame sensor and igniter first.",
      },
    },
  });
  if (!repair.visitId) throw new SampleCompanyError("The repair job did not open its first visit.");
  const repairStart = at(today, "08:00");
  let revision = (
    await assignVisit({
      ...actor,
      boardId,
      visitId: repair.visitId,
      expectedRevision: 1,
      workerPartyId: technician(1),
      startsAt: repairStart,
    })
  ).visitRevision;
  revision = (
    await dispatchVisit({ ...actor, boardId, visitId: repair.visitId, expectedRevision: revision })
  ).visitRevision;
  revision = (
    await setVisitFieldStatus({
      ...actor,
      visitId: repair.visitId,
      expectedRevision: revision,
      to: "en_route",
    })
  ).revision;
  revision = (
    await setVisitFieldStatus({
      ...actor,
      visitId: repair.visitId,
      expectedRevision: revision,
      to: "on_site",
    })
  ).revision;
  revision = (
    await recordVisitPart({
      ...actor,
      visitId: repair.visitId,
      expectedRevision: revision,
      part: {
        itemId: item("operating-stock-1"),
        stockLocationId: id("stock_locations"),
        quantity: "1",
        unitPrice: "35.00",
        billable: true,
        memo: "Replaced cracked igniter",
      },
    })
  ).visitRevision;
  await completeVisit({
    ...actor,
    visitId: repair.visitId,
    expectedRevision: revision,
    workNotes:
      "Igniter cracked and flame sensor fouled. Replaced the igniter, cleaned the sensor, confirmed three full heating cycles and a clean flame.",
    labor: [{ workerPartyId: technician(1), startedAt: repairStart, hours: "1.5" }],
  });
  const invoice = await invoiceServiceWork({
    ...actor,
    jobId: repair.job.id,
    visitId: repair.visitId,
  });
  const released = await submitAndReleaseIfUngated(
    "customer_invoice",
    invoice.invoiceId,
    c.actorId,
  );
  if (released.flowError || released.gated || !released.autoApproved)
    throw new SampleCompanyError(
      "The service invoice needs approval before the demonstration can post it.",
    );
  await postDocument(
    invoice.invoiceId,
    { control: await loadRequiredControlAccounts(c.orgId) },
    { audit: { actorId: c.actorId, source: "industry_demo_installation" } },
  );
  const repairJob = (
    await db.execute<{ revision: number }>(
      sql`select revision from service_jobs where org_id = ${c.orgId} and id = ${repair.job.id}`,
      "objects",
    )
  )[0];
  if (!repairJob) throw new SampleCompanyError("The repair job could not be read back.");
  await completeServiceJob({
    ...actor,
    jobId: repair.job.id,
    expectedRevision: repairJob.revision,
  });

  // A tune-up booked on the board for tomorrow morning.
  const tomorrow = addCalendarDays(today, 1);
  const tuneUp = await createServiceJob({
    ...actor,
    id: id("service_jobs", "tune-up"),
    input: {
      customerPartyId: customer(4),
      serviceAddressId: site(4),
      title: "Air conditioner tune-up before the summer schedule",
      priority: "normal",
      estimatedMinutes: 90,
      billingMode: "per_job",
      lines: [{ itemId: item("operations-service-2"), quantity: "1", unitPrice: "275.00" }],
      firstVisit: { preferredOn: tomorrow },
    },
  });
  if (!tuneUp.visitId) throw new SampleCompanyError("The tune-up job did not open its visit.");
  await assignVisit({
    ...actor,
    boardId,
    visitId: tuneUp.visitId,
    expectedRevision: 1,
    workerPartyId: technician(2),
    startsAt: at(tomorrow, "09:00"),
  });

  // A replacement quote the customer accepted with its add-on, converted into a scheduled installation.
  const rooftop = id("documents", "service-estimate-rooftop");
  const rooftopRequest = await createServiceRequest({
    ...actor,
    id: id("service_requests", "rooftop"),
    input: {
      customerPartyId: customer(2),
      serviceAddressId: site(2),
      title: "Replace the failing rooftop unit",
      priority: "normal",
      description:
        "Compressor failed on the 14-year-old rooftop unit; the practice wants a replacement quote.",
    },
  });
  await quoteFor(c, rooftop, rooftopRequest.id, {
    depositBasis: "percent",
    depositValue: "25",
    optional: [id("document_lines", "service-estimate-rooftop-2")],
  });
  const sent = await sendServiceQuote({
    ...actor,
    quoteDocumentId: rooftop,
    signerName: "Office manager",
    signerEmail: "office@brightside.example.invalid",
    expiresInDays: 30,
  });
  await acceptServiceQuote({
    token: sent.token,
    name: "Office manager",
    selectedOptionalLineIds: [id("document_lines", "service-estimate-rooftop-2")],
  });
  const install = addCalendarDays(today, 3);
  const installation = await convertServiceQuote({
    ...actor,
    id: id("service_jobs", "rooftop"),
    quoteDocumentId: rooftop,
    estimatedMinutes: 480,
    billingMode: "per_job",
    serviceAddressId: site(2),
    title: "Rooftop unit replacement",
    firstVisit: {
      preferredOn: install,
      instructions: "Crane booked for 07:30; roof access through the east stair.",
    },
  });
  if (!installation.visitId)
    throw new SampleCompanyError("The installation job did not open its visit.");
  await assignVisit({
    ...actor,
    boardId,
    visitId: installation.visitId,
    expectedRevision: 1,
    workerPartyId: technician(2),
    startsAt: at(install, "08:00"),
  });

  // A second quote with the customer for an answer.
  const ductless = id("documents", "service-estimate-ductless");
  await quoteFor(c, ductless, null, {
    depositBasis: "none",
    depositValue: "0",
    optional: [id("document_lines", "service-estimate-ductless-2")],
  });
  await sendServiceQuote({
    ...actor,
    quoteDocumentId: ductless,
    signerName: "Property manager",
    signerEmail: "manager@cedarlane.example.invalid",
    expiresInDays: 30,
  });

  // An intermittent fault waiting in the queue for an assessment visit.
  const thermostat = await createServiceRequest({
    ...actor,
    id: id("service_requests", "thermostat"),
    input: {
      customerPartyId: customer(3),
      serviceAddressId: site(3),
      title: "Thermostat loses its schedule",
      priority: "low",
      preferredTime: "afternoon",
      description:
        "Community room thermostat resets overnight; tenants report the heat staying on.",
    },
  });
  await addAssessmentVisit({
    ...actor,
    requestId: thermostat.id,
    expectedRevision: thermostat.revision,
    visit: { estimatedMinutes: 60, preferredOn: addCalendarDays(today, 2) },
  });

  // A seasonal maintenance plan generating its quarterly visits.
  await createServiceAgreement({
    ...actor,
    id: id("service_agreements", "seasonal"),
    input: {
      customerPartyId: customer(1),
      serviceAddressId: site(1),
      title: "Seasonal HVAC maintenance plan",
      startsOn: addCalendarDays(today, 7),
      endsOn: addCalendarDays(today, 7 + 364),
      reason: "Annual maintenance plan signed by the association board",
      version: {
        recurrence: { repeat: "monthly", interval: 3, monthlyBy: "day" },
        windowStarts: "08:00",
        windowEnds: "12:00",
        estimatedMinutes: 120,
        priority: "normal",
        instructions: "Replace filters, inspect heat exchanger and condensers, test safeties.",
        lines: [
          {
            itemId: item("operations-service-2"),
            quantity: "1",
            unitPrice: "275.00",
            description: "Seasonal maintenance visit",
          },
        ],
      },
    },
  });
}

/** Mark the estimate's add-ons and deposit, then issue it through its native lifecycle. */
async function quoteFor(
  c: DemoContext,
  quoteDocumentId: string,
  requestId: string | null,
  terms: {
    depositBasis: "none" | "percent" | "amount";
    depositValue: string;
    optional: readonly string[];
  },
): Promise<void> {
  await saveServiceQuoteTerms({
    orgId: c.orgId,
    actorId: c.actorId,
    quoteDocumentId,
    requestId,
    depositBasis: terms.depositBasis,
    depositValue: terms.depositValue,
    optionalLineIds: terms.optional,
  });
  const issued = await submitAndReleaseIfUngated("quote", quoteDocumentId, c.actorId);
  if (issued.flowError || issued.gated || !issued.autoApproved)
    throw new SampleCompanyError(
      "The service estimate needs approval before the demonstration can send it.",
    );
}
