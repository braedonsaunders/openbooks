/** PDF color inputs are explicit hex colors, never CSS or executable expressions. */
export function pdfColor(value: string | null | undefined, fallback: string): string {
  return value && /^#[0-9a-f]{6}$/i.test(value) ? value : fallback
}

/** Choose the stronger WCAG contrast for legible dark and saturated cell fills. */
export function pdfContrastText(background: string): string {
  const hex = pdfColor(background, '#ffffff').slice(1)
  const channels = [0, 2, 4].map(offset => {
    const channel = parseInt(hex.slice(offset, offset + 2), 16) / 255
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  })
  const luminance = channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722
  return (luminance + 0.05) / 0.05 >= 1.05 / (luminance + 0.05) ? '#000000' : '#ffffff'
}
