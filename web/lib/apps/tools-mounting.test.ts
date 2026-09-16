// Run with:  node --import tsx --test web/lib/apps/tools-mounting.test.ts   (from repo root)
//
// Source-contract tests for dynamic mounting of App-declared tools: the chat
// registry, the MCP server, the skill-pack gate, and the system prompt. The
// registry/MCP import chains are server-only, so the wiring is guarded
// textually here and proven behaviorally by the integration test.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const registry = read('../assistant/registry.ts')
const chatRoute = read('../../app/api/assistant/chat/route.ts')
const mcpServer = read('../mcp/server.ts')
const skillsTest = read('../mcp/skills.test.ts')
const skills = read('../mcp/skills.ts')
const prompt = read('../assistant/system-prompt.ts')

test('the chat registry appends installed app tools after the static catalogs', () => {
  assert.match(registry, /export async function buildToolRegistryAsync/)
  assert.match(registry, /listAppToolViews\(authz\.user\.orgId, authz, features\)/)
  assert.match(registry, /if \(taken\.has\(view\.name\)\) continue/)
  assert.match(registry, /if \(!canRunTool\(authz, def, features\)\) continue/)
  // The route builds the two-stage turn; buildChatTurn is the one place that
  // calls buildToolRegistryAsync, so app tools ride along with the same gates.
  assert.match(chatRoute, /await buildChatTurn\(authz, features, prompt, priorNames\)/)
  assert.match(registry, /export async function buildChatTurn/)
  assert.match(registry, /const tools = await buildToolRegistryAsync\(authz, features, \{/)
})

test('named app-tool execution resolves through the same gated path', () => {
  assert.match(registry, /if \(name\.startsWith\("app_"\)\)/)
  assert.match(registry, /views\.find\(\(v\) => v\.name === name\)/)
})

test('the MCP server registers installed app tools for the same actor', () => {
  assert.match(mcpServer, /listAppToolViews\(/)
  assert.match(mcpServer, /registerToolCatalog\(server, await appCatalog\(context, features\), options\)/)
  assert.match(mcpServer, /canRunTool\(candidate\.authz, definition, features\)/)
})

test('the skill-pack gate scrapes the app-tools file and the playbook names app tools', () => {
  assert.match(skillsTest, /"\.\.\/apps\/tools\.ts"/)
  assert.match(skills, /app_<app-key>_<tool-key>/)
})

test('the system prompt steers the model toward installed app tools', () => {
  assert.match(prompt, /Installed apps may declare their own assistant tools/)
})
