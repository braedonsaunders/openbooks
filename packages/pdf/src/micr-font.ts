/** Validate an embedded E-13B TrueType font before allowing bank-field output. */
export function assertMicrFont(bytes: Uint8Array, encoding: "unicode" | "abcd" = "unicode"): void {
  const refuse = () => {
    throw new Error(
      "Use an E-13B TrueType font containing the MICR digits and control symbols for the selected encoding at standard 12-point spacing.",
    );
  };
  if (bytes.length < 12 || bytes.length > 262144) refuse();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (at: number) => {
    if (at < 0 || at + 2 > bytes.length) refuse();
    return view.getUint16(at);
  };
  const u32 = (at: number) => {
    if (at < 0 || at + 4 > bytes.length) refuse();
    return view.getUint32(at);
  };
  if (u32(0) !== 0x00010000) refuse();
  const tables = new Map<string, { start: number; length: number }>();
  const n = u16(4);
  if (n > 128) refuse();
  for (let i = 0; i < n; i++) {
    const at = 12 + i * 16;
    const tag = String.fromCharCode(...bytes.slice(at, at + 4)),
      start = u32(at + 8),
      length = u32(at + 12);
    if (start + length > bytes.length || tables.has(tag)) refuse();
    tables.set(tag, { start, length });
  }
  const table = (name: string, size: number) => {
    const t = tables.get(name);
    if (!t || t.length < size) return refuse() as never;
    return t.start;
  };
  const head = table("head", 54),
    hhea = table("hhea", 36),
    maxp = table("maxp", 6),
    hmtx = table("hmtx", 4),
    cmap = table("cmap", 4),
    name = table("name", 6);
  const units = u16(head + 18),
    metrics = u16(hhea + 34),
    glyphs = u16(maxp + 4);
  if (
    units < 16 ||
    metrics < 1 ||
    metrics > glyphs ||
    tables.get("hmtx")!.length < metrics * 4 + (glyphs - metrics) * 2
  )
    refuse();
  const names: string[] = [];
  const nameCount = u16(name + 2),
    strings = name + u16(name + 4);
  if (nameCount > 512) refuse();
  for (let i = 0; i < nameCount; i++) {
    const at = name + 6 + i * 12,
      id = u16(at + 6),
      length = u16(at + 8),
      start = strings + u16(at + 10);
    if (start + length > name + tables.get("name")!.length) refuse();
    if ([1, 4, 6].includes(id))
      names.push(
        new TextDecoder(u16(at) === 3 || u16(at) === 0 ? "utf-16be" : "windows-1252").decode(
          bytes.slice(start, start + length),
        ),
      );
  }
  if (!names.some((v) => /E[- ]?13[- ]?B|MICR/i.test(v))) refuse();
  const maps: number[] = [];
  const mapCount = u16(cmap + 2);
  if (mapCount > 128) refuse();
  for (let i = 0; i < mapCount; i++) {
    const at = cmap + 4 + i * 8,
      platform = u16(at),
      encoding = u16(at + 2),
      start = cmap + u32(at + 4);
    if (
      (platform === 0 || (platform === 3 && [1, 10].includes(encoding))) &&
      [4, 12].includes(u16(start))
    )
      maps.push(start);
  }
  const findGlyph = (map: number, cp: number): number => {
    if (u16(map) === 12) {
      const groups = u32(map + 12);
      if (groups > 65536) return refuse() as never;
      for (let i = 0; i < groups; i++) {
        const at = map + 16 + i * 12,
          first = u32(at),
          last = u32(at + 4);
        if (cp >= first && cp <= last) return u32(at + 8) + cp - first;
      }
      return 0;
    }
    const count = u16(map + 6) / 2;
    if (!Number.isInteger(count) || count > 8192) return refuse() as never;
    const end = map + 14,
      start = end + count * 2 + 2,
      delta = start + count * 2,
      ranges = delta + count * 2;
    for (let i = 0; i < count; i++)
      if (cp >= u16(start + i * 2) && cp <= u16(end + i * 2)) {
        const d = u16(delta + i * 2),
          offset = u16(ranges + i * 2);
        if (!offset) return (cp + d) & 65535;
        const g = u16(ranges + i * 2 + offset + 2 * (cp - u16(start + i * 2)));
        return g ? (g + d) & 65535 : 0;
      }
    return 0;
  };
  for (const cp of [...("0123456789 " + (encoding === "unicode" ? "⑆⑈⑉" : "ACD"))].map((c) =>
    c.codePointAt(0)!,
  )) {
    const glyph = maps.map((m) => findGlyph(m, cp)).find((g) => g > 0 && g < glyphs);
    if (!glyph) refuse();
    const advance = u16(hmtx + Math.min(glyph!, metrics - 1) * 4);
    const widthMm = (((advance / units) * 12) / 72) * 25.4;
    if (Math.abs(widthMm - 3.175) > 0.254) refuse();
  }
}
