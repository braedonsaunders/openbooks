import { z } from "zod";
import { uuidId } from "@/lib/api/json";

const decimal = z
  .string()
  .describe("Exact decimal string; do not convert it to a JavaScript number.");

const question = z
  .object({
    id: uuidId.describe("Stable question UUID; provide the current id when editing."),
    prompt: z.string().max(2000).describe("Question text shown to the reviewer."),
    answerKind: z
      .enum(["text", "rating", "rating_and_text"])
      .describe("Expected response shape for this question."),
    required: z.boolean().describe("Whether a reviewer must answer this question."),
  })
  .strict();

const document = z
  .object({
    name: z.string().trim().min(1).max(240).describe("Review template name."),
    instructions: z.string().max(8000).describe("Instructions presented to reviewers."),
    ratingScale: z
      .object({
        min: decimal.describe("Minimum rating value as an exact decimal string."),
        max: decimal.describe("Maximum rating value as an exact decimal string."),
        labels: z
          .array(z.string().max(240))
          .max(100)
          .describe("Labels corresponding to rating values."),
      })
      .strict()
      .describe("Rating scale used by review answers."),
    sections: z
      .array(
        z
          .object({
            id: uuidId.describe("Stable section UUID; provide the current id when editing."),
            title: z.string().max(240).describe("Section title."),
            kind: z.enum(["competency", "goals", "free_text"]).describe("Section content type."),
            weight: decimal
              .nullable()
              .optional()
              .describe("Optional exact decimal section weight."),
            competencyId: uuidId.nullable().optional().describe("Optional linked competency UUID."),
            questions: z.array(question).max(500).describe("Questions included in this section."),
          })
          .strict(),
      )
      .max(100)
      .describe("Ordered sections included in the template."),
  })
  .strict();

export const saveReviewTemplateBody = z
  .object({
    id: uuidId.optional().describe("Existing template UUID to update; omit to create."),
    revision: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Current revision for a guarded update."),
    document: document.describe("Complete review template document."),
    publish: z.boolean().describe("Publish this immutable template version after saving."),
    isActive: z
      .boolean()
      .optional()
      .describe("Whether the template may be selected for new cycles."),
  })
  .strict();
