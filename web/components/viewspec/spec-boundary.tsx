'use client'

import { Component, type ReactNode } from 'react'

/**
 * Render a tenant-authored layout; fall back to the built-in one if it throws.
 *
 * Validation proves a layout is a well-formed spec naming widgets this host
 * has. It does NOT prove the widgets will accept what the layout binds to
 * them: widget props are `Record<string, unknown>` by design — the registry
 * does the casting — so a tenant can bind `{}` where a cockpit expects its
 * position data, and the component throws mid-render.
 *
 * That is not an escalation. The loader already ran, under the reader's own
 * permissions, and a spec can only read its output; the worst case is a page
 * that does not draw. But "does not draw" reached the app error screen, which
 * makes a reader think the product is broken when a colleague mis-edited a
 * layout. So the tenant subtree renders inside this boundary and the built-in
 * page is the fallback — the same bargain the validation path already makes.
 *
 * A client boundary is the only thing that can catch this. A server component
 * cannot try/catch its own children: they render after it returns.
 */
export class SpecBoundary extends Component<
  { fallback: ReactNode; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch(error: unknown) {
    // Logged, not swallowed. Someone has to be able to find out WHY their
    // layout did not render, and the reader is seeing the built-in page with
    // no indication anything was overridden.
    console.error('[viewspec] tenant layout failed to render; using the built-in page', error)
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}
