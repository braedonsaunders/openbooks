import assert from "node:assert/strict";
import test from "node:test";
import {
  assertLlmReadable,
  extractJsonObject,
  readLlmField,
  requestLlmVision,
  testLlmDocumentProvider,
  type LlmVisionConfig,
} from "./document-capture-llm.ts";
import { extractLlmInvoice, normalizeLlmInvoice, validateNormalizedCapture } from "./ap-capture.ts";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

type Captured = {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
  redirect: RequestRedirect | undefined;
};

function capture(answer: unknown, sink: Captured[], status = 200): typeof fetch {
  return async (url, init) => {
    sink.push({
      url: String(url),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      redirect: init?.redirect,
    });
    return Response.json(answer, { status });
  };
}

test("the first balanced JSON object is read from fenced or chatty answers", () => {
  assert.deepEqual(extractJsonObject('```json\n{"a": 1}\n```'), { a: 1 });
  assert.deepEqual(
    extractJsonObject('Sure! {"note": "braces } in { strings", "n": {"x": 2}} and more {"b": 3}'),
    { note: "braces } in { strings", n: { x: 2 } },
  );
  assert.deepEqual(extractJsonObject('{"quote": "a \\"quoted\\" word"}'), {
    quote: 'a "quoted" word',
  });
  assert.equal(extractJsonObject("no object here"), null);
  assert.equal(extractJsonObject('{"unterminated": true'), null);
  assert.equal(extractJsonObject("{not json}"), null);
});

test("field confidence is bounded and a missing or impossible confidence reads as none", () => {
  assert.deepEqual(readLlmField({ value: " Acme ", confidence: 0.91 }), {
    value: "Acme",
    confidence: "0.9100",
    raw: "Acme",
  });
  assert.equal(readLlmField({ value: "Acme", confidence: 1.5 }).confidence, null);
  assert.equal(readLlmField({ value: "Acme", confidence: -0.1 }).confidence, null);
  assert.equal(readLlmField({ value: "Acme", confidence: "high" }).confidence, null);
  assert.equal(readLlmField({ value: "Acme" }).confidence, null);
  assert.equal(readLlmField({ value: "", confidence: 0.9 }).value, null);
  assert.equal(readLlmField("bare string").value, "bare string");
});

test("each provider kind receives its own request shape through a redirect-refusing transport", async () => {
  const sink: Captured[] = [];
  const answer = '{"ok": true}';
  await requestLlmVision({
    config: { provider: "anthropic", apiKey: "sk-ant", model: "claude-sonnet-4-6", baseUrl: null },
    prompt: "read",
    contentType: "application/pdf",
    bytes: PNG,
    fetchImpl: capture({ content: [{ type: "text", text: answer }] }, sink),
  });
  await requestLlmVision({
    config: { provider: "openai", apiKey: "sk-oa", model: "gpt-4o", baseUrl: null },
    prompt: "read",
    contentType: "application/pdf",
    bytes: PNG,
    fetchImpl: capture({ choices: [{ message: { content: answer } }] }, sink),
  });
  await requestLlmVision({
    config: { provider: "google", apiKey: "AIza", model: "gemini-2.5-pro", baseUrl: null },
    prompt: "read",
    contentType: "image/png",
    bytes: PNG,
    fetchImpl: capture({ candidates: [{ content: { parts: [{ text: answer }] } }] }, sink),
  });
  await requestLlmVision({
    config: {
      provider: "openrouter",
      apiKey: "sk-or",
      model: "openai/gpt-4o",
      baseUrl: "https://openrouter.ai/api/v1",
    },
    prompt: "read",
    contentType: "image/jpeg",
    bytes: PNG,
    fetchImpl: capture(
      { choices: [{ message: { content: [{ type: "text", text: answer }] } }] },
      sink,
    ),
  });
  const [anthropic, openai, google, router] = sink;
  assert.equal(anthropic!.url, "https://api.anthropic.com/v1/messages");
  assert.equal(anthropic!.headers.get("x-api-key"), "sk-ant");
  assert.equal(anthropic!.headers.get("anthropic-version"), "2023-06-01");
  const anthropicContent = (
    anthropic!.body.messages as Array<{ content: Array<Record<string, unknown>> }>
  )[0]!.content;
  assert.equal(anthropicContent[0]!.type, "document", "PDFs travel as documents");
  assert.equal(openai!.url, "https://api.openai.com/v1/chat/completions");
  assert.equal(openai!.headers.get("authorization"), "Bearer sk-oa");
  assert.deepEqual(openai!.body.response_format, { type: "json_object" });
  const openaiContent = (
    openai!.body.messages as Array<{ content: Array<Record<string, unknown>> }>
  )[0]!.content;
  assert.equal(openaiContent[1]!.type, "file");
  assert.match(
    String((openaiContent[1]!.file as Record<string, unknown>).file_data),
    /^data:application\/pdf;base64,/,
  );
  assert.equal(
    google!.url,
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent",
  );
  assert.equal(google!.headers.get("x-goog-api-key"), "AIza");
  assert.equal(router!.url, "https://openrouter.ai/api/v1/chat/completions");
  assert.equal(
    router!.body.response_format,
    undefined,
    "compatible endpoints get no provider-specific options",
  );
  for (const call of sink)
    assert.equal(call.redirect, "error", "a key-bearing request never follows a redirect");
});

test("providers that cannot read a format refuse before any request", async () => {
  assert.throws(() => assertLlmReadable("deepseek", "image/png"), /cannot read document images/);
  assert.throws(
    () => assertLlmReadable("openrouter", "application/pdf"),
    /reads JPEG, PNG documents/,
  );
  assert.throws(() => assertLlmReadable("anthropic", "image/tiff"), /save this image\/tiff file/);
  await assert.rejects(
    requestLlmVision({
      config: {
        provider: "mistral",
        apiKey: "k",
        model: "pixtral-large-latest",
        baseUrl: "https://api.mistral.ai/v1",
      },
      prompt: "read",
      contentType: "application/pdf",
      bytes: PNG,
      fetchImpl: async () => {
        throw new Error("must not run");
      },
    }),
    /reads JPEG, PNG documents/,
  );
});

test("a configured endpoint's error body is never echoed; a built-in provider's message is", async () => {
  const custom: LlmVisionConfig = {
    provider: "custom",
    apiKey: "k",
    model: "m",
    baseUrl: "https://llm.example.com/v1",
  };
  await assert.rejects(
    requestLlmVision({
      config: custom,
      prompt: "read",
      contentType: "image/png",
      bytes: PNG,
      fetchImpl: async () => new Response("<html>internal secret</html>", { status: 500 }),
    }),
    (error: Error) => !error.message.includes("internal secret") && /HTTP 500/.test(error.message),
  );
  await assert.rejects(
    requestLlmVision({
      config: { provider: "openai", apiKey: "k", model: "gpt-4o", baseUrl: null },
      prompt: "read",
      contentType: "image/png",
      bytes: PNG,
      fetchImpl: async () =>
        Response.json({ error: { message: "Incorrect API key provided" } }, { status: 401 }),
    }),
    /Incorrect API key provided/,
  );
});

test("the live provider test proves the model reads an image and answers JSON", async () => {
  const ok = await testLlmDocumentProvider({
    config: { provider: "openai", apiKey: "k", model: "gpt-4o", baseUrl: null },
    fetchImpl: async () => Response.json({ choices: [{ message: { content: '{"ok": true}' } }] }),
  });
  assert.deepEqual(ok, { ok: true, message: "Connected — the model reads document images" });
  const prose = await testLlmDocumentProvider({
    config: { provider: "openai", apiKey: "k", model: "gpt-3.5-turbo", baseUrl: null },
    fetchImpl: async () => Response.json({ choices: [{ message: { content: "OK!" } }] }),
  });
  assert.equal(prose.ok, false);
  assert.match(prose.message, /choose a vision model/);
});

const invoiceAnswer = {
  vendorName: { value: "Northwind Supply", confidence: 0.97 },
  vendorTaxId: { value: "123456789RT0001", confidence: 0.6 },
  invoiceNumber: { value: "INV-1042", confidence: 0.95 },
  invoiceDate: { value: "2026-10-02", confidence: 0.93 },
  dueDate: { value: "2026-11-01", confidence: 0.91 },
  purchaseOrderNumber: { value: null, confidence: 0 },
  currency: { value: "cad", confidence: 0.9 },
  subtotal: { value: "200.00", confidence: 0.94 },
  taxTotal: { value: "26.00", confidence: 0.94 },
  total: { value: "226.00", confidence: 0.96 },
  memo: { value: null, confidence: 0 },
  lines: [
    {
      description: "Copper fittings",
      productCode: "CF-12",
      quantity: "4",
      unit: "ea",
      unitPrice: "25.00",
      amount: "100.00",
      taxAmount: "13.00",
      confidence: 0.92,
    },
    {
      description: "Delivery",
      productCode: null,
      quantity: null,
      unit: null,
      unitPrice: "100.00",
      amount: null,
      taxAmount: "13.00",
      confidence: 0.9,
    },
  ],
};

test("an AI invoice answer normalizes into the bill capture contract and blanks low-confidence headers", () => {
  const { normalized, issues, overallConfidence } = normalizeLlmInvoice(invoiceAnswer, "0.9000");
  assert.equal(normalized.vendorName, "Northwind Supply");
  assert.equal(normalized.currency, "CAD");
  assert.equal(normalized.vendorTaxId, null, "a 0.60 reading below 0.90 is not filled");
  assert.deepEqual(issues, [
    {
      code: "low_confidence",
      severity: "warning",
      field: "vendorTaxId",
      actual: "0.6000",
      expected: "0.9000",
    },
  ]);
  assert.equal(normalized.lines[1]!.quantity, "1.0000", "an absent quantity reads as one unit");
  assert.equal(
    normalized.lines[1]!.amount,
    "100.0000",
    "a line amount is derived only from its printed price and quantity",
  );
  assert.equal(overallConfidence, "0.9500");
  assert.deepEqual(validateNormalizedCapture(normalized, "0.9000"), []);
});

test("an unconfident required invoice field blocks review", async () => {
  const sink: Captured[] = [];
  const result = await extractLlmInvoice({
    config: { provider: "google", apiKey: "AIza", model: "gemini-2.5-pro", baseUrl: null },
    confidenceThreshold: "0.9000",
    contentType: "application/pdf",
    bytes: PNG,
    fetchImpl: capture(
      {
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify({
                    ...invoiceAnswer,
                    invoiceNumber: { value: "INV-1O42", confidence: 0.4 },
                  }),
                },
              ],
            },
          },
        ],
      },
      sink,
    ),
  });
  assert.equal(result.normalized.invoiceNumber, null);
  assert.ok(
    validateNormalizedCapture(result.normalized, "0.9000").some(
      (issue) => issue.code === "required_field" && issue.field === "invoiceNumber",
    ),
  );
  assert.ok(
    result.evidence.some(
      (field) => field.fieldKey === "invoiceNumber" && field.rawValue === "INV-1O42",
    ),
    "the reading is kept as evidence",
  );
});

test("the live provider test never echoes the key it was sent", async () => {
  const key = "sk-proj-0123456789abcdefSECRET";
  const result = await testLlmDocumentProvider({
    config: { provider: "openai", apiKey: key, model: "gpt-4o", baseUrl: null },
    fetchImpl: async () =>
      Response.json(
        {
          error: {
            message: `Incorrect API key provided: ${key}. Also ${key.slice(0, 12)}…${key.slice(-8)}`,
          },
        },
        { status: 401 },
      ),
  });
  assert.equal(result.ok, false);
  assert.match(result.message, /Incorrect API key provided/);
  assert.ok(!result.message.includes(key), "the whole key is never shown");
  assert.ok(
    !result.message.includes(key.slice(0, 12)) && !result.message.includes(key.slice(-8)),
    "nor a recognizable part of it",
  );
});
