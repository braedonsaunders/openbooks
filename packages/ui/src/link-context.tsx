'use client'

// @beaconhs/ui stays framework-agnostic: it can't import next/link directly
// (a second module instance of next's router context in the transpiled
// package falls back to full-page anchor navigation). Instead the app
// provides its client-side <Link> once via UiLinkProvider, and ui components
// render UiLink — which uses it, or degrades to a plain <a>.

import {
  createContext,
  useContext,
  type AnchorHTMLAttributes,
  type ComponentType,
  type ReactNode,
} from 'react'

type LinkLike = ComponentType<AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }>

const UiLinkContext = createContext<LinkLike | null>(null)

/** Mount once in the app shell with the framework's Link (e.g. next/link). */
export function UiLinkProvider({ link, children }: { link: LinkLike; children: ReactNode }) {
  return <UiLinkContext.Provider value={link}>{children}</UiLinkContext.Provider>
}

/** In-app anchor: client-side navigation when a Link is provided, <a> otherwise. */
export function UiLink({
  href,
  ...rest
}: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  const Link = useContext(UiLinkContext) ?? 'a'
  return <Link href={href} {...rest} />
}

// ---------------------------------------------------------------------------
// Back-link injection
//
// A record page has one hardcoded "home" (its `back` prop), but is reachable
// from many places. The app injects a smart back-link implementation — it
// resolves the real return target from an in-app history stack (and an optional
// ?from param), falling back to the page's hardcoded href/label when there's no
// better signal. UI components render UiBackLink instead of a bare link so every
// DetailHeader/PageHeader gains this behaviour with no per-page change.

/** The `back` fallback plus styling; the impl upgrades `href`/`label` at render. */
export type BackLinkProps = { href: string; label: string; className?: string }
export type BackLinkLike = ComponentType<BackLinkProps>

const UiBackLinkContext = createContext<BackLinkLike | null>(null)

/** Mount once in the app shell to upgrade every DetailHeader/PageHeader back link. */
export function UiBackLinkProvider({
  backLink,
  children,
}: {
  backLink: BackLinkLike
  children: ReactNode
}) {
  return <UiBackLinkContext.Provider value={backLink}>{children}</UiBackLinkContext.Provider>
}

/**
 * Renders the injected smart back link when one is provided, otherwise a plain
 * `← label` anchor to `href`. Safe to use in server components (it's a client
 * component that reads context at render time).
 */
export function UiBackLink({ href, label, className }: BackLinkProps) {
  const Impl = useContext(UiBackLinkContext)
  if (Impl) return <Impl href={href} label={label} className={className} />
  return (
    <UiLink href={href} className={className}>
      ← {label}
    </UiLink>
  )
}
