#!/usr/bin/env node
/**
 * Bypass-context justification gate.
 *
 * `withBypass` and `withBypassContext` lift tenant row-level security for
 * everything they run: every organization's rows become readable and
 * writable. That is correct in a handful of well-understood situations and a
 * cross-tenant leak everywhere else, and nothing at the call site says which
 * one a reader is looking at. This gate makes every production call state it.
 *
 * Each call must be preceded, within three lines, by a whole-line comment
 *
 *   // bypass: <reason> — <why this site needs every organization's rows>
 *
 * where <reason> is one of BYPASS_REASONS and the free text is required. An
 * unknown reason fails: a new category of bypass is a design decision that
 * belongs in this vocabulary, reviewed, not coined at a call site. A tag with
 * no call beneath it also fails, so a justification cannot outlive the code
 * it described.
 *
 * A reason fits only when the site needs rows of more than one organization,
 * or rows whose organization it cannot know yet. A site that already holds
 * its organization id and touches org-isolated tables needs no bypass: it
 * belongs in withOrgContext or withOrgTransaction.
 *
 * Calls that fit no reason are recorded in
 * check-bypass-justification.allowlist.json, keyed by (path, nearest named
 * enclosing function) with the number of untagged calls and why no reason
 * fits. The list may only shrink: an untagged call outside it fails, an entry
 * whose count no longer matches fails until it is corrected (so fixing a site
 * forces the entry down), and the listed calls may never exceed
 * ALLOWLIST_CEILING, so a new entry cannot be added to excuse a new call.
 *
 * Test files and the test fixture libraries (engine/src/testing, web/testing)
 * are out of scope; bypass use there
 * is governed by check-test-bypass-scope.
 *
 *   node scripts/check-bypass-justification.mjs
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const requireFromRoot = createRequire(new URL('../package.json', import.meta.url))
const ts = requireFromRoot('typescript')

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ALLOWLIST_PATH = 'scripts/check-bypass-justification.allowlist.json'
const SCAN_ROOTS = ['engine/src', 'web', 'packages', 'schema', 'scripts', 'integrations']
const SOURCE_FILE = /\.(?:[cm]?[jt]sx?)$/
const OUT_OF_SCOPE = /\.(?:test|spec)\.[cm]?[jt]sx?$|\.d\.[cm]?ts$|^engine\/src\/testing\/|^web\/testing\//

/**
 * Untagged calls the allowlist may hold. Lower it as entries are converted;
 * never raise it.
 */
export const ALLOWLIST_CEILING = 0

/** The helpers whose callbacks run with tenant RLS lifted. */
export const BYPASS_HELPERS = new Set(['withBypass', 'withBypassContext'])

/** How far above a call its justification may sit. */
export const TAG_WINDOW = 3

/** The only reasons a production bypass is legitimate, and what each covers. */
export const BYPASS_REASONS = new Map([
  ['identity-bootstrap', 'authentication state kept outside any organization (sessions, logins, MFA, password reset, API keys), and resolving which organization the caller acts in'],
  ['scheduler-tick', 'a background pass that scans every organization for due work, or claims, finalizes or recovers an item by id before its organization is known'],
  ['cross-org-by-design', 'the subject spans organizations: sandbox copies of production, platform administration and settings, installation-wide maintenance, isolation proofs'],
  ['connector-token', 'an inbound request authenticated by a connector credential, device or link token, or provider signature, whose organization is known only once that row is read'],
  ['user-keyed-lookup', 'a read keyed by the person rather than an organization: their preferences, memberships, and identity rows that may live in another organization'],
  ['public-token-lookup', 'an anonymous request resolves the owning organization from one public identifier (a posting id, careers slug, or payment-link token) by reading one row, then performs all further reads and writes in that organization’s scope'],
])

const TAG = /^\s*\/\/\s*bypass:\s*(.*)$/
// The reason ends at whitespace, a colon or a dash sign — never at one of its
// own hyphens, so a bare `scheduler-tick` is not read as `scheduler` + `tick`.
const TAG_BODY = /^([a-z]+(?:-[a-z]+)*)(?=$|[\s:—–])[\s:—–-]*(.*)$/

/** Parse a `// bypass:` line; null when the line is not a tag at all. */
export function parseTag(line) {
  const tag = TAG.exec(line)
  if (!tag) return null
  const body = TAG_BODY.exec(tag[1].trim()) ?? [null, tag[1].trim(), '']
  const reason = body[1]
  const why = body[2].trim()
  if (!BYPASS_REASONS.has(reason)) return { reason, error: `unknown bypass reason "${reason}"` }
  if (why === '') return { reason, error: `bypass reason "${reason}" says nothing about this site` }
  return { reason, why }
}

function functionNameOf(node) {
  if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name && ts.isIdentifier(node.name)) {
    return node.name.text
  }
  if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
      ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) {
    return node.parent.name.text
  }
  return undefined
}

/** Nearest NAMED enclosing function; anonymous callbacks resolve outward. */
function namedEnclosingFunction(node) {
  for (let current = node.parent; current; current = current.parent) {
    const name = functionNameOf(current)
    if (name) return name
  }
  return '(top-level)'
}

/** Local names bound to a bypass helper, including renamed imports. */
function helperBindings(source) {
  const names = new Set(BYPASS_HELPERS)
  for (const statement of source.statements) {
    const bindings = ts.isImportDeclaration(statement) ? statement.importClause?.namedBindings : undefined
    if (!bindings || !ts.isNamedImports(bindings)) continue
    for (const element of bindings.elements) {
      if (BYPASS_HELPERS.has((element.propertyName ?? element.name).text)) names.add(element.name.text)
    }
  }
  return names
}

/**
 * Audit one file's text. Returns tagged calls, untagged calls (the allowlist
 * candidates), and hard failures no allowlist can excuse: malformed or
 * unknown tags, orphaned tags, a helper passed around uncalled, and syntax
 * the parser could not read.
 */
export function auditSource(path, text) {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
  const lines = text.split('\n')
  const failures = []
  const tagged = []
  const untagged = []
  if (source.parseDiagnostics?.length) {
    failures.push({ path, line: 1, message: 'unparseable; the gate cannot see its bypass calls' })
    return { tagged, untagged, failures }
  }
  const names = helperBindings(source)
  const calledLines = []

  const visit = (node) => {
    if (ts.isIdentifier(node) && names.has(node.text)) {
      const parent = node.parent
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
      const member = ts.isPropertyAccessExpression(parent) && parent.name === node
      const called = (ts.isCallExpression(parent) && parent.expression === node) ||
        (member && ts.isCallExpression(parent.parent) && parent.parent.expression === parent)
      // Names that are not a reference to the helper binding: its own
      // declaration, import/export plumbing, and same-named object members.
      const notReference = member || ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent) ||
        ((ts.isFunctionDeclaration(parent) || ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent) ||
          ts.isPropertySignature(parent)) && parent.name === node)
      if (called) {
        calledLines.push(line)
        const site = { path, line, fn: namedEnclosingFunction(node) }
        const tag = lines.slice(Math.max(0, line - 1 - TAG_WINDOW), line - 1).map(parseTag).findLast(Boolean)
        if (!tag) untagged.push(site)
        else if (tag.error) failures.push({ ...site, message: tag.error })
        else tagged.push({ ...site, reason: tag.reason })
      } else if (!notReference) {
        failures.push({ path, line, message: `${node.text} is used without being called; call it where the bypass is justified` })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)

  // Only a tag naming a known reason can be orphaned; any other `// bypass:`
  // line is prose unless it sits above a call, where it is refused there.
  lines.forEach((text, index) => {
    const line = index + 1
    if (BYPASS_REASONS.has(parseTag(text)?.reason) && !calledLines.some((call) => call > line && call - line <= TAG_WINDOW)) {
      failures.push({ path, line, message: `bypass tag has no ${[...BYPASS_HELPERS].join('/')} call within ${TAG_WINDOW} lines below it` })
    }
  })
  return { tagged, untagged, failures }
}

export function loadAllowlist(readFile = (file) => readFileSync(join(ROOT, file), 'utf8')) {
  const entries = JSON.parse(readFile(ALLOWLIST_PATH))
  if (!Array.isArray(entries)) throw new Error(`${ALLOWLIST_PATH} must hold a JSON array`)
  if (ALLOWLIST_CEILING === 0 && entries.length > 0) {
    throw new Error(`${ALLOWLIST_PATH} must be empty when the allow-list ceiling is 0`)
  }
  const seen = new Set()
  for (const entry of entries) {
    const key = `${entry?.path}::${entry?.fn}`
    if (typeof entry?.path !== 'string' || typeof entry?.fn !== 'string' || !Number.isInteger(entry?.calls) || entry.calls < 1) {
      throw new Error(`${ALLOWLIST_PATH}: every entry needs string "path" and "fn" and a positive integer "calls"`)
    }
    if (typeof entry.finding !== 'string' || entry.finding.trim() === '') {
      throw new Error(`${ALLOWLIST_PATH}: ${key} does not say why no bypass reason fits`)
    }
    if (seen.has(key)) throw new Error(`${ALLOWLIST_PATH} lists ${key} twice`)
    seen.add(key)
  }
  return entries
}

/** Split untagged calls against the allowlist; both directions of the ratchet fail. */
export function reconcile(untagged, allowlist) {
  const counts = new Map()
  for (const site of untagged) {
    const key = `${site.path}::${site.fn}`
    counts.set(key, [...(counts.get(key) ?? []), site])
  }
  const unlisted = []
  const miscounted = []
  for (const [key, sites] of counts) {
    const entry = allowlist.find((candidate) => `${candidate.path}::${candidate.fn}` === key)
    if (!entry) unlisted.push(...sites)
    else if (entry.calls !== sites.length) miscounted.push({ ...entry, found: sites.length })
  }
  for (const entry of allowlist) {
    if (!counts.has(`${entry.path}::${entry.fn}`)) miscounted.push({ ...entry, found: 0 })
  }
  return { unlisted, miscounted }
}

function productionSources() {
  return execFileSync('git', ['ls-files', '-z', '--', ...SCAN_ROOTS], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\0')
    .filter((file) => SOURCE_FILE.test(file) && !OUT_OF_SCOPE.test(file))
}

function main() {
  const files = productionSources()
  const tagged = []
  const untagged = []
  const failures = []
  for (const file of files) {
    const result = auditSource(file, readFileSync(join(ROOT, file), 'utf8'))
    tagged.push(...result.tagged)
    untagged.push(...result.untagged)
    failures.push(...result.failures)
  }
  const allowlist = loadAllowlist()
  const listed = allowlist.reduce((total, entry) => total + entry.calls, 0)
  if (listed > ALLOWLIST_CEILING) {
    failures.push({ path: ALLOWLIST_PATH, line: 1, message: `lists ${listed} calls, above the ceiling of ${ALLOWLIST_CEILING}; justify or rescope the call instead of listing it` })
  }
  const { unlisted, miscounted } = reconcile(untagged, allowlist)
  console.log(
    `checked bypass justification; files=${files.length} calls=${tagged.length + untagged.length} ` +
      `justified=${tagged.length} allowlisted=${untagged.length - unlisted.length}`,
  )
  for (const failure of failures) console.error(`  ${failure.path}:${failure.line}: ${failure.message}`)
  if (unlisted.length) {
    console.error(
      `${unlisted.length} bypass call(s) carry no justification. Precede each, within ${TAG_WINDOW} lines, with\n` +
        `  // bypass: <reason> — <why this site needs every organization's rows>\n` +
        `using one of: ${[...BYPASS_REASONS.keys()].join(', ')}.\n` +
        `If none fits, scope the work with withOrgContext/withOrgTransaction instead.`,
    )
    for (const site of unlisted) console.error(`  ${site.path}:${site.line} (${site.fn})`)
  }
  for (const entry of miscounted) {
    console.error(
      `  ${ALLOWLIST_PATH}: ${entry.path} (${entry.fn}) lists ${entry.calls} untagged call(s) but ${entry.found} remain; ` +
        (entry.found < entry.calls ? 'lower the count or remove the entry' : 'justify or rescope the new call; the list never grows'),
    )
  }
  if (failures.length || unlisted.length || miscounted.length) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
