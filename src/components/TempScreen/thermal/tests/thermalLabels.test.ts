import { describe, expect, it } from 'vitest'
import { layoutThermalLabels } from '../thermalLabels'

describe('thermal region labels', () => {
  it('separates all six labels even when perspective projects them onto one point', () => {
    const labels = layoutThermalLabels(Array.from({ length: 6 }, () => ({ x: 160, y: 150, width: 48, height: 31 })), 320, 300)
    labels.forEach((label, i) => {
      expect(label.y - label.height / 2).toBeGreaterThanOrEqual(4)
      expect(label.y + label.height / 2).toBeLessThanOrEqual(296)
      for (const other of labels.slice(i + 1)) expect(Math.abs(label.y - other.y)).toBeGreaterThanOrEqual(35)
    })
  })
  it('keeps readable callouts within the viewport when zooming in', () => {
    const labels = layoutThermalLabels([{ x: -80, y: -20, width: 48, height: 31 }, { x: 900, y: 400, width: 48, height: 31 }], 320, 300)
    expect(labels[0]).toMatchObject({ x: 28, y: 19.5 })
    expect(labels[1]).toMatchObject({ x: 292, y: 280.5 })
  })
})
