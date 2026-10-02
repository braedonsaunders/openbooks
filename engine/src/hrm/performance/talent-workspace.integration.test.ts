import { sql } from "drizzle-orm";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { db } from "../../platform/db.ts";
import {
  createScratchUser,
  dropScratchOrg
} from "../../testing/fixtures.ts";
import {
  linkPerson,
  mkEmployment, mkReviewTemplate, mkVersion, setupHarness, withHarness
} from "../../testing/hrm-harness.ts";
import { getCycleDetail, getReviewDetail, listReviewWorklist } from "./performance-read.ts";
import {
  closeCycle,
  createCycle,
  getCycleManagement,
  openCycle,
  updateCycleManagement,
} from "./review-cycles.ts";
import { saveReviewDraft, submitReview } from "./reviews.ts";
import {
  listTemplateDocuments,
  saveTemplateDocument,
} from "./template-designer.ts";
import type { ReviewTemplateDocument } from "./template-document.ts";

async function fixture() {
  const { org, hr, worker, party } = await setupHarness({
    features: ["hrm", "hrmPerformance"],
    users: [
      { key: "hr", name: "Review administrator", handle: "talent_hr", permissions: ["hrm.performance.read", "hrm.performance.manage"] },
      { key: "worker", name: "Review subject", handle: "talent_worker", link: "Review subject", partyKey: "party" },
    ],
  });
  const employment = await mkEmployment(org.orgId, party, org.subsidiaryId, { versionNo: 1, from: "2020-01-01", to: null });
  const document: ReviewTemplateDocument = {
    name: "Quarterly review",
    instructions: "Answer with examples.",
    ratingScale: {
      min: "1",
      max: "5",
      labels: ["Developing", "Consistent", "Strong"],
    },
    sections: [
      {
        id: randomUUID(),
        title: "Results",
        kind: "free_text",
        questions: [
          {
            id: randomUUID(),
            prompt: "What did you deliver?",
            answerKind: "rating_and_text",
            required: true,
          },
        ],
      },
    ],
  };
  const base = { orgId: org.orgId, actorId: hr };
  return { org, hr, worker, party, employment, document, base };
}
const cycleInput = (templateId: string) => ({
  templateId,
  name: "Q2 review",
  periodStartOn: "2026-04-01",
  periodEndOn: "2026-06-30",
  selfDueOn: "2026-07-05",
  managerDueOn: "2026-07-10",
});

test("draft publication is separate, stale writes refuse, and launches retain the published questions and scale", async () => {
  await withHarness(() => fixture(), async (h) => {
    const draft = await saveTemplateDocument({
      ...h.base,
      document: h.document,
      publish: false,
    });
    assert.equal(draft.published, null);
    const cycle = await createCycle({ ...h.base, ...cycleInput(draft.id) });
    await assert.rejects(
      openCycle({ ...h.base, cycleId: cycle.id }),
      /Publish it.*Templates/,
    );
    const published = await saveTemplateDocument({
      ...h.base,
      id: draft.id,
      revision: draft.revision,
      document: h.document,
      publish: true,
    });
    assert.equal(published.publishedVersion, 1);
    const projection = (
      await db.execute<{ prompt: string; weight: string | null }>(
        sql`select q.prompt,s.weight::text as weight from hrm_review_template_sections s join hrm_review_template_questions q on q.org_id=s.org_id and q.section_id=s.id where s.org_id=${h.org.orgId} and s.template_id=${draft.id}`,
      )
    ).rows;
    assert.equal(projection[0]!.prompt, "What did you deliver?");
    await assert.rejects(
      saveTemplateDocument({
        ...h.base,
        id: draft.id,
        revision: draft.revision,
        document: h.document,
        publish: true,
      }),
      /Another administrator.*Reload/,
    );
    const revised = {
      ...h.document,
      ratingScale: { min: "1", max: "3", labels: ["Low", "High"] },
      sections: h.document.sections.map((s) => ({
        ...s,
        questions: s.questions.map((q) => ({
          ...q,
          prompt: "Changed question",
        })),
      })),
    };
    const nextDraft = await saveTemplateDocument({
      ...h.base,
      id: draft.id,
      revision: published.revision,
      document: revised,
      publish: false,
    });
    assert.equal(nextDraft.publishedVersion, 1);
    await openCycle({ ...h.base, cycleId: cycle.id });
    const captured = (
      await db.execute<{
        scale: { max: string };
        version: number;
        snapshot: { sections: { id: string; title: string }[] };
      }>(
        sql`select rating_scale_snapshot as scale,template_version as version,template_document_snapshot as snapshot from hrm_review_cycles where org_id=${h.org.orgId} and id=${cycle.id}`,
      )
    ).rows[0]!;
    assert.equal(captured.scale.max, "5");
    assert.equal(captured.version, 1);
    assert.equal(captured.snapshot.sections[0]!.id, h.document.sections[0]!.id);
    const cycleDetail = await getCycleDetail({ ...h.base, cycleId: cycle.id });
    assert.equal(cycleDetail.templateName, h.document.name);
    const review = (
      await listReviewWorklist({ orgId: h.org.orgId, actorId: h.worker })
    )[0]!;
    const detail = await getReviewDetail({
      orgId: h.org.orgId,
      actorId: h.worker,
      reviewId: review.id,
    });
    assert.equal(detail.answers[0]!.questionPrompt, "What did you deliver?");
    await saveTemplateDocument({
      ...h.base,
      id: draft.id,
      revision: nextDraft.revision,
      document: revised,
      publish: true,
    });
    await submitReview({
      orgId: h.org.orgId,
      actorId: h.worker,
      reviewId: review.id,
      revision: detail.review.revision,
      answers: [
        {
          answerId: detail.answers[0]!.id,
          rating: "5",
          text: "Delivered results",
        },
      ],
    });
    const stored = (
      await db.execute<{ status: string }>(
        sql`select status from hrm_reviews where org_id=${h.org.orgId} and id=${review.id}`,
      )
    ).rows[0]!;
    assert.equal(stored.status, "submitted");
  });
});

test("incomplete drafts persist, stale revisions and required submission failures leave stored answers intact", async () => {
  await withHarness(() => fixture(), async (h) => {
    const template = await saveTemplateDocument({
      ...h.base,
      document: h.document,
      publish: true,
    });
    const cycle = await createCycle({ ...h.base, ...cycleInput(template.id) });
    await openCycle({ ...h.base, cycleId: cycle.id });
    const review = (
      await listReviewWorklist({ orgId: h.org.orgId, actorId: h.worker })
    )[0]!;
    const detail = await getReviewDetail({
      orgId: h.org.orgId,
      actorId: h.worker,
      reviewId: review.id,
    });
    const id = detail.answers[0]!.id;
    const saved = await saveReviewDraft({
      orgId: h.org.orgId,
      actorId: h.worker,
      reviewId: review.id,
      revision: 1,
      answers: [{ answerId: id, rating: null, text: "Work in progress" }],
    });
    assert.equal(saved.status, "pending");
    assert.equal(saved.revision, 2);
    assert.ok(saved.draftSavedAt);
    await assert.rejects(
      saveReviewDraft({
        orgId: h.org.orgId,
        actorId: h.worker,
        reviewId: review.id,
        revision: 1,
        answers: [{ answerId: id, text: "Stale overwrite" }],
      }),
      /another session.*Reload/,
    );
    await assert.rejects(
      submitReview({
        orgId: h.org.orgId,
        actorId: h.worker,
        reviewId: review.id,
        revision: 2,
        answers: [{ answerId: id, text: "New text without rating" }],
      }),
      /What did you deliver.*needs a rating/,
    );
    const stored = await getReviewDetail({
      orgId: h.org.orgId,
      actorId: h.worker,
      reviewId: review.id,
    });
    assert.equal(stored.answers[0]!.text, "Work in progress");
    assert.equal(stored.review.revision, 2);
    await closeCycle({ ...h.base, cycleId: cycle.id });
    await assert.rejects(
      saveReviewDraft({
        orgId: h.org.orgId,
        actorId: h.worker,
        reviewId: review.id,
        revision: 2,
        answers: [],
      }),
      /not open.*check its status/,
    );
  });
});

test("required manager gaps refuse an atomic launch and a scoped reviewer assignment resolves the gap", async () => {
  await withHarness(() => fixture(), async (h) => {
    const reviewer = await createScratchUser(
      h.org.orgId,
      "Manager reviewer",
      "talent_manager",
    );
    const reviewerParty = await linkPerson(
      h.org.orgId,
      reviewer,
      "Manager reviewer",
    );
    const reviewerEmployment = await mkEmployment(
      h.org.orgId,
      reviewerParty,
      h.org.subsidiaryId,
    );
    await mkVersion(h.org.orgId, reviewerEmployment, {
      versionNo: 1,
      from: "2020-01-01",
      to: null,
    });
    const template = await saveTemplateDocument({
      ...h.base,
      document: h.document,
      publish: true,
    });
    const cycle = await createCycle({
      ...h.base,
      ...cycleInput(template.id),
      requireManagerReviews: true,
    });
    await assert.rejects(
      openCycle({ ...h.base, cycleId: cycle.id }),
      /Assign a manager reviewer for (Review subject|Manager reviewer) in Participants/,
    );
    assert.equal(
      (
        await db.execute<{ count: number }>(
          sql`select count(*)::int as count from hrm_reviews where org_id=${h.org.orgId} and cycle_id=${cycle.id}`,
        )
      ).rows[0]!.count,
      0,
    );
    let management = await getCycleManagement({ ...h.base, cycleId: cycle.id });
    assert.equal(management.participants.length, 2);
    await assert.rejects(
      updateCycleManagement({
        ...h.base,
        cycleId: cycle.id,
        revision: management.revision,
        employmentId: h.employment,
        reviewerPartyId: h.party,
      }),
      /another in-service employee/,
    );
    management = await updateCycleManagement({
      ...h.base,
      cycleId: cycle.id,
      revision: management.revision,
      employmentId: h.employment,
      reviewerPartyId: reviewerParty,
    });
    management = await updateCycleManagement({
      ...h.base,
      cycleId: cycle.id,
      revision: management.revision,
      employmentId: reviewerEmployment,
      reviewerPartyId: h.party,
    });
    await openCycle({ ...h.base, cycleId: cycle.id });
    const launched = await getCycleManagement({ ...h.base, cycleId: cycle.id });
    assert.equal(
      launched.participants.find((p) => p.id === h.employment)!.reviewerPartyId,
      reviewerParty,
    );
    await assert.rejects(
      updateCycleManagement({
        ...h.base,
        cycleId: cycle.id,
        revision: launched.revision,
        requireManagerReviews: false,
      }),
      /policy is captured at launch/,
    );
    assert.ok(
      launched.history.some((event) => event.event === "cycle_launched"),
    );
  });
});

test("template and worklist reads do not expose another tenant and a disabled performance feature refuses writes", async () => {
  const h = await fixture(),
    other = await fixture();
  try {
    const template = await saveTemplateDocument({
      ...h.base,
      document: h.document,
      publish: true,
    });
    assert.equal(
      (await listTemplateDocuments(other.base)).some(
        (t) => t.id === template.id,
      ),
      false,
    );
    await db.execute(
      sql`update orgs set settings=jsonb_set(settings,'{features,hrmPerformance}','false'::jsonb,true) where id=${h.org.orgId}`,
    );
    await assert.rejects(
      saveTemplateDocument({ ...h.base, document: h.document, publish: true }),
      /Enable Performance.*Features/,
    );
  } finally {
    await dropScratchOrg(h.org.orgId);
    await dropScratchOrg(other.org.orgId);
  }
});

test("publication preserves native section metadata and refuses identifiers belonging to another template atomically", async () => {
  await withHarness(() => fixture(), async (h) => {
    h.document.sections[0]!.weight = "1.2500";
    const first = await saveTemplateDocument({
      ...h.base,
      document: h.document,
      publish: true,
    });
    const conflict = { ...h.document, name: "Another review" };
    await assert.rejects(
      saveTemplateDocument({ ...h.base, document: conflict, publish: true }),
      /section identifier.*Recreate/,
    );
    const documents = await listTemplateDocuments(h.base);
    assert.equal(documents.length, 1);
    assert.equal(documents[0]!.id, first.id);
    const row = (
      await db.execute<{ weight: string; name: string }>(
        sql`select s.weight::text as weight,t.name from hrm_review_template_sections s join hrm_review_templates t on t.org_id=s.org_id and t.id=s.template_id where s.org_id=${h.org.orgId} and s.id=${h.document.sections[0]!.id}`,
      )
    ).rows[0]!;
    assert.equal(row.weight, "1.2500");
    assert.equal(row.name, h.document.name);
  });
});

test("legacy templates open as editable exact-decimal documents and publish through the native configuration", async () => {
  await withHarness(() => fixture(), async (h) => {
    const id = await mkReviewTemplate(h.org.orgId, h.hr, {
      name: "Existing review",
    });
    const loaded = (await listTemplateDocuments(h.base)).find(
      (t) => t.id === id,
    )!;
    assert.equal(typeof loaded.draft.ratingScale.min, "string");
    assert.equal(typeof loaded.draft.ratingScale.max, "string");
    const saved = await saveTemplateDocument({
      ...h.base,
      id,
      revision: loaded.revision,
      document: loaded.draft,
      publish: true,
    });
    assert.equal(saved.publishedVersion, 1);
  });
});
