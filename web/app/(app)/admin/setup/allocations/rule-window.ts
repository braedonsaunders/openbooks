/** Effective window cell text — pure for unit tests. */
export function formatWindow(from: string, to: string | null, openEnded: string): string {
  return `${from} – ${to ?? openEnded}`
}
