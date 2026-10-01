'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { Select } from '@openbooks/ui'

/** Choose a configuration family without stacking two tab bars. */
export function NavigationPicker({ label, value, options }: {
  label: string
  value: string
  options: { key: string; label: string; href: string }[]
}) {
  const router = useRouter()
  const search = useSearchParams()
  return <Select aria-label={label} value={value} className="w-full sm:w-64" onChange={(event) => {
    const option = options.find((item) => item.key === event.target.value)
    if (!option) return
    const url = new URL(option.href, 'https://navigation.invalid')
    for (const key of ['sub', 'book']) {
      const lens = search?.get(key)
      if (lens && !url.searchParams.has(key)) url.searchParams.set(key, lens)
    }
    router.push(`${url.pathname}${url.search}` as never)
  }}>
    {options.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}
  </Select>
}
