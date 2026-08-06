import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { ZodError, z } from "zod";
import { ApplicationError } from "../application/errors";
import { AssistantToolFailure, mapMcpError, mcpErrorStatus } from "./errors";
import { MCP_SKILLS } from "./skills";

/**
 * The skill pack's authoring rule, enforced: every snake_case identifier a
 * playbook mentions must be a real tool on this surface (or a named non-tool
 * term). A playbook that teaches a capability that does not exist is a
 * defect, and prose drifts unless a test fails. Tool names are read from the
 * catalog sources (the registration files import server-only code, so this
 * gate follows the repo's source-contract pattern).
 */

const here = import.meta.dirname;

function toolNamesFrom(...relativePaths: string[]): Set<string> {
  const names = new Set<string>();
  for (const relativePath of relativePaths) {
    const source = readFileSync(join(here, relativePath), "utf8");
    for (const match of source.matchAll(/name: ["'`]?\$?\{?["'`]?([a-z0-9_]+)["'`]/g)) {
      if (match[1]) names.add(match[1]);
    }
    // Template-built names, e.g. `${action}_document` over ["submit", "post"].
    for (const match of source.matchAll(/`\$\{action\}_document`/g)) {
      void match;
      names.add("submit_document");
      names.add("post_document");
    }
    for (const match of source.matchAll(/(\w+): \[["']([a-z0-9_]+)["'],/g)) {
      if (match[2]) names.add(match[2]);
    }
  }
  return names;
}

const TOOL_NAMES = toolNamesFrom(
  "../application/tool-catalog.ts",
  "../assistant/tools.ts",
  "../assistant/tools-write.ts",
);

// Snake_case terms in playbook prose that are deliberately not tool names.
const NON_TOOL_TERMS = new Set([
  "vendor_payment", // payment kinds (create_payment input)
  "customer_payment",
  "same_currency", // settlementRateSource value
  "invalid_input", // error code agents will see
]);

const SNAKE_CASE = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g;

test("every snake_case identifier in a skill is a real tool or a named term", () => {
  assert.ok(TOOL_NAMES.size >= 20, `catalog extraction looks broken (${TOOL_NAMES.size} names)`);
  for (const skill of MCP_SKILLS) {
    const mentioned = skill.body.match(SNAKE_CASE) ?? [];
    assert.ok(mentioned.length > 0, `skill "${skill.slug}" names no tools at all`);
    for (const token of mentioned) {
      assert.ok(
        TOOL_NAMES.has(token) || NON_TOOL_TERMS.has(token),
        `skill "${skill.slug}" mentions "${token}", which is neither a registered tool nor a named non-tool term`,
      );
    }
  }
});

test("skills are unique, resource-addressable, and non-empty", () => {
  const slugs = new Set(MCP_SKILLS.map((skill) => skill.slug));
  assert.equal(slugs.size, MCP_SKILLS.length);
  for (const skill of MCP_SKILLS) {
    assert.match(skill.slug, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    assert.ok(skill.body.length > 200, `skill "${skill.slug}" is suspiciously short`);
    assert.ok(!skill.body.includes("```"), `skill "${skill.slug}" uses code fences`);
  }
});

test("the tools the playbooks depend on are registered with the right shape", () => {
  const catalogSource = readFileSync(join(here, "../application/tool-catalog.ts"), "utf8");
  const vitals = catalogSource.match(/name: "get_vitals"[\s\S]{0,600}?readOnly: (\w+)/);
  assert.ok(vitals, "get_vitals is registered in the application catalog");
  assert.equal(vitals[1], "true", "get_vitals must be read-only");

  const toolsSource = readFileSync(join(here, "../assistant/tools.ts"), "utf8");
  const openItems = toolsSource.match(/name: "list_open_items"[\s\S]{0,400}?category: "(\w+)"/);
  assert.ok(openItems, "list_open_items is registered as an assistant tool");
  assert.equal(openItems[1], "read");
  assert.match(toolsSource, /listOpenItems,/, "list_open_items is exported in READ_TOOLS");
});

test("error mapping surfaces safe shapes and hides the rest", () => {
  const application = mapMcpError(
    new ApplicationError("conflict", "period is locked", 409, { periodId: "p1" }),
  );
  assert.deepEqual(application, {
    code: "conflict",
    message: "period is locked",
    details: { periodId: "p1" },
  });
  assert.equal(
    mcpErrorStatus(new ApplicationError("conflict", "period is locked", 409)),
    409,
  );

  const assistant = mapMcpError(new AssistantToolFailure("forbidden"));
  assert.deepEqual(assistant, { code: "forbidden", message: "forbidden" });
  assert.equal(mcpErrorStatus(new AssistantToolFailure("forbidden")), 403);

  let zodError: ZodError | null = null;
  try {
    z.object({ amount: z.string() }).parse({ amount: 5 });
  } catch (error) {
    zodError = error as ZodError;
  }
  assert.ok(zodError);
  const mapped = mapMcpError(zodError);
  assert.equal(mapped?.code, "invalid_input");
  assert.equal(mcpErrorStatus(zodError), 422);

  assert.equal(mapMcpError(new Error("SELECT * FROM secrets")), null);
  assert.equal(mcpErrorStatus(new Error("boom")), 500);
});
