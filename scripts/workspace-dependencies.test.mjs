import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

const ROOT = new URL('..', import.meta.url)
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'])
// Build output, installs, and scratch state never ship as workspace source.
const SKIPPED_DIRECTORIES = new Set(['node_modules', '.next', 'dist', 'build', 'coverage', '.local'])

// Any static module reference to a sibling workspace package.
const WORKSPACE_IMPORT = /(?:\bfrom|\bimport\s*\(|\brequire\s*\(|\bimport)\s*['"](@openbooks\/[a-z0-9-]+)(?:\/[^'"]*)?['"]/g

function workspaceRoots() {
  const roots = []
  for (const entry of readdirSync(ROOT)) {
    if (entry.startsWith('.')) continue
    const manifestPath = join(ROOT.pathname, entry, 'package.json')
    let manifest = null
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    } catch {
      continue
    }
    if (typeof manifest.name === 'string' && manifest.name.startsWith('@openbooks/')) {
      roots.push({ dir: entry, manifest })
    }
  }
  for (const entry of readdirSync(join(ROOT.pathname, 'packages'))) {
    const manifestPath = join(ROOT.pathname, 'packages', entry, 'package.json')
    let manifest = null
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    } catch {
      continue
    }
    if (typeof manifest.name === 'string' && manifest.name.startsWith('@openbooks/')) {
      roots.push({ dir: join('packages', entry), manifest })
    }
  }
  return roots
}

function sourceFiles(dir) {
  const out = []
  const walk = (current) => {
    for (const entry of readdirSync(current)) {
      if (entry.startsWith('.')) continue
      const path = join(current, entry)
      const stat = statSync(path)
      if (stat.isDirectory()) {
        if (SKIPPED_DIRECTORIES.has(entry)) continue
        walk(path)
      } else if (SOURCE_EXTENSIONS.has(entry.slice(entry.lastIndexOf('.')))) {
        out.push(path)
      }
    }
  }
  walk(join(ROOT.pathname, dir))
  return out
}

function importedWorkspaces(dir) {
  const imported = new Map()
  for (const file of sourceFiles(dir)) {
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(WORKSPACE_IMPORT)) {
      const specifier = match[1]
      if (!imported.has(specifier)) imported.set(specifier, [])
      if (imported.get(specifier).length < 5) imported.get(specifier).push(file)
    }
  }
  return imported
}

for (const { dir, manifest } of workspaceRoots()) {
  test(`workspace ${manifest.name} declares every @openbooks/* package it imports`, () => {
    const declared = new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.devDependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
      ...Object.keys(manifest.optionalDependencies ?? {}),
    ])
    const missing = []
    for (const [specifier, files] of importedWorkspaces(dir)) {
      if (specifier === manifest.name) continue
      if (!declared.has(specifier)) missing.push(`${specifier} (e.g. ${files[0]})`)
    }
    assert.deepEqual(
      missing,
      [],
      `${dir}/package.json must declare every sibling workspace its source imports; ` +
        `npm workspaces resolve these by hoisting today, but an undeclared edge breaks ` +
        `isolated installs and lies about the dependency graph:\n${missing.join('\n')}`,
    )
  })
}
