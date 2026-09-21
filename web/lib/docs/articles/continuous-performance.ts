import type { DocArticle } from "../types";

export const continuousPerformance: DocArticle = {
  slug: "continuous-performance",
  title: "Continuous performance: 1:1s, feedback, calibration and succession",
  category: "projects",
  order: 11,
  summary:
    "What happens between review cycles: 1:1 agendas that carry over, feedback captured when it happens, competencies reused everywhere, a calibration grid with an audit trail, and talent reviews that feed succession.",
  updated: "2026-09-20",
  keywords: [
    "1:1",
    "one-on-one",
    "feedback",
    "praise",
    "competency",
    "calibration",
    "9-box",
    "talent review",
    "succession",
  ],
  related: ["performance-and-retention", "positions-and-headcount", "inbox-and-home"],
  body: `# Continuous performance: 1:1s, feedback, calibration and succession

The review cycle decides rarely; performance happens weekly. Continuous
performance is what happens between cycles: the 1:1 agenda that carries
over, the feedback captured when it happens, the competency vocabulary
reused everywhere, the calibration grid with its audit trail, and the
talent review that feeds succession. Reviews then draft from evidence
instead of memory.

A 1:1 is a scheduled conversation between a manager employment and a
report employment. Either party may propose one; anyone else must manage
the report through the live line relationship. Agenda rows are talking
points, action items, and notes with shared or private visibility —
private means the author only, enforced at read, so a manager's private
note never reaches the report through any surface. Holding a recurring
1:1 generates exactly one next occurrence and COPIES the open items
forward with a carried-from link while the original is marked carried —
never moved, so history stays put. A held 1:1's shared items are
evidence for the manager review: the review drawer reads them through
the governed reader, never raw tables.

Feedback is append-only evidence: praise, feedback, and requests with a
visibility of public (praise only), manager_and_subject, manager_only,
or subject_only. The subject reads what their visibility allows; a
subject asking for manager_only rows gets the same not-found as a
stranger, so the row's existence cannot be probed. A request names the
requested party and notifies them; answering writes the fulfilment with
a forward link, because append-only rows are never updated. A retraction
is a new retraction row linking the original, and reads hide both. Who
may praise publicly is an HR-owned feedback setting, enforced when the
praise is written — never UI-only.

Competency frameworks are the org's reusable skill vocabulary:
frameworks with competencies, each with ranked level expectations.
Links attach one competency to a job level, a position, or a review
template section, so the same competency is what a review section asks
about, what a job level expects, and what a career path shows. A review
template section may carry a competency, and the review then renders the
level expectations inline at drafting time. Deactivating a framework
preserves history; links refuse dangling targets by name.

Calibration opens a session over a review cycle. Only submitted manager
reviews enter; a review not yet submitted is listed as missing with its
reason, never silently excluded. Changing a rating needs a
justification and appends an event to the audit trail; reverting clears
the decision with its own event and reason. The facilitator never
decides a review they authored. Closing writes every decided rating
back onto its review in the same transaction as the close; the
employee-visible share shows the calibrated rating with a note that
calibration occurred — never the delta, never the justification.
Changes after close are refused; a new session recalibrates.

Talent reviews are the manager questionnaire per report per cycle over
the org-declared performance and potential scales — the grid is
scales-by-scales, never a hardcoded 3x3. Succession plans rank
candidates per position with readiness. Both are HR-only reads: the
subject never sees their talent review and a candidate has no self
view; non-HR readers get the uniform refusal, never a filtered list
that leaks existence.

Each surface hides behind its own switch on Company Settings →
Features under the hrmPerformance parent: 1:1s, feedback,
competencies, calibration, and succession. Off hides the tab, widgets,
tools, and setup — never data, never history.
`,
};
