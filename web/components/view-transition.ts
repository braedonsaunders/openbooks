import * as React from 'react'

/**
 * React's `<ViewTransition>`. The App Router renders with React's canary
 * channel, which provides it. Outside the App Router — unit tests render
 * with the stable package — the boundary renders its children unchanged,
 * which is exactly what a browser without the View Transitions API shows.
 */
export const ViewTransition: typeof React.ViewTransition =
  (React as Partial<Pick<typeof React, 'ViewTransition'>>).ViewTransition
  ?? ((({ children }: { children?: React.ReactNode }) => children) as unknown as typeof React.ViewTransition)
