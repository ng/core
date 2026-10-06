export interface CalloutAnchor { x: number, y: number, width: number, height: number }
export interface CalloutPlacement {
  x: number
  y: number
  /** Vertical leader length in px from the anchor up to the label. */
  length: number
  /** Which side of the leader the text sits on. */
  align: 'left' | 'right'
}

export const CALLOUT = { base: 44, step: 30, minLength: 14, gap: 8, margin: 4 } as const
/** Tiers are spaced so a label on one never touches the label on the next. */
const tierStep = (anchor: CalloutAnchor) => Math.max(CALLOUT.step, anchor.height + CALLOUT.gap)

interface Box { left: number, right: number, top: number, bottom: number }
interface Leader { x: number, top: number, bottom: number }
interface Placed { anchor: CalloutAnchor, x: number, length: number, align: 'left' | 'right', box: Box, leader: Leader }

const overlaps = (a: Box, b: Box, g: number) => a.left < b.right + g && a.right > b.left - g && a.top < b.bottom + g && a.bottom > b.top - g
const through = (leader: Leader, box: Box, g: number) => leader.x > box.left - g && leader.x < box.right + g && leader.top < box.bottom && leader.bottom > box.top

/**
 * Anchored callouts: each label rides straight up from its point on the model on a thin
 * leader, so it stays attached while the bed rotates. Text sits to the right of its leader,
 * or to the left near the right edge. Labels whose text would collide with another label
 * or cross another leader take the next tier up; a label that another leader would cut
 * through flips to the other side of its own leader; leaders shorten rather than push a
 * label off the top.
 */
export function layoutCallouts(anchors: CalloutAnchor[], width: number, height: number): CalloutPlacement[] {
  const g = CALLOUT.gap
  const order = anchors.map((anchor, i) => i).sort((a, b) => anchors[a].x - anchors[b].x)
  const placed: Placed[] = []
  const result: Placed[] = new Array(anchors.length)
  const make = (anchor: CalloutAnchor, x: number, length: number, align: 'left' | 'right'): Placed => {
    const left = align === 'left' ? x : x - anchor.width
    const bottom = anchor.y - length
    return { anchor, x, length, align, box: { left, right: left + anchor.width, top: bottom - anchor.height, bottom }, leader: { x, top: bottom, bottom: anchor.y } }
  }
  const collides = (c: Placed, others: Placed[]) => others.some(o => overlaps(c.box, o.box, g) || through(o.leader, c.box, g))
  for (const i of order) {
    const anchor = anchors[i]
    const x = Math.max(CALLOUT.margin, Math.min(width - CALLOUT.margin, anchor.x))
    const preferred: 'left' | 'right' = x + anchor.width + CALLOUT.margin > width ? 'right' : 'left'
    const other: 'left' | 'right' = preferred === 'left' ? 'right' : 'left'
    // Never push the text above the top edge; shorten the leader instead.
    const room = anchor.y - anchor.height - CALLOUT.margin
    let chosen: Placed | undefined
    for (let tier = 0; tier < 8 && !chosen; tier++) {
      const length = Math.max(CALLOUT.minLength, Math.min(CALLOUT.base + tier * tierStep(anchor), room))
      for (const align of [preferred, other]) {
        const candidate = make(anchor, x, length, align)
        const fits = (align === 'left' ? candidate.box.right <= width - CALLOUT.margin : candidate.box.left >= CALLOUT.margin)
        if ((fits || align === preferred) && !collides(candidate, placed)) {
          chosen = candidate
          break
        }
      }
      if (!chosen && length >= room) chosen = make(anchor, x, length, preferred)
    }
    const final = chosen ?? make(anchor, x, CALLOUT.minLength, preferred)
    placed.push(final)
    result[i] = final
  }
  // A later leader may cut through an earlier label's text: move that text to the other
  // side of its leader, or failing that lift it clear of the crossing leader.
  for (let pass = 0; pass < 2; pass++) {
    for (const item of placed) {
      const rest = placed.filter(o => o !== item)
      if (!rest.some(o => through(o.leader, item.box, g))) continue
      const flipped = make(item.anchor, item.x, item.length, item.align === 'left' ? 'right' : 'left')
      const inside = flipped.box.left >= CALLOUT.margin && flipped.box.right <= width - CALLOUT.margin
      if (inside && !collides(flipped, rest)) {
        Object.assign(item, flipped)
        continue
      }
      const room = item.anchor.y - item.anchor.height - CALLOUT.margin
      for (let tier = 1; tier < 8; tier++) {
        const length = Math.min(item.length + tier * tierStep(item.anchor), room)
        const lifted = make(item.anchor, item.x, length, item.align)
        if (!collides(lifted, rest)) {
          Object.assign(item, lifted)
          break
        }
        if (length >= room) break
      }
    }
  }
  return result.map(({ x, length, align, anchor }) => ({
    x,
    y: Math.min(height - CALLOUT.margin, Math.max(anchor.height + length + CALLOUT.margin, anchor.y)),
    length,
    align,
  }))
}
