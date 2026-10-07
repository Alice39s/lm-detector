export const REPOSITORY_URL = 'https://github.com/Ikaleio/lm-detector'
const ANSWER_KEY = 'fingerpoint-star-prompt-v1'
const DECLINE_PERIOD = 7 * 24 * 60 * 60 * 1000

/** `starred` after following a Star entry, `declined` to hide the request for a week. */
export type StarAnswer = 'starred' | 'declined'
/** Keeps the answer for this page when storage is unavailable. */
let answered = false

/** Whether toasts may ask for a Star: never after a Star, again a week after a decline. */
export function starPromptAllowed(): boolean {
  if (answered) return false
  let stored: string | null
  try { stored = localStorage.getItem(ANSWER_KEY) } catch { return true }
  if (stored === null) return true
  if (stored === 'starred') return false
  return Date.now() - Number(stored) >= DECLINE_PERIOD
}

/** Stores `starred`, or the time of a decline. */
export function answerStarPrompt(answer: StarAnswer) {
  answered = true
  try { localStorage.setItem(ANSWER_KEY, answer === 'starred' ? answer : String(Date.now())) } catch { /* storage unavailable: the answer lasts for this page */ }
}

export const markStarVisited = () => answerStarPrompt('starred')
