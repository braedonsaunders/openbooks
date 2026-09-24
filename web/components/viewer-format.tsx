'use client'

import { useViewerFormat } from '@/lib/viewer-format'

export function ViewerDateTime({
  value,
  options,
}: {
  value: Date | string
  options?: Intl.DateTimeFormatOptions
}) {
  const { dateTime } = useViewerFormat()
  return <>{dateTime(value instanceof Date ? value : new Date(value), options)}</>
}

export function ViewerNumber({
  value,
  options,
}: {
  value: number
  options?: Intl.NumberFormatOptions
}) {
  const { number } = useViewerFormat()
  return <>{number(value, options)}</>
}
