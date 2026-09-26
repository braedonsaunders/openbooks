/** Statement byte/text decoding. Split from banking.ts (pure moves only). */
import { BankingError, type StatementSourceContent, type StatementTextSource } from "./banking-core"

const STATEMENT_ENCODING_ALIASES: Readonly<Record<string, string>> = {
  "1252": "windows-1252",
  "cp1252": "windows-1252",
  "windows-1252": "windows-1252",
  "iso-8859-1": "windows-1252",
  "iso8859-1": "windows-1252",
  "latin1": "windows-1252",
  "65001": "utf-8",
  "utf-8": "utf-8",
  "utf8": "utf-8",
  "1200": "utf-16le",
  "unicode": "utf-16",
  "utf-16": "utf-16",
  "utf-16le": "utf-16le",
  "utf16": "utf-16",
  "utf16le": "utf-16le",
  "1201": "utf-16be",
  "utf-16be": "utf-16be",
  "utf16be": "utf-16be",
  "ascii": "ascii",
  "none": "",
  "usascii": "ascii",
  "us-ascii": "ascii",
};

function normalizeStatementEncoding(label: string): string | null {
  const normalized = label.trim().toLowerCase();
  const alias = Object.hasOwn(STATEMENT_ENCODING_ALIASES, normalized)
    ? STATEMENT_ENCODING_ALIASES[normalized]!
    : normalized;
  if (!alias) return null;
  if (alias === "ascii" || alias === "utf-16") return alias;
  try {
    return new TextDecoder(alias).encoding;
  } catch {
    throw new BankingError(`Statement source declares unsupported encoding "${label}"`);
  }
}

/** Read an encoding declaration only where the selected format permits one. */
function statementEncodingLabel(text: string, source?: StatementTextSource): string | null {
  if (source !== "ofx" && source !== "camt053") return null;
  const withoutBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const xml = withoutBom.match(
    /^[\t\r\n ]*<\?xml\b[^>]*\bencoding\s*=\s*["']\s*([^\s"']+)/i,
  )?.[1];
  if (xml) return xml;
  if (source !== "ofx") return null;

  const ofxStart = withoutBom.search(/<OFX(?:\s|>)/i);
  if (ofxStart < 0 || ofxStart > 4096) return null;
  const header = withoutBom.slice(0, ofxStart);
  if (!/^[\t\r\n ]*OFXHEADER\s*:/i.test(header)) return null;
  const charset = header.match(/(?:^|[\r\n])[\t ]*CHARSET\s*:\s*([^\s\r\n<]+)/i)?.[1];
  if (charset && charset.trim().toLowerCase() !== "none") return charset;
  return header.match(/(?:^|[\r\n])[\t ]*ENCODING\s*:\s*([^\s\r\n<]+)/i)?.[1] ?? null;
}

function rawStatementEncodingLabel(bytes: Uint8Array, source?: StatementTextSource): string | null {
  const offset = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  const prefix = Buffer.from(bytes.subarray(offset, offset + 4096)).toString("latin1");
  return statementEncodingLabel(prefix, source);
}

/** Conservative recognition for BOM-less UTF-16 text with an ASCII-heavy prefix. */
function bomlessUtf16Encoding(bytes: Uint8Array): "utf-16le" | "utf-16be" | null {
  if (bytes.length < 8 || bytes.length % 2 !== 0) return null;
  const pairs = Math.min(bytes.length / 2, 512);
  let evenNuls = 0;
  let oddNuls = 0;
  for (let pair = 0; pair < pairs; pair += 1) {
    if (bytes[pair * 2] === 0) evenNuls += 1;
    if (bytes[pair * 2 + 1] === 0) oddNuls += 1;
  }
  if (oddNuls / pairs >= 0.3 && evenNuls / pairs <= 0.05) return "utf-16le";
  if (evenNuls / pairs >= 0.3 && oddNuls / pairs <= 0.05) return "utf-16be";
  return null;
}

function decodeStatementBytes(bytes: Uint8Array, encoding: string): string {
  if (encoding === "ascii") {
    if (bytes.some((byte) => byte > 0x7f)) {
      throw new BankingError("Statement source declares US-ASCII but contains non-ASCII bytes");
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  }
  if (encoding === "utf-16") {
    throw new BankingError("UTF-16 bank statements require a BOM or detectable byte order");
  }
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(encoding, { fatal: true });
  } catch {
    throw new BankingError(`Statement source declares unsupported encoding "${encoding}"`);
  }
  try {
    return decoder.decode(bytes);
  } catch {
    throw new BankingError(`Statement source is not valid ${encoding.toUpperCase()} text`);
  }
}

function statementEncodingMatches(actual: string, declared: string): boolean {
  if (declared === "utf-16") return actual === "utf-16le" || actual === "utf-16be";
  return actual === declared;
}

function assertStatementEncoding(
  text: string,
  source: StatementTextSource | undefined,
  actual: string,
  rawLabel: string | null,
): void {
  const decodedLabel = statementEncodingLabel(text, source);
  if (rawLabel && !decodedLabel) {
    throw new BankingError(`Statement source encoding declaration "${rawLabel}" does not match its bytes`);
  }
  const label = decodedLabel ?? rawLabel;
  if (!label) return;
  const declared = normalizeStatementEncoding(label);
  if (declared && !statementEncodingMatches(actual, declared)) {
    throw new BankingError(
      `Statement source encoding declaration "${label}" conflicts with ${actual.toUpperCase()} source bytes`,
    );
  }
}

function validateStatementText(text: string): string {
  const withoutBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(withoutBom)) {
    throw new BankingError("Statement source contains unsupported control characters");
  }
  return withoutBom;
}

/**
 * Decode exact bank-statement bytes without replacement characters. BOMs and
 * explicit XML/OFX declarations are authoritative; otherwise valid UTF-8 wins
 * and legacy single-byte exports fall back deterministically to Windows-1252.
 */
export function decodeStatementSourceText(
  content: StatementSourceContent,
  source?: StatementTextSource,
): string {
  if (typeof content === "string") return validateStatementText(content);
  const bytes = content;
  if (bytes.length === 0) return "";

  if (
    (bytes[0] === 0xff && bytes[1] === 0xfe && bytes[2] === 0x00 && bytes[3] === 0x00)
    || (bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0xfe && bytes[3] === 0xff)
  ) {
    throw new BankingError("UTF-32 bank statements are not supported");
  }

  const rawLabel = rawStatementEncodingLabel(bytes, source);
  let encoding =
    bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
      ? "utf-8"
      : bytes[0] === 0xff && bytes[1] === 0xfe
        ? "utf-16le"
        : bytes[0] === 0xfe && bytes[1] === 0xff
          ? "utf-16be"
          : bomlessUtf16Encoding(bytes);
  if (!encoding && rawLabel) encoding = normalizeStatementEncoding(rawLabel);

  let text: string;
  if (encoding) {
    text = decodeStatementBytes(bytes, encoding);
  } else {
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      encoding = "utf-8";
    } catch {
      encoding = "windows-1252";
      text = decodeStatementBytes(bytes, encoding);
    }
  }
  assertStatementEncoding(text, source, encoding, rawLabel);
  return validateStatementText(text);
}
