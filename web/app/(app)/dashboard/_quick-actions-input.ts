import { z } from 'zod'
import { MAX_QUICK_ACTIONS } from './_quick-actions-shared'

// '//' is rejected explicitly: protocol-relative hrefs ('//evil.com') would
// otherwise pass the internal-path check and navigate off-site.
const safeHref = (href: string) =>
  (href.startsWith('/') && !href.startsWith('//')) || /^https?:\/\//i.test(href)

const QuickActionSchema = z.object({
  id: z.string().min(1).max(64),
  label: z.string().trim().min(1).max(80),
  href: z
    .string()
    .trim()
    .min(1)
    .max(2048)
    .refine(safeHref, 'Link must be an internal path or http(s) URL'),
  iconKey: z.string().min(1).max(48),
  tone: z.string().min(1).max(24),
})

export const QuickActionsSchema = z.array(QuickActionSchema).max(MAX_QUICK_ACTIONS)
