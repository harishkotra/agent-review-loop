import { diff_match_patch, DIFF_INSERT, DIFF_DELETE, DIFF_EQUAL } from 'diff-match-patch'

export interface ChurnResult {
  totalChanged: number
  changedInsideAnchors: number
  changedOutsideAnchors: number
  /** outside / total, or null when nothing changed at all */
  collateralChurn: number | null
}

type Interval = [number, number]

function overlaps(a: Interval, b: Interval): boolean {
  return a[0] < b[1] && b[0] < a[1]
}

/**
 * Character-level v1->v2 diff. A changed run counts as "inside" an anchor if
 * it overlaps any comment's v1 span or v2 re-anchored span.
 */
export function computeChurn(v1text: string, v2text: string, intervals: Interval[]): ChurnResult {
  const dmp = new diff_match_patch()
  const diffs = dmp.diff_main(v1text, v2text)
  dmp.diff_cleanupSemantic(diffs)

  let pos1 = 0
  let pos2 = 0
  let totalChanged = 0
  let inside = 0
  for (const [op, data] of diffs) {
    const len = data.length
    if (op === DIFF_EQUAL) {
      pos1 += len
      pos2 += len
      continue
    }
    if (op === DIFF_DELETE) {
      const iv: Interval = [pos1, pos1 + len]
      const isInside = intervals.some(a => overlaps(a, iv))
      totalChanged += len
      if (isInside) inside += len
      pos1 += len
    } else if (op === DIFF_INSERT) {
      const iv: Interval = [pos2, pos2 + len]
      const isInside = intervals.some(a => overlaps(a, iv))
      totalChanged += len
      if (isInside) inside += len
      pos2 += len
    }
  }
  const outside = totalChanged - inside
  return {
    totalChanged,
    changedInsideAnchors: inside,
    changedOutsideAnchors: outside,
    collateralChurn: totalChanged === 0 ? null : outside / totalChanged,
  }
}
