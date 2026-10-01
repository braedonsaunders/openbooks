"use client";

import { createContext, type ReactNode } from "react";

/** Embedded pages share their host workspace's width, spacing and scrolling. */
export const PagePresentationContext = createContext<'page' | 'section'>('page');

export function PagePresentationProvider({ children, presentation }: {
  children: ReactNode;
  presentation: 'page' | 'section';
}) {
  return <PagePresentationContext.Provider value={presentation}>{children}</PagePresentationContext.Provider>;
}
