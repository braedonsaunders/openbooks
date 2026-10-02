import { HrmPerformanceError, mathRefusal } from "./errors.ts";
import { isUuid } from "../../platform/uuid.ts";
import { canonicalDecimal } from "../../money/exact-decimal.ts";
import { parseRatingScale } from "./performance-math.ts";

export interface ReviewTemplateDocument {
  name: string;
  instructions: string;
  ratingScale: { min: string; max: string; labels: string[] };
  sections: {
    id: string;
    title: string;
    kind: "competency" | "goals" | "free_text";
    weight?: string | null;
    competencyId?: string | null;
    questions: {
      id: string;
      prompt: string;
      answerKind: "rating" | "text" | "rating_and_text";
      required: boolean;
    }[];
  }[];
}
export interface ReviewTemplateDocumentDTO {
  id: string;
  revision: number;
  publishedVersion: number;
  isActive: boolean;
  draft: ReviewTemplateDocument;
  published: ReviewTemplateDocument | null;
  cycleCount: number;
}
/** Drafts may be incomplete; publication must produce a form that can launch. */
export function validateReviewTemplateDocument(
  value: ReviewTemplateDocument,
  publish: boolean,
): ReviewTemplateDocument {
  const refuse = (message: string): never => {
    throw new HrmPerformanceError("INVALID_INPUT", message);
  };
  if (
    !value ||
    typeof value.name !== "string" ||
    !value.name.trim() ||
    value.name.length > 240
  )
    refuse("Give the review template a name of at most 240 characters.");
  if (
    typeof value.instructions !== "string" ||
    value.instructions.length > 8000
  )
    refuse("Reviewer instructions must contain at most 8,000 characters.");
  const scale = mathRefusal("INVALID_INPUT", () =>
    parseRatingScale(value.ratingScale),
  );
  if (!Array.isArray(value.sections) || value.sections.length > 100)
    refuse("A review template supports at most 100 sections.");
  const keys = new Set<string>();
  let count = 0,
    required = 0;
  for (const section of value.sections) {
    if (!section || !isUuid(section.id) || keys.has(section.id))
      refuse("Every section and question needs a distinct identifier.");
    keys.add(section.id);
    if (
      section.weight != null &&
      (canonicalDecimal(section.weight, 4) === null ||
        section.weight.trim().startsWith("-"))
    )
      refuse(
        "A section weight must be a non-negative decimal with at most four decimal places.",
      );
    if (section.competencyId != null && !isUuid(section.competencyId))
      refuse("Choose an available competency for this section.");
    if (
      typeof section.title !== "string" ||
      section.title.length > 240 ||
      !["competency", "goals", "free_text"].includes(section.kind)
    )
      refuse(
        "Each section needs a supported type and a title of at most 240 characters.",
      );
    if (publish && !section.title.trim())
      refuse("Give every section a title before publishing.");
    if (!Array.isArray(section.questions))
      refuse("Each section must contain a question list.");
    for (const q of section.questions) {
      if (!q || !isUuid(q.id) || keys.has(q.id))
        refuse("Every section and question needs a distinct identifier.");
      keys.add(q.id);
      if (
        typeof q.prompt !== "string" ||
        q.prompt.length > 2000 ||
        !["rating", "text", "rating_and_text"].includes(q.answerKind) ||
        typeof q.required !== "boolean"
      )
        refuse(
          "Every question needs a supported response type and a prompt of at most 2,000 characters.",
        );
      if (publish && !q.prompt.trim())
        refuse("Give every question a prompt before publishing.");
      count++;
      if (q.required) required++;
    }
  }
  if (count > 500) refuse("A review template supports at most 500 questions.");
  if (publish && required === 0)
    refuse(
      "Add at least one required question before publishing this template.",
    );
  return {
    ...value,
    name: value.name.trim(),
    ratingScale: { min: scale.min, max: scale.max, labels: [...scale.labels] },
  };
}
