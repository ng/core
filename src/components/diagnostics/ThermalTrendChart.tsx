'use client'

import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from 'recharts'

import { TOOLTIP_LABEL_STYLE, TOOLTIP_STYLE } from '@/src/components/Sensors/chartTheme'
import { fmtF, type ThermalTrendPoint } from './diagnosticsLogic'

export type { ThermalTrendPoint }

const SIDE_COLOR = { left: 'var(--accent-cool)', right: 'var(--accent-warm)' } as const

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

/**
 * Per-side temperature trend for the Thermal page. The whole point is to make a
 * stalled pump visible: when flow stops, `water` and `bed` flatline away from
 * `target` even though the side reads as powered. A snapshot can't show that —
 * the divergence over time can.
 */
export function ThermalTrendChart({ side, points, height = 70 }: { side: 'left' | 'right', points: ThermalTrendPoint[], height?: number }) {
  if (points.length < 2) {
    return (
      <div className="flex items-center justify-center text-xs text-fg-3" style={{ height }}>
        Collecting samples… (updates every 5s)
      </div>
    )
  }

  const temps = points.flatMap(p => [p.target, p.bed, p.water].filter((v): v is number => v != null))
  // An off side reports null target/bed (no level-0 phantom), so a window with
  // no water reading either leaves temps empty — Math.min/max would then yield
  // ±Infinity and hand the Y-axis an invalid domain.
  if (temps.length === 0) {
    return (
      <div className="flex items-center justify-center text-xs text-fg-3" style={{ height }}>
        No temperature data yet
      </div>
    )
  }
  const min = Math.floor(Math.min(...temps) - 2)
  const max = Math.ceil(Math.max(...temps) + 2)
  const color = SIDE_COLOR[side]

  return (
    <div className="w-full" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%" minWidth={1} minHeight={1}>
        <LineChart data={points} margin={{ top: 2, right: 0, left: 0, bottom: 2 }}>
          <CartesianGrid vertical={false} horizontal={false} />
          <XAxis
            dataKey="t"
            type="number"
            domain={['dataMin', 'dataMax']}
            tickFormatter={fmtTime}
            hide
          />
          <YAxis
            domain={[min, max]}
            tickFormatter={(v: number) => `${Math.round(v)}°`}
            hide
          />
          <Tooltip
            contentStyle={TOOLTIP_STYLE}
            labelStyle={TOOLTIP_LABEL_STYLE}
            labelFormatter={v => new Date(v as number).toLocaleTimeString()}
            formatter={(value, name) => [fmtF(value == null ? null : Number(value)), String(name)]}
          />
          <Line type="monotone" dataKey="water" name="Water" stroke={color} strokeWidth={1} strokeOpacity={0.35} dot={false} connectNulls isAnimationActive={false} />
          <Line type="monotone" dataKey="target" name="Target" stroke={color} strokeWidth={1.75} strokeDasharray="4 4" dot={false} connectNulls isAnimationActive={false} />
          <Line type="monotone" dataKey="bed" name="Bed" stroke="var(--text-1)" strokeWidth={1.75} dot={false} activeDot={{ r: 3, fill: 'var(--text-1)' }} connectNulls isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}
