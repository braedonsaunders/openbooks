import assert from 'node:assert/strict'
import test from 'node:test'
import {
  nextDefaultFlags,
  refuseInactiveDefault,
} from './active-default.ts'

// Done criterion for inactive defaults invisible to resolve: a write whose
// next state is isDefault && !isActive must refuse by name. resolveFormLayout
// and resolveListView both select only is_active rows before picking
// isDefault, so storing that pair is a save no read can observe.
//
// The message must name both real remedies (activate, or unset default
// first) and must tell a view apart from a form — duplicating one object
// cannot expose a message that fails to name the other.

const VIEW_REMEDY = /inactive view cannot be the default/i
const FORM_REMEDY = /inactive form cannot be the default/i
const ACTIVATE = /activate it/i
const UNSET = /unset default before deactivating/i

function refused(kind: 'view' | 'form', isDefault: boolean, isActive: boolean) {
  return refuseInactiveDefault({ kind, isDefault, isActive })
}

test('a default that is inactive is refused, and the two kinds are named apart', () => {
  const view = refused('view', true, false)
  const form = refused('form', true, false)
  assert.equal(view.ok, false)
  assert.equal(form.ok, false)
  assert.match(view.error, VIEW_REMEDY)
  assert.match(form.error, FORM_REMEDY)
  assert.notEqual(view.error, form.error)
  assert.match(view.error, ACTIVATE)
  assert.match(view.error, UNSET)
  assert.match(form.error, ACTIVATE)
  assert.match(form.error, UNSET)
})

test('an active default, an inactive non-default, and an active non-default are kept', () => {
  for (const kind of ['view', 'form'] as const) {
    assert.deepEqual(refused(kind, true, true), { ok: true })
    assert.deepEqual(refused(kind, false, false), { ok: true })
    assert.deepEqual(refused(kind, false, true), { ok: true })
  }
})

test('PATCH next-state: deactivating a default, or defaulting an inactive row, is the same refusal', () => {
  const deactivateDefault = nextDefaultFlags(
    { isDefault: true, isActive: true },
    { isActive: false },
  )
  assert.deepEqual(deactivateDefault, { isDefault: true, isActive: false })
  const deactivated = refuseInactiveDefault({ kind: 'view', ...deactivateDefault })
  assert.equal(deactivated.ok, false)
  assert.match(deactivated.error, VIEW_REMEDY)

  const defaultInactive = nextDefaultFlags(
    { isDefault: false, isActive: false },
    { isDefault: true },
  )
  assert.deepEqual(defaultInactive, { isDefault: true, isActive: false })
  const promoted = refuseInactiveDefault({ kind: 'form', ...defaultInactive })
  assert.equal(promoted.ok, false)
  assert.match(promoted.error, FORM_REMEDY)
})

test('the named remedies are legal next-states: activate with default, or unset default then deactivate', () => {
  const activateAndKeep = nextDefaultFlags(
    { isDefault: true, isActive: false },
    { isActive: true },
  )
  assert.deepEqual(refuseInactiveDefault({ kind: 'view', ...activateAndKeep }), { ok: true })

  const unsetThenDeactivate = nextDefaultFlags(
    { isDefault: true, isActive: true },
    { isDefault: false, isActive: false },
  )
  assert.deepEqual(refuseInactiveDefault({ kind: 'form', ...unsetThenDeactivate }), { ok: true })
})
