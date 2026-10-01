"use client";

import { createContext, type ReactNode } from "react";

/** Scoped to the page layout's header, so record and drawer headers stay independent. */
export const PageHeaderNavigationContext = createContext<ReactNode>(null);

export function PageHeaderNavigationProvider({ navigation, children }: {
  navigation: ReactNode;
  children: ReactNode;
}) {
  return <PageHeaderNavigationContext.Provider value={navigation}>{children}</PageHeaderNavigationContext.Provider>;
}
