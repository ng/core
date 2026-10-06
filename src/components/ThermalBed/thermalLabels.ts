export interface ThermalLabelBox { x: number, y: number, width: number, height: number }

/** Keep six screen-facing callouts legible when perspective compresses the inner regions. */
export function layoutThermalLabels(anchors: ThermalLabelBox[], width: number, height: number): ThermalLabelBox[] {
  const placed: ThermalLabelBox[] = []
  const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value))
  for (const anchor of anchors) {
    const x = clamp(anchor.x, anchor.width / 2 + 4, width - anchor.width / 2 - 4)
    let candidate = { ...anchor, x }
    for (let step = 0; step < 20; step++) {
      const offset = Math.ceil(step / 2) * (anchor.height + 5) * (step % 2 ? -1 : 1)
      candidate = { ...anchor, x, y: clamp(anchor.y + offset, anchor.height / 2 + 4, height - anchor.height / 2 - 4) }
      const overlaps = placed.some(other => Math.abs(other.x - candidate.x) < (other.width + candidate.width) / 2 + 4
        && Math.abs(other.y - candidate.y) < (other.height + candidate.height) / 2 + 4)
      if (!overlaps) break
    }
    placed.push(candidate)
  }
  return placed
}
