import type { DocArticle } from '../types'

export const appAssistantTools: DocArticle = {
  slug: 'app-assistant-tools',
  title: 'Apps can declare assistant tools',
  category: 'apps',
  order: 4,
  summary:
    'Installed apps may expose their own governed assistant and MCP tools, served by their backend endpoints under the same budget, permissions, and evidence as every other app action.',
  updated: '2026-09-16',
  related: ['apps', 'app-builder', 'app-api-reference', 'mcp-control'],
  keywords: ['apps', 'assistant tools', 'manifest tools', 'backend endpoints', 'confirmation', 'capabilities'],
  body: `# Apps can declare assistant tools

An installed app may expose its own capabilities to the assistant and to MCP
clients by declaring tools in its manifest. Each tool names one of the app
backend endpoints that serves it, describes a bounded object input schema,
and lists the permissions it needs. Once installed, the tool appears beside
the built-in tools for every actor who holds those permissions, named
app_<app-key>_<tool-key>, with the app name prefixed to its description.

## Declaring a tool

A tools entry carries a key, a title, and a description for the model, the
name of an already-declared backend endpoint as its handler, a readOnly flag,
and the permissions the tool needs. The input schema is a plain object schema
with properties: text fields carry a maximum length, lists carry a maximum
item count, enumerations stay small, and patterns avoid constructs strict
validators reject. The install review rejects anything outside that contract
with a precise error, before anything is written.

## Governance

A declared tool never widens access. It runs only while the app is installed
and enabled, only for callers who may use apps, and only when every required
permission is both granted to the app and held by the calling user — the same
intersection the app frontend bridge enforces. The handler runs in the app
sandbox with the usual governance budget, and every invocation writes the
same run evidence as a backend call, so the run history shows assistant use
exactly like frontend use.

Read tools answer directly. A tool that changes data always returns a review
card first and changes nothing until the user confirms it, exactly like every
other governed write in the assistant. On the programmatic surface the same
tool executes directly under the caller key, matching the rest of that
catalog.

## Authoring guidance

Declare one flexible tool per capability family rather than many one-off
tools, keep responses compact — small rows, totals, and a truncated flag
rather than whole tables — and prefer the shared record and query surfaces
over app-private stores for data the organization already owns elsewhere.
The New-app starter ships with one sample read tool; replace it with a real
capability or remove it before publishing.
`,
}
