'use client'

import { useMemo } from 'react'
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from 'recharts'
import { AXIS_TICK, TOOLTIP_LABEL_STYLE, TOOLTIP_STYLE } from '@/src/components/Sensors/chartTheme'

export interface VitalSample {
  timestamp: Date | string
  heartRate: number | null
  hrv: number | null
  breathingRate: number | null
}

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })
}

/**
 * Week-long vitals trend for the Biometrics page. HR and HRV share the left
 * axis (similar magnitude); breathing rate gets its own right axis so it isn't
 * crushed flat against the bottom. Downsampled to keep the line responsive.
 */
export function BiometricsTrendChart({ rows }: { rows: VitalSample[] }) {
  const data = useMemo(() => {
    const points = rows
      .map(r => ({
        t: new Date(r.timestamp).getTime(),
        hr: r.heartRate,
        hrv: r.hrv,
        br: r.breathingRate,
      }))
      .sort((a, b) => a.t - b.t)
    const maxPoints = 120
    const step = Math.max(1, Math.floor(points.length / maxPoints))
    return step > 1 ? points.filter((_, i) => i % step === 0 || i === points.length - 1) : points
  }, [rows])

  if (data.length < 2) {
    return (
      <div className="flex h-[180px] items-center justify-center text-xs text-fg-3">
        Not enough vitals to plot a trend
      </div>
    )
  }

  return (
    <div className="h-[180px] w-full">
      <ResponsiveContainer width="100%" height="100%" minWidth={1} minHeight={1}>
        <LineChart data={data} margin={{ top: 4, right: 4, left: -16, bottom: 0 }}>
          <CartesianGrid vertical={false} stroke="var(--border-grid)" />
          <XAxis
            dataKey="t"
            type="number"
            domain={['dataMin', 'dataMax']}
            tickFormatter={(v: number) => new Date(v).toLocaleDateString([], { weekday: 'short' })}
            tick={AXIS_TICK}
            axisLine={false}
            tickLine={false}
            tickCount={5}
          />
          <YAxis yAxisId="bpm" tick={AXIS_TICK} axisLine={false} tickLine={false} />
          <YAxis yAxisId="br" orientation="right" tick={AXIS_TICK} axisLine={false} tickLine={false} width={28} />
          <Tooltip
            contentStyle={TOOLTIP_STYLE}
            labelStyle={TOOLTIP_LABEL_STYLE}
            labelFormatter={v => fmtTime(v as number)}
            formatter={(value, name) => [value == null ? '—' : Number(value).toFixed(name === 'Breathing' ? 1 : 0), String(name)]}
          />
          <Legend iconType="plainline" iconSize={10} wrapperStyle={{ fontSize: 11, color: 'var(--text-2)' }} align="center" />
          <Line yAxisId="bpm" type="monotone" dataKey="hr" name="HR" stroke="var(--chart-hr)" strokeWidth={1.5} dot={false} activeDot={{ r: 3, fill: 'var(--chart-hr)' }} connectNulls />
          <Line yAxisId="bpm" type="monotone" dataKey="hrv" name="HRV" stroke="var(--stage-rem)" strokeWidth={1.5} dot={false} activeDot={{ r: 3, fill: 'var(--stage-rem)' }} connectNulls />
          <Line yAxisId="br" type="monotone" dataKey="br" name="Breathing" stroke="var(--accent-cool)" strokeWidth={1} strokeOpacity={0.7} dot={false} connectNulls />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}
