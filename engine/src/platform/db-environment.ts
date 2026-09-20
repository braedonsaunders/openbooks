/** Resolve DB-module configuration without importing local service credentials
 * into a test process. The file reader is lazy so tests never open the file. */
export function resolveDatabaseEnvironment(
  processEnvironment: Record<string, string | undefined>,
  readLocalFile: () => string,
): Record<string, string> {
  const resolved: Record<string, string> = {}
  if (
    processEnvironment.NODE_ENV !== 'test' &&
    !processEnvironment.NODE_TEST_CONTEXT
  ) {
    try {
      for (const line of readLocalFile().split('\n')) {
        const match = line.match(/^([A-Z0-9_]+)=(.*)$/)
        if (match) resolved[match[1]!] = match[2]!
      }
    } catch {
      // Containers have no local file and supply their environment explicitly.
    }
  }
  for (const [key, value] of Object.entries(processEnvironment)) {
    if (value !== undefined && /^[A-Z0-9_]+$/.test(key)) resolved[key] = value
  }
  return resolved
}
