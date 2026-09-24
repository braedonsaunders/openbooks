import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";
import type { CandidateDrawerData, OfferDrawerData } from "./sections.tsx";

/**
 * CK-23b / H-OFFER-ENTITY read-back: a saved offer is a legal instrument,
 * so the drawer must show the persisted legal entity after save. This test
 * persists a real offer through the real services, resolves the employer
 * name with the loader's own query, server-renders the REAL drawer bodies,
 * and asserts on the emitted HTML — no source-text assertions.
 *
 * The draft offer keeps its action island mounted (the PRE failure case);
 * the island only needs router.refresh, stubbed below like the house
 * web-integration pattern.
 */
const root = pathToFileURL(process.cwd() + "/").href;
const virtual = (source: string) => ({ shortCircuit: true as const, url: "data:text/javascript," + encodeURIComponent(source) });
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return virtual("export {}");
    if (specifier === "next/navigation")
      return virtual("export function redirect() {}; export function notFound() {}; export function useRouter() { return { refresh() {} } }; export function usePathname() { return '' }");
    if (specifier === "next/link")
      return virtual("export default function Link(p) { return p.children }");
    return next(specifier, context);
  },
});

const { renderToString } = await import("react-dom/server");
const { sql } = await import("drizzle-orm");
const { db } = await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import("@openbooks/engine/src/testing/fixtures.ts");
const { createRequisition, openRequisition } = await import("@openbooks/engine/src/hrm/recruiting/requisitions.ts");
const { createCandidate } = await import("@openbooks/engine/src/hrm/recruiting/candidates.ts");
const { createApplication } = await import("@openbooks/engine/src/hrm/recruiting/applications.ts");
const { createOffer } = await import("@openbooks/engine/src/hrm/recruiting/offers.ts");
const { getOfferDetail, getCandidateDetail } = await import("@openbooks/engine/src/hrm/recruiting/recruiting-read.ts");
const { OfferDrawerBody, CandidateDrawerBody } = await import("./sections.tsx");

const DB = !!process.env.OPENBOOKS_DB_URL;
const catalog = JSON.parse(readFileSync(new URL("../../../../messages/en/hrm.json", import.meta.url), "utf8"));

async function seedOffer(): Promise<{ orgId: string; cleanup: () => Promise<void>; offer: OfferDrawerData; candidate: CandidateDrawerData; employerSubsidiaryId: string }> {
  const org = await createScratchOrg();
  const orgId = org.orgId;
  await db.execute(sql`
    update orgs set settings = jsonb_set(jsonb_set(coalesce(settings, '{}'::jsonb), '{features,hrm}', 'true'::jsonb, true), '{features,hrmRecruiting}', 'true'::jsonb, true)
     where id = ${orgId}`);
  const adminId = await createScratchUser(orgId, "Readback Admin", "readback_admin");
  await db.execute(sql`
    insert into user_permission_overrides (org_id, user_id, permission, effect)
    values (${orgId}, ${adminId}, 'hrm.recruiting.read', 'grant'),
           (${orgId}, ${adminId}, 'hrm.recruiting.manage', 'grant')
    on conflict (user_id, permission) do update set effect = 'grant'`);
  const draft = await createRequisition({ orgId, actorId: adminId, title: "Readback role", employerSubsidiaryId: org.subsidiaryId, headcount: 1 });
  const opened = await openRequisition({ orgId, actorId: adminId, requisitionId: draft.id });
  const created = await createCandidate({ orgId, actorId: adminId, displayName: "Rita Readback", email: "rita@example.test" });
  const application = await createApplication({ orgId, actorId: adminId, requisitionId: opened.id, candidateId: created.candidate.id });
  const saved = await createOffer({
    orgId, actorId: adminId, applicationId: application.id, employerSubsidiaryId: org.subsidiaryId,
    jobTitle: "Backend engineer", proposedStartOn: "2026-10-01",
    compensationAmount: "120000", compensationCurrency: "USD", compensationBasis: "annual",
  });
  const detail = await getOfferDetail({ orgId, actorId: adminId, offerId: saved.id });
  // The loader's own employer-name resolution (view.ts offer branch).
  const employerName = (await db.execute<{ name: string }>(sql`
    select name from subsidiaries
     where org_id = ${orgId}::uuid and id = ${detail.employerSubsidiaryId}
     limit 1`)).rows[0]?.name;
  assert.ok(employerName, "the persisted employer resolves to a name");
  const actions = catalog.recruiting.offerActions;
  const offer: OfferDrawerData = {
    ...detail,
    employerName,
    closeHref: "/hrm/recruiting",
    draft: null,
    labels: {
      employer: catalog.recruiting.drawer.employer,
      send: actions.send, accept: actions.accept, decline: actions.decline,
      withdraw: actions.withdraw, reason: actions.reason, failed: actions.failed,
    },
  };
  const cand = await getCandidateDetail({ orgId, actorId: adminId, candidateId: created.candidate.id });
  const candidate: CandidateDrawerData = {
    ...cand,
    closeHref: "/hrm/recruiting",
    labels: {
      applications: catalog.recruiting.drawer.applications,
      interviews: catalog.recruiting.drawer.interviews,
      email: catalog.recruiting.candidate.email,
      phone: catalog.recruiting.candidate.phone,
      source: catalog.recruiting.candidate.source,
    },
    outcomeOptions: [],
    actionLabels: {
      outcome: catalog.recruiting.interview.outcome,
      feedback: catalog.recruiting.interview.feedback,
      submit: catalog.recruiting.interview.completeSubmit,
      cancel: catalog.recruiting.interview.cancel,
      failed: catalog.recruiting.interview.failed,
    },
  };
  return { orgId, cleanup: () => dropScratchOrg(orgId), offer, candidate, employerSubsidiaryId: detail.employerSubsidiaryId };
}

test("the saved-offer drawer renders the persisted legal employer", { skip: !DB }, async () => {
  const seed = await seedOffer();
  try {
    const html = renderToString(<OfferDrawerBody detail={seed.offer} />);
    assert.ok(html.includes(seed.offer.jobTitle), "the visible offer title renders");
    // renderToString splits text nodes with hydration comments, so the row
    // is proven by its parts: the translated label and the persisted name.
    assert.ok(html.includes(seed.offer.labels.employer), "the employer row label renders");
    assert.ok(html.includes(seed.offer.employerName), "the drawer shows the persisted legal employer name");
    assert.ok(html.includes(seed.offer.compensationAmount), "the terms render alongside the entity");
    assert.ok(!html.includes(seed.employerSubsidiaryId), "the raw employer id never renders — the name does");
    assert.ok(html.includes(seed.offer.labels.send), "the draft action island mounts with the stubbed router");
  } finally {
    await seed.cleanup();
  }
});

test("the candidate drawer renders its own visible title", { skip: !DB }, async () => {
  const seed = await seedOffer();
  try {
    const html = renderToString(<CandidateDrawerBody detail={seed.candidate} />);
    assert.ok(html.includes(seed.candidate.displayName), "the candidate drawer is titled for its own record");
    assert.ok(html.includes("REQ-"), "the candidate's requisition link renders");
  } finally {
    await seed.cleanup();
  }
});
