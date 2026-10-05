import assert from 'node:assert/strict'
import test from 'node:test'
import { bootJsdomEnvironment } from '../testing/jsdom-env'

await bootJsdomEnvironment({ url: 'https://example.test/me', event: 'jsdom' })
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: window.navigator })
Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true })
const displayEvents = new window.EventTarget()
let standalone = false
window.matchMedia = () => ({
  get matches() { return standalone }, media: '(display-mode: standalone)', onchange: null,
  addEventListener: displayEvents.addEventListener.bind(displayEvents),
  removeEventListener: displayEvents.removeEventListener.bind(displayEvents),
  dispatchEvent: displayEvents.dispatchEvent.bind(displayEvents),
  addListener() {}, removeListener() {},
}) as MediaQueryList

const { installSnapshot, requestInstallation, subscribeInstallation } = await import('./pwa-install')

test('installation follows browser consent, consumes each offer once and releases all listeners', async () => {
  standalone = true
  const stopStandalone = subscribeInstallation(() => {})
  assert.equal(installSnapshot().visible, false, 'an installed standalone app does not ask to install itself')
  stopStandalone()
  standalone = false

  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: false })
  const stopInsecure = subscribeInstallation(() => {})
  assert.equal(installSnapshot().visible, false, 'an insecure origin cannot offer installation')
  stopInsecure()
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true })

  const stopFirst = subscribeInstallation(() => {})
  const stopSecond = subscribeInstallation(() => {})
  assert.equal(installSnapshot().visible, true)
  assert.equal(await requestInstallation(), 'instructions', 'unsupported prompt browsers receive manual instructions')

  let calls = 0
  let answer!: (choice: { outcome: 'accepted' | 'dismissed'; platform: string }) => void
  const choice = new Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>((resolve) => { answer = resolve })
  const offer = new Event('beforeinstallprompt', { cancelable: true })
  Object.assign(offer, { prompt: async () => { calls++ }, userChoice: choice })
  window.dispatchEvent(offer)
  assert.equal(offer.defaultPrevented, true)
  assert.equal(calls, 0, 'receiving an offer never prompts without an explicit user action')
  const first = requestInstallation()
  assert.equal(await requestInstallation(), 'busy', 'a double click cannot consume a browser offer twice')
  answer({ outcome: 'dismissed', platform: 'web' })
  assert.equal(await first, 'dismissed')
  assert.equal(calls, 1)
  assert.equal(await requestInstallation(), 'instructions', 'a dismissed single-use offer is not reused')

  stopFirst()
  stopSecond()
  const detachedOffer = new Event('beforeinstallprompt', { cancelable: true })
  Object.assign(detachedOffer, { prompt: async () => {}, userChoice: choice })
  window.dispatchEvent(detachedOffer)
  assert.equal(detachedOffer.defaultPrevented, false, 'the final subscriber removes browser listeners, regardless of unsubscribe order')

  const stop = subscribeInstallation(() => {})
  try {
    const failed = new Event('beforeinstallprompt', { cancelable: true })
    Object.assign(failed, { prompt: async () => { throw new Error('Browser refused installation') }, userChoice: choice })
    window.dispatchEvent(failed)
    await assert.rejects(requestInstallation, /Browser refused installation/, 'a browser refusal reaches the caller')
    assert.equal(installSnapshot().busy, false, 'a refused prompt releases the control for manual instructions')
    assert.equal(await requestInstallation(), 'instructions')
    window.dispatchEvent(new Event('appinstalled'))
    assert.equal(installSnapshot().visible, false)
  } finally { stop() }
})
