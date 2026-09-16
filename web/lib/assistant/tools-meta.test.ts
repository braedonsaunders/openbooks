import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

test("describe_capabilities is a public read tool", () => {
  const meta = read("./tools-meta.ts");
  assert.match(meta, /name: "describe_capabilities"/);
  assert.match(meta, /gate: \{ mode: "public" \}/);
  assert.match(meta, /category: "read"/);
});

test("the meta tool is mounted on chat and MCP", () => {
  const registry = read("./registry.ts");
  assert.match(registry, /from "\.\/tools-meta"/);
  assert.match(registry, /\.\.\.META_TOOLS/);
  const skillsTest = read("../mcp/skills.test.ts");
  assert.match(skillsTest, /\.\.\/assistant\/tools-meta\.ts/);
});

test("the capability playbook and steering prompt name the tool", () => {
  const skills = read("../mcp/skills.ts");
  assert.match(skills, /describe_capabilities/);
  const prompt = read("./system-prompt.ts");
  assert.match(prompt, /describe_capabilities/);
});

test("find_tools is a public core search tool", () => {
  const meta = read("./tools-meta.ts");
  assert.match(meta, /name: "find_tools"/);
  assert.match(meta, /tier: "core"/);
  assert.match(meta, /category: "search"/);
});

test("find_tools is mounted beside describe_capabilities and playbook-named", () => {
  const meta = read("./tools-meta.ts");
  assert.match(meta, /export const META_TOOLS: AssistantToolDef\[\] = \[describeCapabilities, findTools\]/);
  const skills = read("../mcp/skills.ts");
  assert.match(skills, /find_tools/);
});
