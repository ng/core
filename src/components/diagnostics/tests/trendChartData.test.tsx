import type { ReactNode } from 'react'
import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BiometricsTrendChart, type VitalSample } from '../BiometricsTrendChart'

// Capture the public chart boundary: assert the data and formatters we hand to
// Recharts without depending on ResizeObserver/layout or its SVG internals.
const chart = vi.hoisted(() => ({
  data: [] as Array<Record<string, number | null>>,
  axes: [] as Array<{ domain?: unknown, tickFormatter?: (value: number) => string }>,
  tooltip: null as { formatter: (value: number | null, name: string) => string[], labelFormatter: (value: number) => string } | null,
}))
vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children: ReactNode }) => children,
  LineChart: ({ data, children }: { data: typeof chart.data, children: ReactNode }) => {
    chart.data = data
    return children
  },
  XAxis: (props: (typeof chart.axes)[number]) => {
    chart.axes.push(props)
    return null
  },
  YAxis: (props: (typeof chart.axes)[number]) => {
    chart.axes.push(props)
    return null
  },
  Tooltip: (props: NonNullable<typeof chart.tooltip>) => {
    chart.tooltip = props
    return null
  },
  Line: () => null,
  CartesianGrid: () => null,
  Legend: () => null,
}))

beforeEach(() => {
  chart.data = []
  chart.axes = []
  chart.tooltip = null
})
afterEach(cleanup)

describe('BiometricsTrendChart data', () => {
  it('sorts without mutating input, retaining nulls and distinct vital series', () => {
    const rows: VitalSample[] = [
      { timestamp: new Date(3000), heartRate: 63, hrv: 41, breathingRate: 12.5 },
      { timestamp: new Date(1000).toISOString(), heartRate: null, hrv: 0, breathingRate: null },
    ]
    const original = structuredClone(rows)
    render(<BiometricsTrendChart rows={rows} />)
    expect(chart.data).toEqual([
      { t: 1000, hr: null, hrv: 0, br: null },
      { t: 3000, hr: 63, hrv: 41, br: 12.5 },
    ])
    expect(rows).toEqual(original)
  })

  it('downsamples a long history in chronological order and always retains the latest sample', () => {
    const rows = Array.from({ length: 242 }, (_, i) => ({
      timestamp: new Date(i * 60_000), heartRate: i, hrv: null, breathingRate: null,
    })).reverse()
    render(<BiometricsTrendChart rows={rows} />)
    expect(chart.data).toHaveLength(122)
    expect(chart.data[0]).toEqual({ t: 0, hr: 0, hrv: null, br: null })
    expect(chart.data[1]).toEqual({ t: 120_000, hr: 2, hrv: null, br: null })
    expect(chart.data.at(-1)).toEqual({ t: 241 * 60_000, hr: 241, hrv: null, br: null })
    expect(chart.data.every((point, i) => i === 0 || Number(point.t) > Number(chart.data[i - 1].t))).toBe(true)
    expect(rows[0].heartRate).toBe(241)
  })

  it('formats missing values, whole HR/HRV and fractional breathing independently', () => {
    render(<BiometricsTrendChart rows={[0, 1000].map(t => ({ timestamp: new Date(t), heartRate: 60, hrv: 40, breathingRate: 12 }))} />)
    expect(chart.tooltip?.formatter(null, 'HR')).toEqual(['—', 'HR'])
    expect(chart.tooltip?.formatter(60.6, 'HR')).toEqual(['61', 'HR'])
    expect(chart.tooltip?.formatter(40.4, 'HRV')).toEqual(['40', 'HRV'])
    expect(chart.tooltip?.formatter(12.56, 'Breathing')).toEqual(['12.6', 'Breathing'])
    const time = new Date(1000)
    expect(chart.tooltip?.labelFormatter(1000)).toBe(time.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }))
    expect(chart.axes[0].tickFormatter?.(1000)).toBe(time.toLocaleDateString([], { weekday: 'short' }))
  })
})
