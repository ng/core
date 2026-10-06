import { describe, expect, it } from 'vitest'
import { CALLOUT, layoutCallouts } from '../thermalLabels'
import type { CalloutAnchor, CalloutPlacement } from '../thermalLabels'

const label = { width: 64, height: 30 }
const box = (anchor: CalloutAnchor, p: CalloutPlacement) => {
  const left = p.align === 'left' ? p.x : p.x - anchor.width
  const bottom = anchor.y - p.length
  return { left, right: left + anchor.width, top: bottom - anchor.height, bottom }
}
const expectNoCollisions = (anchors: CalloutAnchor[], placed: CalloutPlacement[], leaders = true) => {
  placed.forEach((p, i) => {
    const a = box(anchors[i], p)
    placed.forEach((q, j) => {
      if (i === j) return
      const b = box(anchors[j], q)
      const textOverlap = a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
      expect(textOverlap, `labels ${i} and ${j} overlap`).toBe(false)
      if (!leaders) return
      const leaderThrough = q.x > a.left && q.x < a.right && anchors[j].y - q.length < a.bottom && anchors[j].y > a.top
      expect(leaderThrough, `leader ${j} cuts through label ${i}`).toBe(false)
    })
  })
}

describe('anchored thermal callouts', () => {
  it('stacks leaders into tiers when every anchor projects onto one point', () => {
    const anchors = Array.from({ length: 6 }, () => ({ x: 160, y: 320, ...label }))
    const placed = layoutCallouts(anchors, 320, 360)
    // Shared leaders cannot avoid each other, but the text never overlaps.
    expectNoCollisions(anchors, placed, false)
    placed.forEach(p => expect(p.x).toBe(160))
    expect(new Set(placed.map(p => p.length)).size).toBe(6)
  })

  it('keeps labels at one height when they fit side by side', () => {
    const anchors = [{ x: 40, y: 250, ...label }, { x: 200, y: 250, ...label }]
    expect(layoutCallouts(anchors, 320, 300).map(p => p.length)).toEqual([CALLOUT.base, CALLOUT.base])
  })

  it('never lets a leader cut through a neighbour\'s text for the six staggered bed anchors', () => {
    // Screen positions of the six anchors at the default thermal camera (CSS px, 958 × 360 host).
    const anchors: CalloutAnchor[] = [
      { x: 372, y: 228, ...label }, { x: 428, y: 170, ...label }, { x: 470, y: 128, ...label },
      { x: 505, y: 112, ...label }, { x: 560, y: 150, ...label }, { x: 640, y: 196, ...label },
    ]
    const placed = layoutCallouts(anchors, 958, 360)
    expectNoCollisions(anchors, placed)
  })

  it('flips text to the left of the leader near the right edge and shortens leaders near the top', () => {
    const placed = layoutCallouts([{ x: 300, y: 60, ...label }, { x: -20, y: 250, ...label }], 320, 300)
    expect(placed[0].align).toBe('right')
    expect(placed[0].length).toBeLessThan(CALLOUT.base)
    expect(placed[0].length).toBeGreaterThanOrEqual(CALLOUT.minLength)
    expect(placed[1].x).toBe(CALLOUT.margin)
    expect(placed[1].align).toBe('left')
  })
})
