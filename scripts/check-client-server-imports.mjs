#!/usr/bin/env node
/**
 * A 'use client' module must never reach server-only code through its value
 * imports: Next bundles everything a client module imports for the browser,
 * and a transitive import of the database pool (pg -> dns, fs, net, tls)
 * fails `next build`. On 2026-09-25 one client import of web/lib/crm-dates
 * (which re-exported from engine platform/business-date, which imports db.ts)
 * broke every e2e job and the release image. Typecheck and lint cannot see
 * it, so this walks the static import graph from every client module and
 * refuses a path to pg or a Node builtin.
 *
 *   node scripts/check-client-server-imports.mjs
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'

const root = resolve('.')
// Next ships browser polyfills for these core modules (exact names only);
// every other builtin, and any subpath such as util/types, fails the build.
const polyfilled = new Set(['assert', 'buffer', 'constants', 'crypto', 'domain', 'events', 'http', 'https', 'os', 'path', 'punycode', 'process', 'querystring', 'stream', 'string_decoder', 'sys', 'timers', 'tty', 'util', 'vm', 'zlib'])
const builtins = new Set(builtinModules)
const serverOnly = (spec) => {
  const bare = spec.replace(/^node:/, '')
  if (spec === 'pg' || spec.startsWith('pg/')) return true
  return (builtins.has(bare) || builtins.has(bare.split('/')[0])) && !polyfilled.has(bare)
}

const packages = new Map()
for (const dir of ['engine', 'schema', ...readdirSync(join(root, 'packages')).map((p) => `packages/${p}`)]) {
  const file = join(root, dir, 'package.json')
  if (!existsSync(file)) continue
  const pkg = JSON.parse(readFileSync(file, 'utf8'))
  packages.set(pkg.name, { dir, pkg })
}

const extensions = ['', '.ts', '.tsx', '.js', '.mjs', '/index.ts', '/index.tsx', '/index.js']
function probe(base) {
  for (const ext of extensions) {
    const file = base + ext
    if (existsSync(file) && statSync(file).isFile()) return file
  }
  return null
}

function resolveSpec(spec, from) {
  if (spec.startsWith('.')) return probe(resolve(dirname(from), spec))
  if (spec.startsWith('@/')) return probe(join(root, 'web', spec.slice(2)))
  const name = spec.split('/').slice(0, spec.startsWith('@') ? 2 : 1).join('/')
  const entry = packages.get(name)
  if (!entry) return null
  const sub = spec.slice(name.length)
  const exports = entry.pkg.exports
  if (exports && typeof exports === 'object') {
    const target = exports[`.${sub}`]
    if (typeof target === 'string') return probe(join(root, entry.dir, target))
  }
  if (!sub) return probe(join(root, entry.dir, entry.pkg.main ?? 'src/index.ts'))
  return probe(join(root, entry.dir, sub.slice(1)))
}

// Value imports only: `import type` / `export type` are erased and never bundled.
const importPattern = /(?:^|[\n;])\s*(?:import|export)\s+(?!type[\s{])(?:[^'";]*?\sfrom\s+)?['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)/g
const directive = (text, name) => new RegExp(`^\\s*(?:\\/\\/[^\\n]*\\n\\s*|\\/\\*[\\s\\S]*?\\*\\/\\s*)*['"]use ${name}['"]`).test(text)
const edges = new Map()
function importsOf(file) {
  if (!edges.has(file)) {
    const source = readFileSync(file, 'utf8')
    // A 'use server' module reaches the client only as an RPC stub.
    const text = directive(source, 'server') ? '' : source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    edges.set(file, [...text.matchAll(importPattern)].map((m) => m[1] ?? m[2]))
  }
  return edges.get(file)
}

function walkSources(dir, out) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next' || name.startsWith('.')) continue
    const path = join(dir, name)
    if (statSync(path).isDirectory()) walkSources(path, out)
    else if (/\.(tsx?|jsx?)$/.test(name) && !/\.test\.(tsx?|jsx?)$/.test(name)) out.push(path)
  }
  return out
}

const clientRoots = walkSources(join(root, 'web'), []).filter((file) => directive(readFileSync(file, 'utf8'), 'client'))

const reported = new Set()
const violations = []
for (const start of clientRoots) {
  const parent = new Map([[start, null]])
  const queue = [start]
  while (queue.length) {
    const file = queue.shift()
    for (const spec of importsOf(file)) {
      if (serverOnly(spec)) {
        const chain = []
        for (let at = file; at; at = parent.get(at)) chain.unshift(relative(root, at))
        const key = `${chain.at(-1)} -> ${spec}`
        if (!reported.has(key)) {
          reported.add(key)
          violations.push(`${chain.join(' -> ')} -> ${spec}`)
        }
        continue
      }
      const next = resolveSpec(spec, file)
      if (next && !parent.has(next)) {
        parent.set(next, file)
        queue.push(next)
      }
    }
  }
}

console.log(`checked client/server imports; client modules=${clientRoots.length} files walked=${edges.size} violations=${violations.length}`)
if (violations.length) {
  console.error('client modules that reach server-only code (import the pure module instead):')
  for (const line of violations) console.error(`  ${line}`)
  process.exitCode = 1
}
