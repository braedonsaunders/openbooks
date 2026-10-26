/**
 * Join a refusal and remedy for a one-line surface. Complete sentences
 * retain their punctuation; a clause keeps the house dash join regardless
 * of how its remedy is capitalized. Japanese and Chinese sentences use
 * their full stop and join without an added space.
 */

const TERMINAL = /[.!?。！？…]$/;
const FULL_WIDTH = /[\u3000-\u9fff\uff00-\uffef]/;

export function joinRefusal(message: string, remedy: string | null | undefined): string {
  const head = message.trim().replace(/\s*[—–]\s*$/, "");
  const tail = (remedy ?? "").trim();
  if (tail === "") return head;
  if (head === "") return tail;
  if (head.includes(tail)) return head;
  const fullWidth = FULL_WIDTH.test(head.slice(-1));
  if (TERMINAL.test(head)) return fullWidth ? `${head}${tail}` : `${head} ${tail}`;
  return fullWidth ? `${head}。${tail}` : `${head} — ${tail}`;
}
