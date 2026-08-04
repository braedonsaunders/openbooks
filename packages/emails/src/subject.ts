// Transport-safe email subject normalization.
export const EMAIL_SUBJECT_LIMITS = {
  subjectChars: 998,
  subjectBytes: 998,
} as const

/** Collapse transport-significant whitespace and enforce the RFC line ceiling. */
export function normalizeEmailSubject(value: string): string {
  const output: string[] = []
  let pendingSpace = false
  let bytes = 0
  let chars = 0

  const append = (char: string, code: number) => {
    const byteLength = code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4
    if (bytes > EMAIL_SUBJECT_LIMITS.subjectBytes - byteLength) {
      throw new Error(`Email subject exceeded ${EMAIL_SUBJECT_LIMITS.subjectBytes} bytes.`)
    }
    if (chars >= EMAIL_SUBJECT_LIMITS.subjectChars) {
      throw new Error(`Email subject exceeded ${EMAIL_SUBJECT_LIMITS.subjectChars} characters.`)
    }
    output.push(char)
    bytes += byteLength
    chars += 1
  }

  for (const char of value) {
    const code = char.codePointAt(0)!
    const whitespace =
      code <= 32 ||
      code === 0x7f ||
      code === 0xa0 ||
      code === 0x1680 ||
      (code >= 0x2000 && code <= 0x200a) ||
      code === 0x2028 ||
      code === 0x2029 ||
      code === 0x202f ||
      code === 0x205f ||
      code === 0x3000
    if (whitespace) {
      pendingSpace = output.length > 0
      continue
    }
    if (pendingSpace) append(' ', 32)
    pendingSpace = false
    append(char, code)
  }
  return output.join('')
}
