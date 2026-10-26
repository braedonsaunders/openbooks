import assert from "node:assert/strict";
import test from "node:test";
import type { EvidenceFormatters } from "./evidence-format";
import { EVIDENCE_MISSING, formatHistory, formatStatementEvidence } from "./evidence-format";

const formatters: EvidenceFormatters = {
  money: (value) => `$${value}`,
  count: (value) => String(value),
  civilDate: (value) => `date:${value}`,
  timestamp: (value) => `ts:${value}`,
  source: (value) => value.toUpperCase(),
  status: (value) => `status:${value}`,
};

const statement = {
  id: "stmt-1",
  source: "csv",
  statementDate: "2026-03-31",
  importedAt: "2026-04-01T12:00:00.000Z",
  openingBalance: "100.0000",
  closingBalance: null,
  windowLines: 4,
  matchedLines: 2,
  excludedLines: 1,
  unmatchedLines: 1,
  windowTotal: "250.5000",
};

test("each excluded line sits under the statement that carries it, with its reason and duplicate reference", () => {
  const rows = formatStatementEvidence(
    {
      statements: [
        statement,
        {
          ...statement,
          id: "stmt-2",
          statementDate: "2026-03-31",
          windowLines: 0,
          matchedLines: 0,
          excludedLines: 0,
          unmatchedLines: 0,
          windowTotal: "0",
        },
      ],
      excludedLines: [
        {
          id: "line-1",
          statementId: "stmt-1",
          postedOn: "2026-03-30",
          amount: "-42.1000",
          description: "Card fee",
          exclusionReason: "Duplicate of the earlier fee",
          excludedAt: "2026-04-02T09:30:00.000Z",
          excludedByName: "Dana",
          possibleDuplicateOf: { postedOn: "2026-03-30", amount: "-42.1000" },
        },
      ],
    },
    formatters,
  );

  assert.equal(rows.length, 2, "both same-date statements are listed");
  assert.equal(rows[0]!.id, "stmt-1");
  assert.equal(rows[0]!.statementDate, "date:2026-03-31");
  assert.equal(rows[0]!.source, "CSV");
  assert.equal(rows[0]!.openingBalance, "$100.0000");
  assert.equal(
    rows[0]!.closingBalance,
    EVIDENCE_MISSING,
    "an absent closing balance is never guessed",
  );
  assert.equal(rows[0]!.windowLines, "4");
  assert.equal(rows[0]!.excluded.length, 1);
  assert.deepEqual(rows[0]!.excluded[0], {
    id: "line-1",
    postedOn: "date:2026-03-30",
    amount: "$-42.1000",
    description: "Card fee",
    reason: "Duplicate of the earlier fee",
    duplicateOf: { postedOn: "date:2026-03-30", amount: "$-42.1000" },
    excludedBy: "Dana",
    excludedAt: "ts:2026-04-02T09:30:00.000Z",
  });
  assert.deepEqual(rows[1]!.excluded, [], "a statement without excluded lines carries none");
});

test("an excluded line naming a statement outside the evidence refuses instead of being dropped", () => {
  assert.throws(
    () =>
      formatStatementEvidence(
        {
          statements: [statement],
          excludedLines: [
            {
              id: "line-x",
              statementId: "stmt-missing",
              postedOn: "2026-03-30",
              amount: "1.0000",
              description: null,
              exclusionReason: "Stray exclusion",
              excludedAt: null,
              excludedByName: null,
              possibleDuplicateOf: null,
            },
          ],
        },
        formatters,
      ),
    /outside the reconciliation evidence/,
  );
});

test("history rows keep the prior signed balance and reason of a withdrawn sign-off", () => {
  const rows = formatHistory(
    [
      {
        kind: "sign_off",
        at: "2026-04-05T10:00:00.000Z",
        actorName: "Ana",
        evidenceKind: "statement",
        throughDate: "2026-03-31",
        currency: "CAD",
        statementBalance: "30700.0200",
        matchedJournalLines: 12,
        excludedStatementLines: 1,
      },
      {
        kind: "withdraw_sign_off",
        at: "2026-04-06T10:00:00.000Z",
        actorName: "Ben",
        reason: "Late cheque belongs in March",
        throughDate: "2026-03-31",
        currency: "CAD",
        priorStatementBalance: "30700.0200",
        priorSignedOffAt: "2026-04-05 10:00:00+00",
        priorSignedOffByName: "Ana",
        releasedJournalLines: 12,
        status: "in_progress",
      },
      {
        kind: "session_adjustment",
        at: "2026-04-07T10:00:00.000Z",
        actorName: null,
        before: {
          throughDate: "2026-03-31",
          statementBalance: "30700.0200",
          status: "in_progress",
        },
        after: { throughDate: "2026-03-31", statementBalance: "29780.0200", status: null },
      },
    ],
    formatters,
  );

  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0]!.event, {
    kind: "sign_off",
    evidence: "statement",
    throughDate: "date:2026-03-31",
    statementBalance: "$30700.0200",
    matchedJournalLines: "12",
    excludedStatementLines: "1",
  });
  assert.equal(rows[1]!.actor, "Ben");
  assert.deepEqual(rows[1]!.event, {
    kind: "withdraw_sign_off",
    reason: "Late cheque belongs in March",
    throughDate: "date:2026-03-31",
    priorStatementBalance: "$30700.0200",
    priorSignedOffAt: "ts:2026-04-05 10:00:00+00",
    priorSignedOffBy: "Ana",
    releasedJournalLines: "12",
    status: "status:in_progress",
  });
  assert.equal(rows[2]!.actor, EVIDENCE_MISSING);
  assert.deepEqual(rows[2]!.event, {
    kind: "session_adjustment",
    before: {
      throughDate: "date:2026-03-31",
      statementBalance: "$30700.0200",
      status: "status:in_progress",
    },
    after: {
      throughDate: "date:2026-03-31",
      statementBalance: "$29780.0200",
      status: EVIDENCE_MISSING,
    },
  });
});

test("a discard row with a missing count shows an em dash and no zero", () => {
  const [row] = formatHistory(
    [
      {
        kind: "discard",
        at: "2026-04-08T10:00:00.000Z",
        actorName: "Cy",
        throughDate: "2026-04-30",
        currency: "CAD",
        statementBalance: "500.0000",
        releasedMatches: null,
        releasedStatementLines: 3,
      },
    ],
    formatters,
  );
  assert.deepEqual(row!.event, {
    kind: "discard",
    throughDate: "date:2026-04-30",
    statementBalance: "$500.0000",
    releasedMatches: EVIDENCE_MISSING,
    releasedStatementLines: "3",
  });
});
