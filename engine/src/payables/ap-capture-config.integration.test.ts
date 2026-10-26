import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { sealSecret } from "../platform/secrets.ts";
import { DocumentEndpointError } from "./document-capture-azure.ts";
import { createScratchOrg, dropScratchOrg } from "../testing/fixtures.ts";
import { getLlmCaptureTestConfig } from "./ap-capture-config.ts";

// The capture test reads the AI provider section as typed, before it is
// saved: a typed key is used and never stored, a saved key travels only to
// the provider it was saved for, and a typed base URL passes the same
// public-address check as a saved one.
async function settings(orgId: string): Promise<unknown> {
  return (
    await db.execute<{ ai: unknown }>(
      sql`select settings->'ai' as ai from orgs where id = ${orgId}`,
      "objects",
    )
  )[0]?.ai;
}

test("the AI capture test uses the typed provider settings without storing them", async () => {
  const org = await createScratchOrg();
  try {
    await db.execute(sql`
      update orgs set settings = coalesce(settings, '{}'::jsonb) || jsonb_build_object('ai', ${JSON.stringify(
        {
          enabled: true,
          provider: "anthropic",
          modelSmart: "claude-sonnet-4-6",
          keyEncrypted: sealSecret("sk-ant-saved", {
            orgId: org.orgId,
            purpose: "assistant.ai.key",
          }),
          documentCapture: {
            enabled: true,
            provider: "llm_vision",
            model: "",
            confidenceThreshold: "0.8000",
          },
        },
      )}::jsonb)
       where id = ${org.orgId}`);
    const before = await settings(org.orgId);

    const saved = await getLlmCaptureTestConfig(org.orgId, {});
    assert.deepEqual(saved, {
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      baseUrl: null,
      apiKey: "sk-ant-saved",
    });

    const typed = await getLlmCaptureTestConfig(org.orgId, {
      provider: "openai",
      apiKey: "sk-typed",
      modelSmart: "gpt-4o",
    });
    assert.deepEqual(typed, {
      provider: "openai",
      model: "gpt-4o",
      baseUrl: null,
      apiKey: "sk-typed",
    });

    assert.equal(
      await getLlmCaptureTestConfig(org.orgId, { provider: "openai" }),
      null,
      "a key saved for Anthropic never travels to OpenAI",
    );
    assert.equal(
      await getLlmCaptureTestConfig(org.orgId, { provider: "deepseek", apiKey: "sk-typed" }),
      null,
      "a provider that reads no images has nothing to test",
    );

    const custom = await getLlmCaptureTestConfig(
      org.orgId,
      {
        provider: "custom",
        apiKey: "sk-typed",
        baseUrl: "https://llm.example.com/v1",
        modelSmart: "llava",
      },
      async () => ["93.184.216.34"],
    );
    assert.deepEqual(custom, {
      provider: "custom",
      model: "llava",
      baseUrl: "https://llm.example.com/v1",
      apiKey: "sk-typed",
    });
    await assert.rejects(
      getLlmCaptureTestConfig(
        org.orgId,
        {
          provider: "custom",
          apiKey: "sk-typed",
          baseUrl: "https://internal.example.com/v1",
          modelSmart: "llava",
        },
        async () => ["10.0.0.8"],
      ),
      (error: unknown) =>
        error instanceof DocumentEndpointError &&
        /did not resolve to a public address/.test(error.message) &&
        !error.message.includes("sk-typed"),
    );
    await assert.rejects(
      getLlmCaptureTestConfig(org.orgId, {
        provider: "custom",
        apiKey: "sk-typed",
        baseUrl: "http://llm.example.com/v1",
        modelSmart: "llava",
      }),
      (error: unknown) =>
        error instanceof DocumentEndpointError && /must use HTTPS/.test(error.message),
    );
    assert.deepEqual(await settings(org.orgId), before, "testing stores nothing");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
