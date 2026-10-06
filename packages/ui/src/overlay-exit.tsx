'use client'

import type { ReactNode } from 'react'
import { useIsPresent } from 'framer-motion'

/**
 * Wraps the child of an `AnimatePresence` that renders a floating overlay — a
 * menu, popover, drawer or navigation flyout — and tells it whether it is
 * playing its exit animation. The overlay marks itself `data-overlay-exiting`
 * for that time.
 *
 * Choosing a destination from a menu closes the menu and starts the page's
 * route transition together. The browser captures the screen as the
 * transition starts, so without the mark a menu still fading out would be
 * captured with the outgoing screen and stay visible beneath the arriving
 * page. The web app's stylesheet hides marked overlays while a view
 * transition is running (see "Route transitions" in `web/app/globals.css`).
 */
export function OverlayExit({ children }: { children: (exiting: boolean) => ReactNode }) {
  return children(!useIsPresent())
}
