import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import type { generateText, LanguageModel } from "ai";

// Same module-graph shim as the other assistant tests: the title module is
// server-only, which plain node cannot import without it.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return {
        shortCircuit: true,
        format: "module",
        url: "data:text/javascript,export {}",
      };
    }
    return nextResolve(specifier, context);
  },
});

const {
  TITLE_MAX_WORDS,
  TITLE_TIMEOUT_MS,
  cleanGeneratedTitle,
  generateConversationTitle,
  shouldAttemptAutoTitle,
} = await import("./conversation-title");
const { isMissingMetadataColumn } = await import("./conversation-memory");

const fakeModel = {} as LanguageModel;

function stubGenerateText(text: string): typeof generateText {
  return (async () => ({ text })) as unknown as typeof generateText;
}

function failingGenerateText(): typeof generateText {
  return (async () => {
    throw new Error("provider down");
  }) as unknown as typeof generateText;
}

function hangingGenerateText(): typeof generateText {
  return (() => new Promise(() => {})) as unknown as typeof generateText;
}

test("contract constants: at most six words, ten-second hard timeout", () => {
  assert.equal(TITLE_MAX_WORDS, 6);
  assert.equal(TITLE_TIMEOUT_MS, 10_000);
});

test("cleanGeneratedTitle trims chatter to six plain words", () => {
  assert.equal(
    cleanGeneratedTitle("Overdue vendor bills summary and next steps here"),
    "Overdue vendor bills summary and next",
  );
  assert.equal(cleanGeneratedTitle('  "Quarterly payroll review."  '), "Quarterly payroll review");
  assert.equal(cleanGeneratedTitle("Cash position\nsecond line"), "Cash position");
  assert.equal(cleanGeneratedTitle("one two three four five six"), "one two three four five six");
});

test("cleanGeneratedTitle rejects the unusable", () => {
  assert.equal(cleanGeneratedTitle("   "), null);
  assert.equal(cleanGeneratedTitle(""), null);
  assert.equal(cleanGeneratedTitle(null), null);
  assert.equal(cleanGeneratedTitle(42), null);
  assert.equal(cleanGeneratedTitle("x".repeat(200)), null);
});

test("shouldAttemptAutoTitle: only the first turn, never over a user rename", () => {
  assert.equal(shouldAttemptAutoTitle(null, 1), false);
  assert.equal(shouldAttemptAutoTitle({ title: "t", source: "user" }, 1), false);
  assert.equal(shouldAttemptAutoTitle({ title: "t", source: "auto" }, 1), true);
  assert.equal(shouldAttemptAutoTitle({ title: "t", source: null }, 1), true);
  assert.equal(shouldAttemptAutoTitle({ title: "t", source: null }, 2), false);
  assert.equal(shouldAttemptAutoTitle({ title: "t", source: "auto" }, 0), false);
});

test("generateConversationTitle cleans a good model reply", async () => {
  const title = await generateConversationTitle({
    model: fakeModel,
    prompt: "How did we do last month?",
    assistantContent: "Revenue was up 12% …",
    generate: stubGenerateText('" March close checklist and review notes today "'),
  });
  assert.equal(title, "March close checklist and review notes");
});

test("generateConversationTitle sends a bounded, vendor-neutral request", async () => {
  let seen: Parameters<typeof generateText>[0] | undefined;
  const capture = (async (args: Parameters<typeof generateText>[0]) => {
    seen = args;
    return { text: "Vendor aging follow-up" };
  }) as unknown as typeof generateText;
  const title = await generateConversationTitle({
    model: fakeModel,
    prompt: "Which vendors do we owe?",
    assistantContent: "Three vendors past 90 days …",
    generate: capture,
  });
  assert.equal(title, "Vendor aging follow-up");
  assert.ok(seen);
  assert.equal(seen.maxOutputTokens, 32);
  if (typeof seen.prompt !== "string") throw new Error("expected a string title prompt");
  if (typeof seen.system !== "string") throw new Error("expected a string title system prompt");
  assert.match(seen.prompt, /Which vendors do we owe\?/);
  assert.match(seen.prompt, /Three vendors past 90 days/);
  assert.doesNotMatch(seen.system, /claude|gpt|gemini|openai|anthropic|mistral|llama|grok|deepseek/i);
});

test("generateConversationTitle keeps the placeholder on any failure", async () => {
  assert.equal(
    await generateConversationTitle({
      model: fakeModel,
      prompt: "hi",
      assistantContent: "hello",
      generate: failingGenerateText(),
    }),
    null,
  );
  assert.equal(
    await generateConversationTitle({
      model: fakeModel,
      prompt: "hi",
      assistantContent: "hello",
      generate: stubGenerateText("   "),
    }),
    null,
  );
});

test("generateConversationTitle gives up after the hard timeout", async () => {
  const started = Date.now();
  const title = await generateConversationTitle({
    model: fakeModel,
    prompt: "hi",
    assistantContent: "hello",
    timeoutMs: 5,
    generate: hangingGenerateText(),
  });
  assert.equal(title, null);
  assert.ok(Date.now() - started < 5_000);
});

test("missing-metadata detection matches the memory-column shape", () => {
  assert.equal(
    isMissingMetadataColumn({ code: "42703", message: 'column "metadata" of relation does not exist' }),
    true,
  );
  assert.equal(
    isMissingMetadataColumn({ cause: { code: "42703", message: "no metadata here" } }),
    true,
  );
  assert.equal(isMissingMetadataColumn({ code: "23505", message: "duplicate metadata" }), false);
  assert.equal(isMissingMetadataColumn(new Error("boom")), false);
});
