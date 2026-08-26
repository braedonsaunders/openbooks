import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { describe, it, test } from "node:test";
import { fiscalContextFor } from "@openbooks/reports";
import { assistantSystemPrompt, fiscalCalendarLine } from "./system-prompt";

// An April-start org (the configuration that exposed the calendar-year YTD
// defect) must yield a prompt that states fiscal boundaries explicitly.

describe("assistantSystemPrompt fiscal context", () => {
  const fiscal = fiscalContextFor("2026-08-16", 4);
  const prompt = assistantSystemPrompt({
    orgName: "Northfield Services Inc",
    baseCurrency: "CAD",
    userName: "Alex",
    today: "2026-08-16",
    fiscal,
    canWrite: false,
  });

  it("states the fiscal year start month and exact FY boundaries", () => {
    assert.match(prompt, /fiscal year starts on April 1/);
    assert.match(prompt, /FY 2027 \(2026-04-01 – 2027-03-31\)/);
  });

  it("states fiscal YTD and the PYTD comparative with exact dates", () => {
    assert.match(prompt, /Fiscal year to date is 2026-04-01 – 2026-08-16/);
    assert.match(prompt, /PYTD\) is 2025-04-01 – 2025-08-16/);
  });

  it("declares relative period language fiscal by default and steers to presets", () => {
    assert.match(prompt, /Relative period language is FISCAL by default/);
    assert.match(prompt, /this_fiscal_year_to_date/);
  });

  it("steers analytics requests to the analytics_* dashboard tools", () => {
    assert.match(prompt, /analytics_\* dashboard tools/);
  });

  it("renders the current fiscal quarter", () => {
    assert.match(prompt, /fiscal quarter Q2 \(2026-07-01 – 2026-09-30\)/);
  });
});

describe("fiscalCalendarLine", () => {
  it("degenerates cleanly for a January (calendar-year) org", () => {
    const line = fiscalCalendarLine(fiscalContextFor("2026-08-16", 1));
    assert.match(line, /fiscal year starts on January 1/);
    assert.match(line, /FY 2026 \(2026-01-01 – 2026-12-31\)/);
  });
});

// Assistant modules import `server-only`, so the redirect contract runs in a
// child under React's server condition (same pattern as reports-posted.test.ts).
// A provider origin answering 307 with a cross-origin Location must be refused
// by BOTH guarded fetches — model discovery's fetchJson (API keys ride
// Authorization headers / the Google ?key= query) and boundedAiFetch (forwards
// SDK requests bearing the key): 307 preserves method AND body, so following it
// would hand tenant secrets to whichever host the Location names.
test("assistant credential fetches refuse a cross-origin redirect without leaking the key", () => {
  const source = `
    import assert from "node:assert/strict";
    import { createServer } from "node:http";

    let attackerRequests = 0;
    const attacker = createServer((req, res) => {
      attackerRequests += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "stolen-model" }] }));
    });
    await new Promise((resolve) => attacker.listen(0, "127.0.0.1", resolve));
    const attackerOrigin = \`http://127.0.0.1:\${attacker.address().port}\`;

    let respondWithRedirect = true;
    const redirectModes = [];
    const redirector = createServer((req, res) => {
      if (respondWithRedirect) {
        res.writeHead(307, { location: \`\${attackerOrigin}/credential-capture\` });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "gpt-4o-mini" }, { id: "gpt-4o" }] }));
    });
    await new Promise((resolve) => redirector.listen(0, "127.0.0.1", resolve));
    const redirectorOrigin = \`http://127.0.0.1:\${redirector.address().port}\`;

    // Remap the hardcoded OpenAI host onto the local redirector while recording
    // the exact redirect mode each request is issued with.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const requested = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (requested.host !== "api.openai.com") return originalFetch(input, init);
      redirectModes.push(init?.redirect);
      requested.protocol = "http:";
      requested.host = new URL(redirectorOrigin).host;
      return originalFetch(requested, init);
    };

    try {
      const { listModels } = await import("./web/lib/assistant/models.ts");
      const { boundedAiFetch } = await import("./web/lib/assistant/client.ts");

      await assert.rejects(
        listModels({ provider: "openai", apiKey: "sk-REDIRECT_PROOF" }),
        /fetch failed|redirect/i,
      );
      await assert.rejects(
        boundedAiFetch(\`\${redirectorOrigin}/v1/chat/completions\`, {
          method: "POST",
          headers: { Authorization: "Bearer sk-REDIRECT_PROOF" },
          body: JSON.stringify({ messages: [] }),
        }),
        /fetch failed|redirect/i,
      );
      assert.deepEqual(redirectModes, ["error"]);
      assert.equal(attackerRequests, 0, "the redirect target must never receive a request");

      // Happy path: with redirects out of the picture both guarded fetches work.
      respondWithRedirect = false;
      const models = await listModels({ provider: "openai", apiKey: "sk-HAPPY_PATH" });
      assert.deepEqual(models.map((m) => m.id), ["gpt-4o", "gpt-4o-mini"]);
      const completion = await boundedAiFetch(\`\${redirectorOrigin}/v1/chat/completions\`, {
        method: "POST",
        headers: { Authorization: "Bearer sk-HAPPY_PATH" },
        body: JSON.stringify({ messages: [] }),
      });
      assert.equal(completion.status, 200);
      assert.deepEqual(redirectModes, ["error", "error"]);
      assert.equal(attackerRequests, 0, "the API key must never leave for any third host");
    } finally {
      globalThis.fetch = originalFetch;
      await Promise.all([
        new Promise((resolve) => redirector.close(resolve)),
        new Promise((resolve) => attacker.close(resolve)),
      ]);
    }
  `;
  const result = spawnSync(
    process.execPath,
    ["--conditions=react-server", "--import", "tsx", "--input-type=module", "-e", source],
    { cwd: process.cwd(), env: process.env, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
