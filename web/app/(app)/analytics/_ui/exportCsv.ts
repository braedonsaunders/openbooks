'use client'

/**
 * Client-side CSV download — Gantry's exportToCSV, shared by every analytics
 * table. Values are quoted-escaped; numbers pass through raw so spreadsheets
 * parse them.
 */
export function exportCsv(
  filename: string,
  headers: string[],
  rows: (string | number | null | undefined)[][],
) {
  const cell = (v: string | number | null | undefined): string => {
    if (v === null || v === undefined) return ''
    if (typeof v === 'number') return String(v)
    const s = String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const csv = [headers, ...rows].map((r) => r.map(cell).join(',')).join('\n')
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename.endsWith('.csv') ? filename : `${filename}.csv`
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}
