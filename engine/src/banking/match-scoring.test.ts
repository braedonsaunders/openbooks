import assert from "node:assert/strict";
import test from "node:test";
import {
  assignOneToOne,
  confidenceFromScore,
  counterpartyTokens,
  datePoints,
  parseStoredMatchReasons,
  payeeTokensMatch,
  rankOpenDocuments,
  REVIEW_SCORE_CEILING,
  scoreLedgerCandidate,
  sharedReference,
  suggestOffsetFromHistory,
  type LedgerCandidateFacts,
  type OpenDocumentFacts,
  type PairProposal,
  type StatementLineFacts,
} from "./match-scoring.ts";

const line = (overrides: Partial<StatementLineFacts> = {}): StatementLineFacts => ({
  id: "line-1",
  postedOn: "2026-10-10",
  description: null,
  counterpartyRef: null,
  ...overrides,
});

const journal = (overrides: Partial<LedgerCandidateFacts> = {}): LedgerCandidateFacts => ({
  id: "jl-1",
  postingDate: "2026-10-10",
  memo: null,
  partyId: null,
  partyName: null,
  references: [],
  ...overrides,
});

test("token normalization folds case and accents, drops channel words, digits and short words", () => {
  assert.deepEqual(counterpartyTokens("POS PURCHASE Café Crème #1042 TORONTO ON", "Visa"), [
    "cafe",
    "creme",
    "toronto",
  ]);
  assert.deepEqual(counterpartyTokens(null, undefined, ""), []);
  // Each word once, in order of first appearance across texts.
  assert.deepEqual(counterpartyTokens("Acme Supply", "ACME supply co"), ["acme", "supply"]);
});

test("payee words agree on exact or specific-prefix matches and need two shared words when both sides have two", () => {
  assert.equal(
    payeeTokensMatch(["starbuck"], ["starbucks", "toronto"]),
    true,
    "a truncated merchant name agrees",
  );
  assert.equal(
    payeeTokensMatch(["sta"], ["starbucks"]),
    false,
    "a three-letter prefix is too vague",
  );
  assert.equal(
    payeeTokensMatch(["acme", "toronto"], ["globex", "toronto"]),
    false,
    "a shared city alone is not the same payee",
  );
  assert.equal(payeeTokensMatch(["acme", "supply"], ["acme", "supply", "west"]), true);
  assert.equal(payeeTokensMatch([], ["acme"]), false);
});

test("references match whole digit runs, ignore leading zeros, and never match inside a longer number", () => {
  assert.equal(sharedReference(["CHQ 001042"], ["1042"]), "1042");
  assert.equal(sharedReference(["DEPOSIT INV1042"], ["INV-1042"]), "INV-1042");
  assert.equal(
    sharedReference(["PAYMENT 1042"], ["INV-1042"]),
    "INV-1042",
    "a lettered reference matches its trailing number",
  );
  assert.equal(
    sharedReference(["TRANSFER 210423"], ["1042"]),
    null,
    "a number inside a longer run is not the reference",
  );
  assert.equal(
    sharedReference(["CHQ 42"], ["42"]),
    null,
    "fewer than three significant digits is too weak",
  );
  assert.equal(sharedReference(["DEPOSIT"], ["INV-2026-0001"]), null);
  assert.equal(sharedReference([null], ["1042"]), null);
});

test("date points prefer a lagging bank posting over a leading one of the same distance", () => {
  assert.equal(datePoints(0), 30);
  assert.equal(datePoints(1), 27);
  assert.equal(datePoints(4), 18);
  assert.equal(datePoints(-1), 22);
  assert.equal(datePoints(-4), 0);
  for (let days = 1; days <= 14; days++) {
    assert.ok(
      datePoints(days) >= datePoints(-days),
      `lag ${days} scores at least as well as lead ${days}`,
    );
    assert.ok(datePoints(days) <= datePoints(days - 1), "points never rise with distance");
  }
});

test("a same-day exact amount is high confidence with its reasons; a four-day lag or two-day lead is held for review", () => {
  const sameDay = scoreLedgerCandidate(line(), journal())!;
  assert.equal(sameDay.score, 80);
  assert.equal(sameDay.confidence, "0.8000");
  assert.deepEqual(sameDay.reasons, [{ code: "exact_amount" }, { code: "date_lag", days: 0 }]);
  assert.ok(sameDay.score > REVIEW_SCORE_CEILING);

  const lagThree = scoreLedgerCandidate(line({ postedOn: "2026-10-13" }), journal())!;
  assert.equal(lagThree.lagDays, 3, "the lag is bank date minus book date");
  assert.ok(lagThree.score > REVIEW_SCORE_CEILING);

  const lagFour = scoreLedgerCandidate(line({ postedOn: "2026-10-14" }), journal())!;
  assert.ok(lagFour.score <= REVIEW_SCORE_CEILING);

  const leadTwo = scoreLedgerCandidate(line({ postedOn: "2026-10-08" }), journal())!;
  assert.equal(leadTwo.lagDays, -2);
  assert.deepEqual(leadTwo.reasons[1], { code: "date_lag", days: -2 });
  assert.ok(leadTwo.score <= REVIEW_SCORE_CEILING);
});

test("candidates outside the fourteen-day window are not scored", () => {
  assert.equal(scoreLedgerCandidate(line({ postedOn: "2026-10-25" }), journal()), null);
  assert.ok(scoreLedgerCandidate(line({ postedOn: "2026-10-24" }), journal()));
  assert.equal(scoreLedgerCandidate(line({ postedOn: "2026-09-25" }), journal()), null);
});

test("reference, counterparty and prior-party evidence lift a distant candidate above the review ceiling", () => {
  const facts = line({ postedOn: "2026-10-17", description: "CHQ 001042 ACME SUPPLY" });
  const bare = scoreLedgerCandidate(facts, journal())!;
  assert.ok(bare.score <= REVIEW_SCORE_CEILING);

  const evidenced = scoreLedgerCandidate(
    facts,
    journal({
      partyId: "party-acme",
      partyName: "Acme Supply Ltd",
      references: ["1042", "PAY-0007"],
    }),
    [{ partyId: "party-acme", tokens: ["acme", "supply"] }],
  )!;
  assert.deepEqual(evidenced.reasons, [
    { code: "exact_amount" },
    { code: "date_lag", days: 7 },
    { code: "shared_reference", reference: "1042" },
    { code: "shared_counterparty", tokens: ["acme", "supply"] },
    { code: "prior_party" },
  ]);
  assert.equal(evidenced.score, 50 + 9 + 15 + 15 + 10);
  assert.ok(evidenced.score > REVIEW_SCORE_CEILING);
});

test("prior-party evidence needs the same party and the same payee words", () => {
  const facts = line({ description: "ACME SUPPLY" });
  const candidate = journal({ partyId: "party-acme" });
  const otherParty = scoreLedgerCandidate(facts, candidate, [
    { partyId: "party-other", tokens: ["acme", "supply"] },
  ])!;
  assert.ok(!otherParty.reasons.some((reason) => reason.code === "prior_party"));
  const otherPayee = scoreLedgerCandidate(facts, candidate, [
    { partyId: "party-acme", tokens: ["globex"] },
  ])!;
  assert.ok(!otherPayee.reasons.some((reason) => reason.code === "prior_party"));
});

test("confidence is an exact four-place decimal clamped to 0..1", () => {
  assert.equal(confidenceFromScore(71), "0.7100");
  assert.equal(confidenceFromScore(100), "1.0000");
  assert.equal(confidenceFromScore(140), "1.0000");
  assert.equal(confidenceFromScore(-5), "0.0000");
});

const proposal = (overrides: Partial<PairProposal>): PairProposal => ({
  lineId: "l1",
  candidateId: "j1",
  score: 80,
  lagDays: 0,
  preferred: true,
  lineOrder: 0,
  candidateOrder: 0,
  ...overrides,
});

test("one-to-one assignment takes the strongest pair first and uses each line and candidate once", () => {
  const assigned = assignOneToOne([
    proposal({ lineId: "far", candidateId: "j1", score: 72, lagDays: -1, lineOrder: 0 }),
    proposal({ lineId: "same-day", candidateId: "j1", score: 80, lagDays: 0, lineOrder: 1 }),
    proposal({
      lineId: "far",
      candidateId: "j2",
      score: 59,
      lagDays: 7,
      lineOrder: 0,
      candidateOrder: 1,
    }),
  ]);
  assert.deepEqual(
    assigned.map((pair) => [pair.lineId, pair.candidateId]),
    [
      ["same-day", "j1"],
      ["far", "j2"],
    ],
  );
});

test("ties break on the preferred sign bucket, then distance, then a lagging over a leading date, then load order", () => {
  const preferred = assignOneToOne([
    proposal({ candidateId: "direct", preferred: false }),
    proposal({ candidateId: "flipped", preferred: true, candidateOrder: 1 }),
  ]);
  assert.equal(preferred[0]!.candidateId, "flipped");

  const closer = assignOneToOne([
    proposal({ candidateId: "two", lagDays: 2, score: 70 }),
    proposal({ candidateId: "one", lagDays: 1, score: 70, candidateOrder: 1 }),
  ]);
  assert.equal(closer[0]!.candidateId, "one");

  const lagging = assignOneToOne([
    proposal({ candidateId: "leading", lagDays: -2, score: 70 }),
    proposal({ candidateId: "lagging", lagDays: 2, score: 70, candidateOrder: 1 }),
  ]);
  assert.equal(lagging[0]!.candidateId, "lagging");

  const ordered = [
    proposal({ lineId: "b", candidateId: "j", lineOrder: 1 }),
    proposal({ lineId: "a", candidateId: "j", lineOrder: 0 }),
  ];
  assert.equal(assignOneToOne(ordered)[0]!.lineId, "a");
  assert.deepEqual(
    assignOneToOne([...ordered].reverse()),
    assignOneToOne(ordered),
    "input order never changes the result",
  );
});

const doc = (overrides: Partial<OpenDocumentFacts>): OpenDocumentFacts => ({
  openLineId: "ol-1",
  partyId: "party-acme",
  partyName: "Acme Supply",
  accountId: "ar",
  subsidiaryId: "sub-1",
  documentNumber: "INV-1042",
  referenceNumber: null,
  entryNumber: "JE-1",
  dueDate: "2026-10-08",
  transactionOpen: "250.0000",
  ...overrides,
});

test("an exact open balance with the invoice number and customer name on the line ranks first with its reasons", () => {
  const ranked = rankOpenDocuments(
    { postedOn: "2026-10-10", amount: "250.00", description: "DEPOSIT ACME SUPPLY INV1042" },
    [
      doc({
        openLineId: "other",
        partyId: "party-globex",
        partyName: "Globex",
        documentNumber: "INV-2001",
        dueDate: "2026-12-31",
      }),
      doc({ openLineId: "acme" }),
    ],
  );
  assert.deepEqual(
    ranked.proposals.map((p) => p.openLineIds),
    [["acme"], ["other"]],
  );
  assert.deepEqual(ranked.proposals[0]!.reasons, [
    { code: "exact_open_balance" },
    { code: "shared_reference", reference: "INV-1042" },
    { code: "shared_counterparty", tokens: ["acme", "supply"] },
    { code: "due_date", days: 2 },
  ]);
  assert.equal(ranked.proposals[0]!.total, "250.0000");
});

test("several open documents of one party on one control account combine to the exact amount", () => {
  const ranked = rankOpenDocuments(
    { postedOn: "2026-10-10", amount: "300.00", description: "ACME SUPPLY" },
    [
      doc({
        openLineId: "a",
        documentNumber: "INV-1",
        transactionOpen: "100.0000",
        dueDate: "2026-10-01",
      }),
      doc({
        openLineId: "b",
        documentNumber: "INV-2",
        transactionOpen: "200.0000",
        dueDate: "2026-10-05",
      }),
      doc({ openLineId: "c", documentNumber: "INV-3", transactionOpen: "75.0000" }),
      // Same amounts on another party or another control account never combine with these.
      doc({
        openLineId: "x",
        partyId: "party-globex",
        partyName: "Globex",
        transactionOpen: "200.0000",
      }),
      doc({ openLineId: "y", accountId: "ar-other", transactionOpen: "200.0000" }),
    ],
  );
  assert.equal(ranked.proposals.length, 1);
  assert.deepEqual(ranked.proposals[0]!.openLineIds, ["b", "a"]);
  assert.equal(ranked.proposals[0]!.reasons[0]!.code, "combined_open_balance");
  assert.deepEqual(ranked.proposals[0]!.reasons[0], { code: "combined_open_balance", count: 2 });
  assert.ok(
    ranked.documents.some((entry) => entry.openLineId === "c"),
    "non-exact documents stay listed for manual selection",
  );
});

test("a single exact document outranks an equally evidenced combination", () => {
  const ranked = rankOpenDocuments(
    { postedOn: "2026-10-10", amount: "300.00", description: null },
    [
      doc({ openLineId: "single", transactionOpen: "300.0000", dueDate: null }),
      doc({ openLineId: "a", transactionOpen: "100.0000", dueDate: null }),
      doc({ openLineId: "b", transactionOpen: "200.0000", dueDate: null }),
    ],
  );
  assert.deepEqual(
    ranked.proposals.map((p) => p.openLineIds.length),
    [1, 2],
  );
});

test("documents a proposal settles stay listed beyond the document limit", () => {
  // Evidenced filler outranks the two plain documents that combine exactly.
  const filler = Array.from({ length: 5 }, (_, index) =>
    doc({
      openLineId: `filler-${index}`,
      documentNumber: "INV-1042",
      transactionOpen: "7.0000",
    }),
  );
  const ranked = rankOpenDocuments(
    { postedOn: "2026-10-10", amount: "300.00", description: "INV1042" },
    [
      ...filler,
      doc({
        openLineId: "a",
        partyId: "party-b",
        partyName: null,
        documentNumber: "B-1",
        transactionOpen: "100.0000",
        dueDate: null,
      }),
      doc({
        openLineId: "b",
        partyId: "party-b",
        partyName: null,
        documentNumber: "B-2",
        transactionOpen: "200.0000",
        dueDate: null,
      }),
    ],
    { maxDocuments: 2 },
  );
  assert.deepEqual(
    ranked.proposals.map((p) => p.openLineIds),
    [["a", "b"]],
  );
  assert.deepEqual(
    ranked.documents.map((entry) => entry.openLineId),
    ["filler-0", "filler-1", "a", "b"],
  );
});

test("a non-positive amount proposes nothing", () => {
  assert.deepEqual(
    rankOpenDocuments({ postedOn: "2026-10-10", amount: "0", description: null }, [doc({})]),
    { proposals: [], documents: [] },
  );
});

test("history suggests the most recent offset account for the same payee, never a different one", () => {
  const history = [
    { description: "SHELL #4410 CALGARY", offsetAccountId: "fuel-new", matchedOn: "2026-09-30" },
    { description: "SHELL #4410 CALGARY", offsetAccountId: "fuel-old", matchedOn: "2026-08-30" },
    { description: "ESSO 22", offsetAccountId: "other", matchedOn: "2026-10-01" },
  ];
  const suggestion = suggestOffsetFromHistory(
    { description: "POS SHELL #4410 CALGARY AB" },
    history,
  );
  assert.deepEqual(suggestion, {
    offsetAccountId: "fuel-new",
    reasons: [{ code: "history_payee", tokens: ["shell", "calgary"], matchedOn: "2026-09-30" }],
  });
  assert.equal(suggestOffsetFromHistory({ description: "PETRO CANADA" }, history), null);
  assert.equal(
    suggestOffsetFromHistory({ description: "#4410" }, history),
    null,
    "a line with no payee words suggests nothing",
  );
});

test("stored reasons parse defensively", () => {
  assert.deepEqual(parseStoredMatchReasons(null), []);
  assert.deepEqual(parseStoredMatchReasons({ code: "exact_amount" }), []);
  assert.deepEqual(
    parseStoredMatchReasons([
      { code: "exact_amount" },
      { code: "unknown_future_code" },
      "x",
      null,
      { code: "date_lag", days: 2 },
    ]),
    [{ code: "exact_amount" }, { code: "date_lag", days: 2 }],
  );
});

test("a referenced document larger than the line is proposed as a part payment after every exact settlement", () => {
  const ranked = rankOpenDocuments(
    { postedOn: "2026-10-10", amount: "100.00", description: "ACME SUPPLY INV1042" },
    [
      doc({ openLineId: "big", transactionOpen: "250.0000" }),
      doc({
        openLineId: "exact",
        partyId: "party-globex",
        partyName: "Globex",
        documentNumber: "G-7",
        transactionOpen: "100.0000",
        dueDate: null,
      }),
    ],
  );
  assert.deepEqual(
    ranked.proposals.map((p) => [p.openLineIds, p.settlement]),
    [
      [["exact"], "exact"],
      [["big"], "partial"],
    ],
  );
  const partial = ranked.proposals[1]!;
  assert.deepEqual(partial.applied, { big: "100.0000" });
  assert.equal(partial.onAccount, "0.0000");
  assert.deepEqual(partial.reasons[0], { code: "partial_open_balance", remaining: "150.0000" });
  assert.ok(partial.reasons.some((reason) => reason.code === "shared_reference"));
});

test("a larger balance with no document evidence is never proposed on amount alone", () => {
  const ranked = rankOpenDocuments(
    { postedOn: "2026-10-10", amount: "100.00", description: "WIRE 88812" },
    [
      doc({
        openLineId: "big",
        partyName: "Acme Supply",
        documentNumber: "INV-1042",
        transactionOpen: "250.0000",
      }),
    ],
  );
  assert.deepEqual(ranked.proposals, []);
  assert.deepEqual(
    ranked.documents.map((entry) => entry.openLineId),
    ["big"],
    "it stays selectable under all documents",
  );
});

test("a referenced document smaller than the line is proposed as an overpayment that keeps the rest on account", () => {
  const ranked = rankOpenDocuments(
    { postedOn: "2026-10-10", amount: "260.00", description: "INV1042" },
    [doc({ openLineId: "inv", transactionOpen: "250.0000" })],
  );
  assert.equal(ranked.proposals.length, 1);
  assert.equal(ranked.proposals[0]!.settlement, "overpayment");
  assert.deepEqual(ranked.proposals[0]!.applied, { inv: "250.0000" });
  assert.equal(ranked.proposals[0]!.onAccount, "10.0000");
  assert.deepEqual(ranked.proposals[0]!.reasons[0], {
    code: "on_account_remainder",
    remainder: "10.0000",
  });
  // Far more than the document it names is paying something else.
  assert.deepEqual(
    rankOpenDocuments({ postedOn: "2026-10-10", amount: "600.00", description: "INV1042" }, [
      doc({ openLineId: "inv" }),
    ]).proposals,
    [],
  );
});

test("stored part-payment and overpayment reasons parse", () => {
  assert.deepEqual(
    parseStoredMatchReasons([
      { code: "partial_open_balance", remaining: "1.0000" },
      { code: "on_account_remainder", remainder: "2.0000" },
    ]).map((reason) => reason.code),
    ["partial_open_balance", "on_account_remainder"],
  );
});

test("generic receipt and customer words do not manufacture counterparty confidence", () => {
  const scored = scoreLedgerCandidate(
    line({ postedOn: "2026-10-14", description: "Customer receipt partial" }),
    journal({ memo: "Customer payment", partyName: "Civic Authority" }),
  )!;
  assert.equal(scored.score, 68);
  assert.deepEqual(scored.reasons, [{ code: "exact_amount" }, { code: "date_lag", days: 4 }]);
  assert.ok(scored.score <= REVIEW_SCORE_CEILING);
});
