/**
 * Average an already catalog-resolved numeric expression without imposing a
 * currency-specific decimal count. PostgreSQL carries the source numeric
 * precision through AVG; renderers apply locale and currency display scales.
 */
export function averageSql(expression: string): string {
  return `AVG(${expression})`
}
