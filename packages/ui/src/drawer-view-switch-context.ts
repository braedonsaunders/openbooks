'use client'

import * as React from 'react'

/**
 * The transition type of the nearest enclosing drawer's own view switches.
 * A client module: contexts do not exist in the server component runtime, and
 * the UI barrel is imported by server components.
 */
export const DrawerViewSwitchContext = React.createContext<string | null>(null)
