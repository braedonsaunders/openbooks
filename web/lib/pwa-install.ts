'use client'

export type InstallationPrompt = Event & {
  prompt(): Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>
}

type InstallState = {
  visible: boolean
  platform: 'ios' | 'mac' | 'browser'
  prompt: InstallationPrompt | null
  busy: boolean
}

const INITIAL: InstallState = { visible: false, platform: 'browser', prompt: null, busy: false }
let state = INITIAL
let accepted = false
let stopObserving: (() => void) | undefined
const listeners = new Set<() => void>()

function publish(next: InstallState) {
  state = next
  for (const listener of listeners) listener()
}

export function installSnapshot(): InstallState { return state }
export function installServerSnapshot(): InstallState { return INITIAL }

/** Observe browser installation signals only while the native header action is mounted. */
export function subscribeInstallation(listener: () => void): () => void {
  listeners.add(listener)
  if (listeners.size === 1) stopObserving = observeInstallation()
  return () => {
    listeners.delete(listener)
    if (listeners.size) return
    stopObserving?.()
    stopObserving = undefined
  }
}

function observeInstallation(): () => void {
  const display = window.matchMedia('(display-mode: standalone)')
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  const mac = /Mac/.test(navigator.platform)
  const standalone = () => display.matches
    || ('standalone' in navigator && navigator.standalone === true)
  const visible = () => window.isSecureContext && !standalone() && !accepted
  publish({ ...state, visible: visible(), platform: ios ? 'ios' : mac ? 'mac' : 'browser' })

  function offered(event: Event) {
    if (!visible()) return
    if (!('prompt' in event) || typeof event.prompt !== 'function' || !('userChoice' in event)) return
    event.preventDefault()
    publish({ ...state, prompt: event as InstallationPrompt, visible: visible() })
  }
  function installed() {
    accepted = true
    publish({ ...state, visible: false, prompt: null, busy: false })
  }
  function changed() {
    if (standalone()) installed()
    else publish({ ...state, visible: visible() })
  }
  window.addEventListener('beforeinstallprompt', offered)
  window.addEventListener('appinstalled', installed)
  display.addEventListener('change', changed)
  return () => {
    window.removeEventListener('beforeinstallprompt', offered)
    window.removeEventListener('appinstalled', installed)
    display.removeEventListener('change', changed)
  }
}

/** The browser prompt is single-use; only an explicit click invokes it. */
export async function requestInstallation(): Promise<'accepted' | 'dismissed' | 'instructions' | 'busy'> {
  if (state.busy) return 'busy'
  const offer = state.prompt
  if (!offer) return 'instructions'
  publish({ ...state, busy: true, prompt: null })
  try {
    await offer.prompt()
    const { outcome } = await offer.userChoice
    accepted ||= outcome === 'accepted'
    publish({ ...state, busy: false, visible: outcome === 'accepted' ? false : state.visible })
    return outcome
  } catch (error) {
    publish({ ...state, busy: false })
    throw error
  }
}
