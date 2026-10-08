'use client'

import * as React from 'react'

/**
 * The transition type of the nearest enclosing drawer's own view switches.
 * A client module: contexts do not exist in the server component runtime, and
 * the UI barrel is imported by server components.
 */
export const DrawerViewSwitchContext = React.createContext<string | null>(null)

/**
 * True inside a drawer's header tab row, which draws the baseline its tabs
 * sit on. A tab strip anywhere else — a sub-view inside a drawer body —
 * draws its own baseline and keeps clear of the content beneath it.
 */
export const DrawerSubtabSlotContext = React.createContext(false)
