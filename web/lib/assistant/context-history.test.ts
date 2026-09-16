import assert from "node:assert/strict";
import test from "node:test";
import {
  applyHistoryBudget,
  estimateHistoryTokens,
  HISTORY_SUMMARY_PREFIX,
  KEEP_FULL_ASSISTANT_TURNS,
  summarizeToolOutputForHistory,
} from "./context-history";

// Fixture: a long recorded-conversation shape (bench transcripts t1-cash,
// t1-topcust, …): alternating user prompts and assistant turns whose parts
// carry full-size tool outputs plus the prose answer.

type Part = { type: string; [key: string]: unknown };

function toolPart(name: string, output: unknown): Part {
  return {
    type: `tool-${name}`,
    toolCallId: `call-${name}`,
    state: "output-available",
    input: {},
    output,
  };
}

function textPart(text: string): Part {
  return { type: "text", text };
}

function textOf(part: Part): string {
  return typeof part.text === "string" ? part.text : "";
}

function cashPositionOutput() {
  // Realistic page: every bank/clearing account plus an 8-week forecast.
  const accounts = Array.from({ length: 12 }, (_, i) => ({
    id: `a${i}`,
    number: `${1000 + i * 5}`,
    name: `Operating account ${i} with a long descriptive name`,
    balance: `${(i * 1234.56).toFixed(2)}`,
    memo: "daily sweep, holds, and pending wires included in this balance",
  }));
  return {
    ok: true,
    data: {
      total: "-185754.98",
      accounts,
      forecast: Array.from({ length: 8 }, (_, i) => ({
        week: `2026-09-${15 + i * 7}`,
        inflow: `${(i * 40000).toFixed(2)}`,
        outflow: `${(i * 52000).toFixed(2)}`,
      })),
    },
  };
}

function concentrationOutput() {
  return {
    ok: true,
    data: {
      total: "10440000.00",
      items: [
        { party: "Customer A", revenue: "1427600.52" },
        { party: "Customer B", revenue: "1075861.35" },
        { party: "Customer C", revenue: "940732.98" },
      ],
    },
  };
}

function documentsOutput() {
  return {
    ok: true,
    data: {
      total: 3,
      sumTotal: "48210.55",
      sumOpenBalance: "12000.00",
      items: [
        { id: "11111111-1111-4111-8111-111111111111", kind: "bill", documentNumber: "BILL-0871" },
        { id: "22222222-2222-4222-8222-222222222222", kind: "bill", documentNumber: "BILL-0872" },
        { id: "33333333-3333-4333-8333-333333333333", kind: "bill", documentNumber: "BILL-0873" },
      ],
    },
  };
}

function assistantTurn(toolName: string, output: unknown, answer: string) {
  return { role: "assistant", parts: [toolPart(toolName, output), textPart(answer)] };
}

function longConversation() {
  const turns = [
    assistantTurn("cash_position", cashPositionOutput(), "Cash is negative $185,754.98 across 3 accounts."),
    assistantTurn("party_concentration", concentrationOutput(), "Top customer is Customer A at 13.7%."),
    assistantTurn("find_documents", documentsOutput(), "Found 3 bills totalling $48,210.55."),
    assistantTurn("profit_and_loss", {
      ok: true,
      data: {
        total: "921000.44",
        lines: Array.from({ length: 20 }, (_, i) => ({
          account: `Revenue line ${i}`,
          current: `${(i * 9911.11).toFixed(2)}`,
          prior: `${(i * 8800.22).toFixed(2)}`,
        })),
      },
    }, "Net income is $921,000.44."),
    assistantTurn("rank_projects", {
      ok: true,
      data: {
        total: 12,
        projects: Array.from({ length: 12 }, (_, i) => ({
          id: `p${i}`,
          name: `Construction job ${i} — phase two extension`,
          margin: `${(i * 1500.5).toFixed(2)}`,
        })),
      },
    }, "12 projects; worst margin is Job X."),
    assistantTurn("tax_return", {
      ok: true,
      data: {
        total: "44120.10",
        boxes: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`box${i}`, `${i * 111.11}`])),
      },
    }, "Return total is $44,120.10."),
  ];
  const messages: { role: string; parts: Part[] }[] = [];
  turns.forEach((turn, i) => {
    messages.push({ role: "user", parts: [textPart(`question ${i + 1}`)] });
    messages.push(turn);
  });
  return messages;
}

test("older assistant tool parts compact to summaries while recent turns stay full", () => {
  const before = longConversation();
  const snapshot = JSON.stringify(before);
  const after = applyHistoryBudget(before);

  const assistantAfter = after.filter((m) => m.role === "assistant");
  assert.equal(assistantAfter.length, 6);
  // Last N turns keep their full tool parts.
  for (const recent of assistantAfter.slice(-KEEP_FULL_ASSISTANT_TURNS)) {
    assert.ok(recent.parts.some((p) => String(p.type).startsWith("tool-")), "recent turn lost tool parts");
  }
  // Older turns carry no tool parts — only text (answer + one summary).
  for (const old of assistantAfter.slice(0, -KEEP_FULL_ASSISTANT_TURNS)) {
    assert.ok(old.parts.every((p) => p.type === "text"), "old turn still has tool parts");
    assert.ok(
      old.parts.some((p) => textOf(p).startsWith(HISTORY_SUMMARY_PREFIX)),
      "old turn has no history summary",
    );
  }
  // Full parts stay persisted: the input is never mutated.
  assert.equal(JSON.stringify(before), snapshot);
});

test("history summaries preserve key figures and prose answers", () => {
  const after = applyHistoryBudget(longConversation());
  const first = after.filter((m) => m.role === "assistant")[0]!;
  const texts = first.parts.map((p) => textOf(p));
  assert.ok(texts.some((t) => t.includes("Cash is negative $185,754.98")), "prose answer dropped");
  const summary = texts.find((t) => t.startsWith(HISTORY_SUMMARY_PREFIX))!;
  assert.match(summary, /cash_position/);
  assert.match(summary, /-185754\.98/);
});

test("compaction measurably shrinks a long conversation", () => {
  const before = longConversation();
  const after = applyHistoryBudget(before);
  const beforeTokens = estimateHistoryTokens(before);
  const afterTokens = estimateHistoryTokens(after);
  console.log(`[history-budget] before=${beforeTokens}t after=${afterTokens}t`);
  assert.ok(beforeTokens > 500, `fixture too small to prove anything (${beforeTokens}t)`);
  assert.ok(afterTokens <= beforeTokens * 0.6, `no real saving: ${beforeTokens}t -> ${afterTokens}t`);
});

test("summarizeToolOutputForHistory surfaces totals and row counts", () => {
  const summary = summarizeToolOutputForHistory(documentsOutput());
  assert.match(summary, /total:? 3/i);
  assert.match(summary, /48210\.55/);
  assert.match(summary, /3 rows?/);
});

test("summarizeToolOutputForHistory reports errors instead of figures", () => {
  assert.match(summarizeToolOutputForHistory({ ok: false, error: "forbidden" }), /error: forbidden/);
});

test("summarizeToolOutputForHistory caps pathological outputs", () => {
  const huge = summarizeToolOutputForHistory({ ok: true, data: { blob: "x".repeat(10_000) } });
  assert.ok(huge.length <= 300, `summary not capped (${huge.length} chars)`);
});

test("short conversations pass through untouched", () => {
  const messages = [
    { role: "user", parts: [textPart("hi")] },
    { role: "assistant", parts: [toolPart("whoami", { ok: true }), textPart("hello")] },
  ];
  assert.deepEqual(applyHistoryBudget(messages), messages);
});
