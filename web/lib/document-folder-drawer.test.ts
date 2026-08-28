import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('../app/(app)/documents/FolderDrawer.tsx', import.meta.url), 'utf8')

test('new folder details expose the privacy choice that the create request already submits', () => {
  assert.match(source, /\{mode === 'create' \|\| \(mode === 'edit' && !isSystem\) \? \(/)
  assert.match(
    source,
    /type="checkbox"[\s\S]*?checked=\{isPrivate\}[\s\S]*?onChange=\{\(e\) => setIsPrivate\(e\.target\.checked\)\}/,
  )
  assert.match(
    source,
    /method: 'POST'[\s\S]*?body: JSON\.stringify\(\{[\s\S]*?isPrivate,[\s\S]*?\}\)/,
  )
})

test('existing folders still hide privacy controls for system folders and disable them while viewed', () => {
  assert.match(source, /\(mode === 'edit' && !isSystem\)/)
  assert.match(source, /checked=\{isPrivate\}[\s\S]*?disabled=\{!editing\}/)
})
