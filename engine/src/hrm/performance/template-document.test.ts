import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  validateReviewTemplateDocument,
  type ReviewTemplateDocument,
} from "./template-document.ts";
function document(): ReviewTemplateDocument {
  return {
    name: "Role review",
    instructions: "Use concrete examples.",
    ratingScale: { min: "1", max: "5", labels: [] },
    sections: [
      {
        id: randomUUID(),
        title: "Results",
        kind: "competency",
        weight: "1.5",
        competencyId: randomUUID(),
        questions: [
          {
            id: randomUUID(),
            prompt: "Describe results.",
            answerKind: "text",
            required: true,
          },
        ],
      },
    ],
  };
}
test("authoring drafts may be incomplete but every published form has a usable required question", () => {
  const draft = document();
  draft.sections[0]!.questions = [];
  assert.equal(validateReviewTemplateDocument(draft, false).sections.length, 1);
  assert.throws(
    () => validateReviewTemplateDocument(draft, true),
    /Add at least one required question/,
  );
  const ready = document();
  ready.sections[0]!.questions[0]!.prompt = "";
  assert.throws(
    () => validateReviewTemplateDocument(ready, true),
    /Give every question a prompt/,
  );
});
test("section and question identifiers are distinct valid UUIDs and configured metadata survives validation", () => {
  const valid = document(),
    read = validateReviewTemplateDocument(valid, true);
  assert.equal(read.sections[0]!.weight, "1.5");
  assert.equal(read.sections[0]!.competencyId, valid.sections[0]!.competencyId);
  valid.sections[0]!.questions[0]!.id = valid.sections[0]!.id;
  assert.throws(
    () => validateReviewTemplateDocument(valid, true),
    /distinct identifier/,
  );
  valid.sections[0]!.questions[0]!.id = "invalid";
  assert.throws(
    () => validateReviewTemplateDocument(valid, true),
    /distinct identifier/,
  );
});
test("invalid exact-decimal weights and rating scales refuse before a form can publish", () => {
  const value = document();
  value.sections[0]!.weight = "1,5";
  assert.throws(
    () => validateReviewTemplateDocument(value, true),
    /non-negative decimal/,
  );
  value.sections[0]!.weight = "1.12345";
  assert.throws(
    () => validateReviewTemplateDocument(value, true),
    /four decimal places/,
  );
  value.sections[0]!.weight = "1";
  value.ratingScale.max = "0";
  assert.throws(() => validateReviewTemplateDocument(value, true), /inverted/);
});
