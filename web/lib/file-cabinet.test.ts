import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('./file-cabinet.ts', import.meta.url), 'utf8')

test('file-cabinet mutation seams can join a caller-owned transaction', () => {
  assert.match(source, /async function runMutation<[\s\S]*?if \(executor\) return work\(executor\)/)
  assert.match(source, /export interface FileMutationAudit \{[\s\S]*?executor\?: SqlExecutor/)
  assert.match(source, /export async function restoreFile\([\s\S]*?action: 'restore',[\s\S]*?before:[\s\S]*?after:/)
  assert.match(source, /export async function replaceFile\([\s\S]*?action: 'replace',[\s\S]*?before:[\s\S]*?after:/)
})

test('upload-and-attach creates folders, file rows, blobs, links, and audit in one executor', () => {
  const start = source.indexOf('export async function uploadAndAttach')
  assert.ok(start >= 0)
  const fn = source.slice(start)
  assert.match(fn, /return runMutation\(input\.executor/)
  assert.match(fn, /ensureRecordFolder\([\s\S]*?tx\)/)
  assert.match(fn, /audit: \{ actorId: input\.createdBy, executor: tx \}/)
  assert.match(fn, /await tx\.execute[\s\S]*?insert into file_attachments/)
})
