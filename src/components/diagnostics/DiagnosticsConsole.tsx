'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import type { inferRouterOutputs } from '@trpc/server'
import type { AppRouter } from '@/src/server/routers/app'
import { trpc } from '@/src/utils/trpc'
import { useSideNames } from '@/src/hooks/useSideNames'
import { useTrendBuffer } from '@/src/hooks/useTrendBuffer'
import {
  Badge, Card, CardHeader, InlineError, KeyValue, Metric, SegmentedControl, Skeleton, StatusDot,
} from '@/src/components/ds'
import { cn } from '@/lib/utils'
import {
  fmtF, fmtAge, fmtRel, fmtClock, fmtDayLabel,
  buildWeekLanes, jobTone, fmtJobValue, thermalDirection,
  type SchedJob, type ThermalSideSnapshot,
} from '@/src/components/diagnostics/diagnosticsLogic'
import { DiagTable, type DiagColumn } from './DiagTable'
import { DashboardPanel } from './DashboardPanel'
import { ThermalHistoryChart, type ThermalChartData } from './ThermalHistoryChart'
import { availabilityOf, liveToPoints, type LiveThermalSample, type PanelDef } from './thermalHistoryLogic'
import { langFromPath } from '@/src/components/AppShell/navItems'
import { useTemperatureUnit } from '@/src/hooks/useTemperatureUnit'
import { CalibrationPanel } from './CalibrationPanel'
import { SectionTitle, sideTitle } from './parts'
import { HealthPanel } from './HealthPanel'

// Formatting, scheduler-lane, and biometrics/thermal derivations live in
// ./diagnosticsLogic so they can be unit-tested without React/tRPC.

// ── Sections ─────────────────────────────────────────────────────────────────

/** The System pages this console renders; System owns navigation. */
export type DiagSection = 'dashboard' | 'calibration' | 'health' | 'scheduler' | 'thermal'

/** 30 minutes of thermal samples at the 5s poll. */
const THERMAL_HISTORY_POINTS = 360

type ThermalData = inferRouterOutputs<AppRouter>['health']['thermal']
type ThermalSide = ThermalData['sides'][number]
type ThermalHistory = Array<LiveThermalSample & { sides: ThermalSideSnapshot[] }>

/**
 * The pod's diagnostic pages under System (Dashboard, thermal delivery,
 * scheduler, service health, calibration). Kept as one component
 * so the thermal trend buffer survives switching between Dashboard and Thermal.
 */
export function DiagnosticsConsole({ section, onJump }: { section: DiagSection, onJump: (s: DiagSection) => void }) {
  const thermal = trpc.health.thermal.useQuery({}, { refetchInterval: 5000 })
  const history = useTrendBuffer(thermal.data, thermal.dataUpdatedAt, THERMAL_HISTORY_POINTS) as ThermalHistory

  return (
    <div className="flex min-w-0 flex-col gap-3.5">
      {section === 'dashboard' && <DashboardPanel thermal={thermal.data} onJump={onJump} />}
      {section === 'thermal' && <ThermalPanel thermal={thermal} history={history} />}
      {section === 'scheduler' && <SchedulerPanel />}
      {section === 'health' && <HealthPanel onJump={onJump} />}
      {section === 'calibration' && <CalibrationPanel />}
    </div>
  )
}

// ── Overview ─────────────────────────────────────────────────────────────────

interface ThermalQuery {
  data: ThermalData | undefined
  isLoading: boolean
  isFetching: boolean
  error: { message: string } | null
}

// ── Thermal ──────────────────────────────────────────────────────────────────

function ThermalSideCard({ side: s }: { side: ThermalSide }) {
  const { sideName } = useSideNames()
  const side = s.side as 'left' | 'right'
  const dir = thermalDirection(s)
  const stalled = s.verdict === 'stalled'

  return (
    <Card tone={stalled ? 'danger' : undefined} data-testid={`thermal-${side}`}>
      <CardHeader
        title={sideTitle(sideName(side), side)}
        right={<span className={cn('font-mono text-[11px] tracking-[0.06em]', dir.className)}>{dir.label}</span>}
      />
      {s.note && <p className="text-xs text-danger">{s.note}</p>}
      <div className="grid grid-cols-2 gap-x-3 gap-y-2.5">
        <KeyValue label="Target" value={s.isPowered ? fmtF(s.targetTempF) : 'off'} />
        <KeyValue label="Bed" value={fmtF(s.currentTempF)} />
        <KeyValue label="Pump · rpm" value={s.pumpRpm == null ? '—' : s.pumpRpm.toLocaleString()} />
        <KeyValue label="Water" value={fmtF(s.waterTempF)} />
        <KeyValue label="Surface" value={fmtF(s.bedSurfaceTempF)} />
        <KeyValue label="Flow age" value={fmtAge(s.readingAgeSec)} />
      </div>
      {(s.guardBlocked || s.isAlarmVibrating || s.poweredOnAt) && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-fg-2">
          {s.guardBlocked && <Badge className="border-danger-line text-danger">GUARD BLOCKED</Badge>}
          {s.isAlarmVibrating && <Badge className="border-warn-line text-warn">ALARM VIBRATING</Badge>}
          {s.poweredOnAt && <span className="font-mono">{`on since ${new Date(s.poweredOnAt).toLocaleTimeString()}`}</span>}
        </div>
      )}
    </Card>
  )
}

const THERMAL_RANGE_OPTIONS = [
  { value: 'live', label: 'Live' },
  { value: '1h', label: '1 h' },
  { value: '12h', label: '12 h' },
  { value: '24h', label: '24 h' },
  { value: '7d', label: '7 d' },
] as const
type ThermalRangeOption = (typeof THERMAL_RANGE_OPTIONS)[number]['value']

const RANGE_TITLE: Record<Exclude<ThermalRangeOption, 'live'>, string> = {
  '1h': 'Last hour',
  '12h': 'Last 12 hours',
  '24h': 'Last 24 hours',
  '7d': 'Last 7 days',
}

/** Amber warning when the pump-stall guard is off, linking to its setting. */
function PumpStallWarning() {
  const lang = langFromPath(usePathname())
  return (
    <Link
      href={`/${lang}/settings?section=device`}
      className="flex items-center gap-2 text-sm text-fg no-underline hover:underline"
    >
      <span className="size-1.5 rounded-full bg-warn" />
      Pump-stall protection off
    </Link>
  )
}

function ThermalPanel({ thermal, history }: { thermal: ThermalQuery, history: ThermalHistory }) {
  const data = thermal.data
  const { leftName, rightName } = useSideNames()
  const { unit } = useTemperatureUnit()
  const [range, setRange] = useState<ThermalRangeOption>('12h')
  const stored = trpc.health.thermalHistory.useQuery(
    { range: range === 'live' ? '1h' : range },
    { enabled: range !== 'live', refetchInterval: 60_000, placeholderData: prev => prev },
  )

  const toUnit = (f: number) => (unit === 'C' ? Math.round(((f - 32) * 5 / 9) * 10) / 10 : f)
  const formatValue = (panel: PanelDef, v: number | null) => {
    if (v == null) return '—'
    return panel.kind === 'rpm' ? Math.round(v).toLocaleString() : `${toUnit(v).toFixed(1)}°`
  }

  let chart: ThermalChartData | null = null
  if (range === 'live') {
    const points = liveToPoints(history)
    if (points.length > 1) {
      const powerOn = (data?.sides ?? [])
        .filter(s => s.isPowered && s.poweredOnAt)
        .map(s => ({ side: s.side as 'left' | 'right', at: new Date(s.poweredOnAt as string).getTime() }))
      const from = points[0].t
      const to = points[points.length - 1].t
      chart = {
        title: `Live · last ${Math.max(1, Math.round((to - from) / 60_000))} min`,
        points,
        from,
        to,
        gapMs: 20_000,
        powerOn,
        available: availabilityOf(points),
        emptyNote: {},
      }
    }
  }
  else if (stored.data && stored.data.range === range) {
    const h = stored.data
    chart = {
      title: RANGE_TITLE[range],
      points: h.points,
      from: h.from,
      to: h.to,
      gapMs: h.bucketSec * 1000 * 3,
      powerOn: h.powerOn,
      available: h.available,
      emptyNote: {
        bedTarget: h.bedTargetSince == null
          ? 'bed and target history starts recording with this update'
          : `bed and target recorded since ${new Date(h.bedTargetSince).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`,
      },
    }
  }

  const multiDay = chart ? chart.to - chart.from > 36 * 3_600_000 : false
  const tickFormat = (ms: number) => multiDay
    ? new Date(ms).toLocaleString([], { weekday: 'short', hour: 'numeric' })
    : new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

  return (
    <>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2.5">
        {data && !data.pumpStallProtectionEnabled && <PumpStallWarning />}
        {data && (
          <span className="font-mono text-xs text-fg-2">
            {`heatsink ${fmtF(data.heatsinkTempF)} · hub ambient ${fmtF(data.ambientTempF)}`}
          </span>
        )}
        <SegmentedControl
          ariaLabel="Thermal history range"
          size="sm"
          className="ml-auto"
          value={range}
          options={THERMAL_RANGE_OPTIONS}
          onChange={setRange}
        />
      </div>

      {thermal.error && <Card><InlineError>{thermal.error.message}</InlineError></Card>}
      {stored.error && range !== 'live' && <Card><InlineError>{stored.error.message}</InlineError></Card>}

      {chart
        ? (
            <ThermalHistoryChart
              {...chart}
              names={{ left: leftName, right: rightName }}
              formatValue={formatValue}
              formatTemp={toUnit}
              tickFormat={tickFormat}
            />
          )
        : range === 'live'
          ? <Card><p className="text-xs text-fg-3">Collecting samples… (updates every 5s)</p></Card>
          : <Skeleton className="h-[560px]" />}

      {data && (
        <div className="grid items-start gap-3.5 @min-[760px]:grid-cols-2">
          {data.sides.map(s => (
            <ThermalSideCard key={s.side} side={s} />
          ))}
        </div>
      )}
    </>
  )
}

// ── Scheduler ────────────────────────────────────────────────────────────────

/** 7-day lane view: one row per day, jobs as time-ordered chips. Detail lives in the table below. */
function SchedulerWeek({ jobs }: { jobs: SchedJob[] }) {
  const lanes = useMemo(() => buildWeekLanes(jobs), [jobs])
  return (
    <Card className="gap-0 py-1.5">
      {lanes.map((lane) => {
        const { weekday, day } = fmtDayLabel(lane.date)
        return (
          <div key={lane.date} className="flex items-stretch gap-3 border-t border-line py-2 first:border-t-0">
            <div className="w-16 shrink-0 pt-0.5">
              <p className={cn('text-[13px]', lane.isToday ? 'font-medium text-fg' : 'text-fg-2')}>{lane.isToday ? 'Today' : weekday}</p>
              <p className="font-mono text-[11px] text-fg-3">{day}</p>
            </div>
            <div className="flex min-h-6 flex-1 flex-wrap items-center gap-1.5">
              {lane.jobs.length === 0
                ? <span className="text-xs text-fg-3">—</span>
                : lane.jobs.map((j) => {
                    const value = fmtJobValue(j)
                    return (
                      <span
                        key={j.id}
                        className={cn('rounded-tag border px-1.5 py-0.5 font-mono text-[11px]', jobTone(j.type))}
                        title={`${j.type}${j.side ? ` · ${j.side}` : ''}${value === '—' ? '' : ` · ${value}`}`}
                      >
                        {`${fmtClock(j.nextRun)} ${j.type}${j.side ? ` · ${j.side[0].toUpperCase()}` : ''}${value === '—' ? '' : ` ${value}`}`}
                      </span>
                    )
                  })}
            </div>
          </div>
        )
      })}
    </Card>
  )
}

function SchedulerPanel() {
  const scheduler = trpc.health.scheduler.useQuery({}, { refetchInterval: 15000 })
  const system = trpc.health.system.useQuery({}, { refetchInterval: 15000 })
  const counts = scheduler.data?.jobCounts
  const drift = system.data?.scheduler?.drift
  const jobs = (scheduler.data?.upcomingJobs ?? []) as SchedJob[]

  const countEntries: Array<[string, number | undefined]> = [
    ['Total', counts?.total],
    ['Temp', counts?.temperature],
    ['On', counts?.powerOn],
    ['Off', counts?.powerOff],
    ['Alarm', counts?.alarm],
    ['Prime', counts?.prime],
    ['Reboot', counts?.reboot],
  ]

  const columns: Array<DiagColumn<SchedJob>> = [
    { key: 'type', header: 'Type', render: r => r.type, sortValue: r => r.type },
    { key: 'side', header: 'Side', render: r => <span className="capitalize text-fg-2">{r.side ?? '—'}</span>, sortValue: r => r.side ?? '' },
    { key: 'value', header: 'Value', align: 'right', render: r => fmtJobValue(r), sortValue: r => r.targetTempF ?? r.brightness ?? -1 },
    { key: 'nextRun', header: 'Next run', render: r => <span className="font-mono text-xs">{r.nextRun ? new Date(r.nextRun).toLocaleString() : '—'}</span>, sortValue: r => r.nextRun ?? '' },
    { key: 'in', header: 'In', align: 'right', render: r => <span className="text-fg-2">{fmtRel(r.nextRun)}</span>, sortValue: r => (r.nextRun ? new Date(r.nextRun).getTime() : Number.MAX_SAFE_INTEGER) },
    { key: 'id', header: 'Job ID', render: r => <span className="font-mono text-[11px] text-fg-3">{r.id}</span>, sortValue: r => r.id },
  ]

  return (
    <>
      <SectionTitle title="Scheduler" hint={scheduler.data ? (scheduler.data.enabled ? 'enabled' : 'disabled') : ''} />

      <div className="grid grid-cols-4 gap-2.5 @min-[900px]:grid-cols-7">
        {countEntries.map(([label, value]) => (
          <Metric key={label} label={label} value={value == null ? '—' : String(value)} />
        ))}
      </div>

      {drift && (
        <Card tone={drift.drifted ? 'warn' : undefined} className="flex-row items-center gap-2.5 py-3">
          <StatusDot tone={drift.drifted ? 'warn' : 'ok'} />
          <span className="text-[13px]">
            {drift.drifted
              ? `Drifted: ${drift.dbScheduleCount} DB schedules vs ${drift.schedulerJobCount} active jobs`
              : `In sync · ${drift.dbScheduleCount} schedules`}
          </span>
        </Card>
      )}

      <SchedulerWeek jobs={jobs} />

      <Card>
        <CardHeader title="Upcoming jobs" right={<span className="font-mono text-xs text-fg-2">{jobs.length}</span>} />
        <DiagTable
          columns={columns}
          rows={jobs}
          getRowKey={r => r.id}
          empty={scheduler.isLoading ? 'Loading…' : 'No upcoming jobs'}
        />
      </Card>
    </>
  )
}
