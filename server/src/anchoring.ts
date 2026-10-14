import { JSDOM } from 'jsdom'
import type { CommentAnchor } from './types.js'

/**
 * Raw textContent of <body>, exactly what slashdocs' bridge anchors
 * start_offset/end_offset index into (verified against the real viewer:
 * jsdom 10/73 == slashdocs stored 10/73 for the same sentence).
 */
export function bodyText(html: string): string {
  const dom = new JSDOM(html)
  return dom.window.document.body?.textContent ?? ''
}

export function normWs(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

export interface Located {
  start: number
  end: number
  mode: 'offsets' | 'exact' | 'fuzzy' | 'none'
  similarity: number | null
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (!a.length) return b.length
  if (!b.length) return a.length
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  const cur = new Array(b.length + 1)
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
    }
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j]
  }
  return prev[b.length]
}

export function similarity(a: string, b: string): number {
  if (!a.length && !b.length) return 1
  const dist = levenshtein(a, b)
  return 1 - dist / Math.max(a.length, b.length)
}

/** Score a candidate match by prefix/suffix agreement + offset proximity. */
function contextScore(
  text: string,
  start: number,
  end: number,
  anchor: CommentAnchor,
): number {
  let score = 0
  if (anchor.prefix) {
    const before = text.slice(Math.max(0, start - anchor.prefix.length), start)
    score += similarity(normWs(before), normWs(anchor.prefix)) * 2
  }
  if (anchor.suffix) {
    const after = text.slice(end, end + anchor.suffix.length)
    score += similarity(normWs(after), normWs(anchor.suffix)) * 2
  }
  if (typeof anchor.start_offset === 'number') {
    const dist = Math.abs(start - anchor.start_offset)
    score += Math.max(0, 1 - dist / 1000)
  }
  return score
}

/**
 * Locate the anchored region in the version the comment was made against.
 * Uses start_offset/end_offset first and confirms they match the quote.
 */
export function locateInOriginal(text: string, anchor: CommentAnchor): Located | null {
  const quote = anchor.quote
  if (!quote) return null
  if (
    typeof anchor.start_offset === 'number' &&
    typeof anchor.end_offset === 'number' &&
    anchor.start_offset >= 0 &&
    anchor.end_offset <= text.length &&
    anchor.start_offset < anchor.end_offset
  ) {
    const slice = text.slice(anchor.start_offset, anchor.end_offset)
    if (normWs(slice) === normWs(quote)) {
      return { start: anchor.start_offset, end: anchor.end_offset, mode: 'offsets', similarity: 1 }
    }
    // offsets disagree with quote; fall through to quote search
  }
  return reanchor(text, anchor, { exactOnly: false })
}

export const FUZZY_WINDOW = 200
export const FUZZY_THRESHOLD = 0.5

function wordDice(a: string, b: string): number {
  const wa = a.toLowerCase().split(/\W+/).filter(Boolean)
  const wb = b.toLowerCase().split(/\W+/).filter(Boolean)
  if (!wa.length || !wb.length) return 0
  const sa = new Map<string, number>()
  for (const w of wa) sa.set(w, (sa.get(w) ?? 0) + 1)
  let shared = 0
  for (const w of wb) {
    const n = sa.get(w) ?? 0
    if (n > 0) {
      shared++
      sa.set(w, n - 1)
    }
  }
  return (2 * shared) / (wa.length + wb.length)
}

/**
 * Re-anchor a TextQuoteSelector into a new version of the text.
 * 1. exact search for quote; multiple matches disambiguated by
 *    prefix/suffix (and offset proximity as tie-breaker).
 * 2. fuzzy fallback: best approximate match within FUZZY_WINDOW chars of the
 *    original offset must clear FUZZY_THRESHOLD similarity.
 */
export function reanchor(
  text: string,
  anchor: CommentAnchor,
  opts: { exactOnly?: boolean } = {},
): Located | null {
  const quote = anchor.quote
  if (!quote) return null

  // exact, raw
  const positions: number[] = []
  let idx = text.indexOf(quote)
  while (idx !== -1) {
    positions.push(idx)
    idx = text.indexOf(quote, idx + 1)
  }
  if (positions.length > 0) {
    let best = positions[0]
    let bestScore = -Infinity
    for (const p of positions) {
      const s = contextScore(text, p, p + quote.length, anchor)
      if (s > bestScore) {
        bestScore = s
        best = p
      }
    }
    return { start: best, end: best + quote.length, mode: 'exact', similarity: 1 }
  }

  // exact, whitespace-normalized (documents often reflow whitespace)
  const nQuote = normWs(quote)
  const hit = findNormalized(text, nQuote)
  if (hit) {
    return { start: hit.start, end: hit.end, mode: 'exact', similarity: 1 }
  }

  if (opts.exactOnly) return null

  // fuzzy: scan a window around the original offset
  const hint = typeof anchor.start_offset === 'number' ? anchor.start_offset : findNormalized(text, nQuote)?.start ?? -1
  if (hint === -1) {
    // no positional hint at all: fuzzy-search the whole document
    return fuzzyBest(text, quote, 0, text.length)
  }
  const lo = Math.max(0, hint - FUZZY_WINDOW)
  const hi = Math.min(text.length, hint + quote.length + FUZZY_WINDOW)
  return fuzzyBest(text, quote, lo, hi)
}

function fuzzyBest(text: string, quote: string, lo: number, hi: number): Located | null {
  let best: Located | null = null
  const region = text.slice(lo, hi)
  // score every sentence fragment in the window; an in-place rewrite of the
  // anchored sentence should out-score unrelated neighbours
  const parts = region.split(/(?<=[.!?;])\s+/)
  let cursor = lo
  for (const part of parts) {
    const s = region.indexOf(part, Math.max(0, cursor - lo))
    const abs = s === -1 ? cursor : lo + s
    cursor = abs + part.length
    const cand = normWs(part)
    if (cand.length < quote.length * 0.3) continue
    const score = Math.max(wordDice(cand, normWs(quote)), similarity(cand, normWs(quote)))
    if (score >= FUZZY_THRESHOLD && (!best || score > (best.similarity ?? 0))) {
      best = { start: abs, end: abs + part.length, mode: 'fuzzy', similarity: score }
    }
  }
  return best
}

/**
 * Find the whitespace-normalized quote inside the raw text and map the
 * match back to raw [start, end) offsets.
 */
function findNormalized(text: string, nQuote: string): { start: number; end: number } | null {
  if (!nQuote) return null
  let n = ''
  const map: number[] = []
  let wsRun = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (/\s/.test(ch)) {
      if (!wsRun && n.length) {
        n += ' '
        map.push(i)
      }
      wsRun = true
    } else {
      n += ch
      map.push(i)
      wsRun = false
    }
  }
  const pos = n.indexOf(nQuote)
  if (pos === -1) return null
  const start = map[pos]
  const end = map[pos + nQuote.length - 1] + 1
  return { start, end }
}
