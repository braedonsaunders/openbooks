'use client'

import { useState } from 'react'
import { cn } from '@openbooks/ui'

const AVATAR_TONES = [
  'bg-teal-100 text-teal-700 dark:bg-teal-950/70 dark:text-teal-300',
  'bg-indigo-100 text-indigo-700 dark:bg-indigo-950/70 dark:text-indigo-300',
  'bg-violet-100 text-violet-700 dark:bg-violet-950/70 dark:text-violet-300',
  'bg-amber-100 text-amber-700 dark:bg-amber-950/70 dark:text-amber-300',
  'bg-sky-100 text-sky-700 dark:bg-sky-950/70 dark:text-sky-300',
  'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/70 dark:text-emerald-300',
  'bg-rose-100 text-rose-700 dark:bg-rose-950/70 dark:text-rose-300',
] as const

export function avatarInitials(name: string | null): string {
  return (name ?? '')
    .trim()
    .split(/\s+/)
    .filter((part) => /^\p{L}/u.test(part))
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join('')
}

/**
 * A party's picture: its photo or logo when one is set, otherwise initials
 * in a tone derived from the name, so the same party keeps the same colour
 * on every surface. People are round; companies are a rounded square.
 * Decorative — the name beside it carries the meaning.
 */
export function PartyAvatar({
  name,
  photoUrl,
  shape = 'round',
  className,
}: {
  name: string | null
  photoUrl?: string | null
  shape?: 'round' | 'square'
  className?: string
}) {
  const label = (name ?? '').trim()
  // A photo that cannot be served (removed, or a sandbox without file
  // bytes) falls back to initials instead of a broken image.
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  let hash = 0
  for (const char of label) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  const frame = cn(
    'grid h-8 w-8 shrink-0 place-items-center overflow-hidden text-[11px] font-semibold',
    shape === 'round' ? 'rounded-full' : 'rounded-lg',
    className,
  )
  if (photoUrl && failedUrl !== photoUrl) {
    return (
      <span aria-hidden className={cn(frame, 'bg-slate-100 dark:bg-slate-800')}>
        {/* eslint-disable-next-line @next/next/no-img-element -- session-authenticated bytes; the image optimizer cannot forward the session */}
        <img src={photoUrl} alt="" className="h-full w-full object-cover" draggable={false} onError={() => setFailedUrl(photoUrl)} />
      </span>
    )
  }
  return (
    <span aria-hidden className={cn(frame, AVATAR_TONES[hash % AVATAR_TONES.length])}>
      {avatarInitials(label) || '·'}
    </span>
  )
}
