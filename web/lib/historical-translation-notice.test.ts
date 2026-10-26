import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { HistoricalTranslationEvidenceError } from "@openbooks/engine/journal/historical-translation-evidence";
import {
  historicalTranslationBlockedNotice,
  statementTranslationBlockedAction,
} from "./consolidation";

test("historical source refusal preserves its remedy and links the exact native journal entry", () => {
  const sourceEntryId = "10000000-0000-4000-8000-000000000001";
  const error = Object.assign(
    new HistoricalTranslationEvidenceError(
      "Retain genuine source layers, obtain Accounting event approval, then Apply.",
    ),
    { sourceEntryId },
  );
  const notice = historicalTranslationBlockedNotice(error, {
    title: "Evidence is required",
    actionLabel: "Review journal source",
  });
  assert.ok(notice);
  assert.equal(notice.code, "historical-evidence-required");
  assert.equal(notice.description, error.message);
  assert.deepEqual(statementTranslationBlockedAction(notice), {
    href: `/journal?journalEntry=${sourceEntryId}`,
    label: "Review journal source",
  });
  assert.equal(
    historicalTranslationBlockedNotice(new Error("Database unavailable"), {
      title: "",
      actionLabel: "",
    }),
    null,
  );
});

test("historical and period-rate refusals retain separate supported actions", () => {
  const historical = historicalTranslationBlockedNotice(
    new HistoricalTranslationEvidenceError("Apply the retained source assessment."),
    { title: "Evidence is required", actionLabel: "Review journal source" },
  );
  assert.deepEqual(statementTranslationBlockedAction(historical), {
    href: "/journal",
    label: "Review journal source",
  });
  assert.deepEqual(
    statementTranslationBlockedAction({
      code: "rates-not-derived",
      title: "Rates required",
      description: "Derive the period rates.",
      deriveHref: "/close",
      deriveLabel: "Derive rates",
    }),
    { href: "/close", label: "Derive rates" },
  );
});

test("every report locale supplies historical evidence refusal and source action copy", () => {
  for (const locale of ["en", "es", "fr", "de", "ja", "pt-BR", "zh"]) {
    const messages = JSON.parse(
      readFileSync(new URL(`../messages/${locale}/reports.json`, import.meta.url), "utf8"),
    );
    for (const key of ["historicalEvidenceBlockedTitle", "historicalEvidenceBlockedAction"])
      assert.ok(
        typeof messages.statement[key] === "string" && messages.statement[key].trim(),
        `${locale}: ${key}`,
      );
  }
});
