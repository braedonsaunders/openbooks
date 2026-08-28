'use client'

/**
 * Client-side CSV download, shared by every analytics table. Values are
 * quoted-escaped; numbers pass through raw so spreadsheets parse them.
 */
export function exportCsv(
  filename: string,
  headers: string[],
  rows: (string | number | null | undefined)[][],
  today: string,
) {
  // Spreadsheet applications treat cells beginning with these characters as
  // formulas. Prefix user-authored strings with an apostrophe so exported
  // tenant data is opened as text instead of being executed. Plain numeric
  // strings (including negative values) are safe to leave numeric.
  const CSV_FORMULA_PREFIX = /^[=+\-@\t\r]/
  const PLAIN_NUMBER = /^-?\d+(?:[.,]\d+)?$/

  const cell = (v: string | number | null | undefined): string => {
    if (v === null || v === undefined) return ''
    if (typeof v === 'number') return String(v)
    const raw = String(v)
    const s = CSV_FORMULA_PREFIX.test(raw) && !PLAIN_NUMBER.test(raw) ? `'${raw}` : raw
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const base = filename.endsWith('.csv') ? filename.slice(0, -4) : filename
  const stamped = `${base}-${today}.csv`
  const csv = [headers, ...rows].map((r) => r.map(cell).join(',')).join('\n')
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = stamped
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}
