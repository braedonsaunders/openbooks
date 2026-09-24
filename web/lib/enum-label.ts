/** Look up a persisted enum in its localized, compile-time-complete catalog. */
export function enumLabel<T extends string>(
  value: string,
  labels: Readonly<Record<T, string>>,
  unknownLabel: string,
): string {
  return Object.hasOwn(labels, value) ? labels[value as T] : unknownLabel
}
