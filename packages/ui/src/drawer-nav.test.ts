import assert from 'node:assert/strict'
import test from 'node:test'
import { nextDrawerShow, shouldCommitDrawerCloseNavigation } from './drawer-nav'

test('close navigation is suppressed once the URL has already moved', () => {
  const closed = '/reports/aging?period=today&reportDrill=one'
  const dest = '/reports/aging?period=today'
  assert.equal(
    shouldCommitDrawerCloseNavigation({ urlWhenClosed: closed, urlNow: closed, closeHref: dest }),
    true,
    'still on the closed URL: the deferred close must commit',
  )
  assert.equal(
    shouldCommitDrawerCloseNavigation({ urlWhenClosed: closed, urlNow: dest, closeHref: dest }),
    false,
    'already at the close href: do not navigate again',
  )
  assert.equal(
    shouldCommitDrawerCloseNavigation({
      urlWhenClosed: closed,
      urlNow: '/reports/aging?period=today&reportDrill=two',
      closeHref: dest,
    }),
    false,
    "a newer drill must not be wiped by the first drawer's afterExit",
  )
})

test('a new openKey remounts the drawer even when open stayed true', () => {
  const closing = nextDrawerShow({
    open: true,
    show: false,
    prevOpen: true,
    openKey: 'one',
    prevOpenKey: 'one',
  })
  assert.equal(closing.show, false, 'close() leaves show false while open is still true')
  const second = nextDrawerShow({
    ...closing,
    open: true,
    openKey: 'two',
  })
  assert.equal(second.show, true, 'a new target must reopen without a full page load')
})
