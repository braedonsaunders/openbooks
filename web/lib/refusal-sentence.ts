/**
 * One reading of a refusal and its remedy, for surfaces that show them as
 * one line (toasts, pinned alerts, notices). A refusal written as a
 * sentence is followed by its remedy as the next sentence; one that does
 * not end a sentence is closed with the script's full stop first. A refusal
 * written as a clause (lower-case remedy, no full stop) keeps the house
 * dash join, so "rate is not configured — add a rate in Company Settings"
 * reads as one sentence. Japanese and Chinese sentences join without a space.
 */

const TERMINAL = /[.!?。！？…]$/
const FULL_WIDTH = /[\u3000-\u9fff\uff00-\uffef]/

export function joinRefusal(message: string, remedy: string | null | undefined): string {
  const head = message.trim().replace(/\s*[—–]\s*$/, '')
  const tail = (remedy ?? '').trim()
  if (tail === '') return head
  if (head === '') return tail
  if (head.includes(tail)) return head
  const fullWidth = FULL_WIDTH.test(head.slice(-1))
  if (TERMINAL.test(head)) return fullWidth ? `${head}${tail}` : `${head} ${tail}`
  if (/^\p{Ll}/u.test(tail)) return `${head} — ${tail}`
  return fullWidth ? `${head}。${tail}` : `${head}. ${tail}`
}
