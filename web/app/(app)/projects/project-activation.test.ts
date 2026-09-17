import assert from 'node:assert/strict'
import test from 'node:test'
import { isProjectPlaceholderName, shouldAutoActivateProject } from './project-activation'

// F-t03-001: a project created with Status Active stayed flagged Inactive and
// hidden from the default list, because nothing ever flipped is_active after
// the draft placeholder gained a real name. Saving the creation-completing
// name must activate; anything else must not.
test('the creation-completing save activates the placeholder draft', () => {
  assert.equal(shouldAutoActivateProject('New project', false, 'Fleet6 Test HQ Build'), true)
})

test('activation never fires twice and never resurrects a deactivation', () => {
  // Already active: nothing to do.
  assert.equal(shouldAutoActivateProject('Fleet6 Test HQ Build', true, 'Fleet6 Test HQ Build'), false)
  // A real project the operator deactivated stays deactivated across later
  // saves — the deactivate feature must survive ordinary edits.
  assert.equal(shouldAutoActivateProject('Old Job', false, 'Old Job'), false)
  assert.equal(shouldAutoActivateProject('Old Job', false, 'Old Job Renamed'), false)
})

test('a save without a real name never activates', () => {
  assert.equal(shouldAutoActivateProject('New project', false, ''), false)
  assert.equal(shouldAutoActivateProject('New project', false, '   '), false)
  assert.equal(shouldAutoActivateProject('New project', false, 'New project'), false)
})

test('placeholder detection ignores surrounding whitespace', () => {
  assert.equal(isProjectPlaceholderName('New project'), true)
  assert.equal(isProjectPlaceholderName('  New project  '), true)
  assert.equal(isProjectPlaceholderName(''), true)
  assert.equal(isProjectPlaceholderName(null), true)
  assert.equal(isProjectPlaceholderName('Fleet6 Test HQ Build'), false)
})
