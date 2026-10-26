/**
 * ESC/POS receipt bytes for thermal printers. Pure: the register builds the
 * byte stream here and writes it to a printer the operator chose through
 * the browser's serial port picker. Text is reduced to printable ASCII so
 * every printer code page renders it identically.
 */

export type EscPosLine =
  | {
      kind: "text";
      text: string;
      align?: "left" | "center" | "right";
      bold?: boolean;
      double?: boolean;
    }
  | { kind: "pair"; left: string; right: string; bold?: boolean }
  | { kind: "rule" }
  | { kind: "feed"; lines?: number };

const ESC = 0x1b;
const GS = 0x1d;

/** Printable ASCII only: accents are folded, anything else becomes '?'. */
export function asciiFold(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/[^\x20-\x7e\n]/g, "?");
}

/** Lay a left label and a right amount out on one line of `width` columns. */
export function padPair(left: string, right: string, width: number): string {
  const r = asciiFold(right);
  const room = Math.max(width - r.length - 1, 1);
  const l = asciiFold(left);
  const clipped = l.length > room ? l.slice(0, room) : l;
  return `${clipped}${" ".repeat(width - clipped.length - r.length)}${r}`;
}

/** Encode receipt lines as ESC/POS: initialize, the lines, feed and a partial cut. */
export function encodeEscPos(lines: readonly EscPosLine[], width = 42): Uint8Array {
  const out: number[] = [ESC, 0x40];
  const text = (value: string) => {
    for (const char of asciiFold(value)) out.push(char.charCodeAt(0));
    out.push(0x0a);
  };
  for (const line of lines) {
    if (line.kind === "text") {
      out.push(ESC, 0x61, line.align === "center" ? 1 : line.align === "right" ? 2 : 0);
      out.push(ESC, 0x45, line.bold ? 1 : 0);
      out.push(GS, 0x21, line.double ? 0x11 : 0x00);
      for (const part of line.text.split("\n")) text(part);
      out.push(GS, 0x21, 0x00, ESC, 0x45, 0, ESC, 0x61, 0);
    } else if (line.kind === "pair") {
      out.push(ESC, 0x45, line.bold ? 1 : 0);
      text(padPair(line.left, line.right, width));
      out.push(ESC, 0x45, 0);
    } else if (line.kind === "rule") {
      text("-".repeat(width));
    } else {
      out.push(ESC, 0x64, Math.min(Math.max(line.lines ?? 1, 0), 10));
    }
  }
  out.push(ESC, 0x64, 4, GS, 0x56, 0x42, 0x00);
  return Uint8Array.from(out);
}

type SerialPortLike = {
  open: (options: { baudRate: number }) => Promise<void>;
  close: () => Promise<void>;
  writable: {
    getWriter: () => { write: (chunk: Uint8Array) => Promise<void>; releaseLock: () => void };
  } | null;
};

/** Whether this browser can talk to a serial receipt printer. */
export function serialPrintingAvailable(): boolean {
  return typeof navigator !== "undefined" && "serial" in navigator;
}

/** Ask the operator for the printer's serial port and write the receipt to it. */
export async function printEscPosOverSerial(bytes: Uint8Array, baudRate = 9600): Promise<void> {
  const serial = (
    navigator as unknown as { serial: { requestPort: () => Promise<SerialPortLike> } }
  ).serial;
  const port = await serial.requestPort();
  await port.open({ baudRate });
  try {
    const writer = port.writable?.getWriter();
    if (!writer) throw new Error("The printer port is not writable.");
    try {
      await writer.write(bytes);
    } finally {
      writer.releaseLock();
    }
  } finally {
    await port.close();
  }
}
