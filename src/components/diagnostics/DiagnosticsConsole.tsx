'use client'

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import Link from 'next/link'
import dynamic from 'next/dynamic'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { ArrowRight, Cog, Cpu, HeartPulse, Radio, Server, SlidersHorizontal } from 'lucide-react'
import type { inferRouterOutputs } from '@trpc/server'
import type { AppRouter } from '@/src/server/routers/app'
import { trpc } from '@/src/utils/trpc'
import { useSide } from '@/src/hooks/useSide'
import { useSideNames } from '@/src/hooks/useSideNames'
import { useWeekNavigator } from '@/src/hooks/useWeekNavigator'
import { useTrendBuffer } from '@/src/hooks/useTrendBuffer'
import {
  Badge, Button, Card, CardHeader, InlineError, KeyValue, Metric, Pill, SectionLabel, Skeleton, StatusDot, type Tone,
} from '@/src/components/ds'
import { cn } from '@/lib/utils'
import {
  fmtF, fmtAge, fmtMs, fmtNum, fmtRel, fmtClock, fmtDayLabel,
  buildWeekLanes, jobTone, fmtJobValue, biometricsFlowStatus, thermalDirection, thermalTrendPoints,
  type SchedJob, type ThermalSideSnapshot,
} from '@/src/components/diagnostics/diagnosticsLogic'
import { DiagTable, type DiagColumn } from './DiagTable'
import { HealthStatusCard } from '@/src/components/status/HealthStatusCard'
import { SystemInfoCard } from '@/src/components/status/SystemInfoCard'
import { InternetToggleCard } from '@/src/components/status/InternetToggleCard'
import { UpdateCard } from '@/src/components/status/UpdateCard'
import { SystemLogViewer } from '@/src/components/status/SystemLogViewer'

// Chart and sensor dependencies load only when their section is opened.
const ThermalTrendChart = dynamic(() => import('./ThermalTrendChart').then(m => m.ThermalTrendChart), {
  loading: () => <div className="h-[70px]" />,
})
const BiometricsTrendChart = dynamic(() => import('./BiometricsTrendChart').then(m => m.BiometricsTrendChart), {
  loading: () => <Skeleton className="h-[180px]" />,
})

// Formatting, scheduler-lane, and biometrics/thermal derivations live in
// ./diagnosticsLogic so they can be unit-tested without React/tRPC.

type ServiceStatus = 'ok' | 'degraded' | 'error' | 'unknown'

// ── Sections ─────────────────────────────────────────────────────────────────

export const DIAG_SECTIONS = [
  { id: 'overview', label: 'Overview' },
  { id: 'autopilot', label: 'Autopilot' },
  { id: 'biometrics', label: 'Biometrics' },
  { id: 'calibration', label: 'Calibration' },
  { id: 'health', label: 'Health' },
  { id: 'logs', label: 'Logs' },
  { id: 'scheduler', label: 'Scheduler' },
  { id: 'thermal', label: 'Thermal' },
] as const

type SectionId = (typeof DIAG_SECTIONS)[number]['id']

function isSection(v: string | null): v is SectionId {
  return DIAG_SECTIONS.some(s => s.id === v)
}

/** 30 minutes of thermal samples at the 5s poll. */
const THERMAL_HISTORY_POINTS = 360

type ThermalData = inferRouterOutputs<AppRouter>['health']['thermal']
type ThermalSide = ThermalData['sides'][number]
type ThermalHistory = Array<{ t: number, sides: ThermalSideSnapshot[] }>

/**
 * System → Diagnostics: the pod's diagnostic surfaces (thermal delivery,
 * scheduler, service health, biometrics, calibration, autopilot, logs)
 * behind an underline tab row on desktop and section chips on phones — the
 * sidebar holds two levels (System / Diagnostics), the page holds the third.
 * The active section lives in `?section=`.
 */
export function DiagnosticsConsole() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()
  const raw = searchParams.get('section')
  const section: SectionId = isSection(raw) ? raw : 'overview'

  // Sensors is its own System tab; old `?section=sensors` links land there.
  useEffect(() => {
    if (raw === 'sensors') router.replace(pathname, { scroll: false })
  }, [raw, pathname, router])

  const setSection = useCallback((next: SectionId) => {
    const params = new URLSearchParams(searchParams.toString())
    params.set('tab', 'diagnostics')
    if (next === 'overview') params.delete('section')
    else params.set('section', next)
    router.replace(`${pathname}?${params.toString()}`, { scroll: false })
  }, [pathname, router, searchParams])

  // Thermal history is buffered here so the 30-min trend survives switching
  // between Overview and Thermal.
  const thermal = trpc.health.thermal.useQuery({}, { refetchInterval: 5000 })
  const history = useTrendBuffer(thermal.data, thermal.dataUpdatedAt, THERMAL_HISTORY_POINTS) as ThermalHistory

  return (
    <div className="flex flex-col gap-3.5 min-[900px]:gap-6">
      <div className="-mt-1 hidden gap-7 border-b border-line min-[900px]:flex" role="tablist" aria-label="Diagnostics tabs">
        {DIAG_SECTIONS.map((s) => {
          const on = s.id === section
          return (
            <button
              key={s.id}
              type="button"
              role="tab"
              aria-selected={on}
              onClick={() => setSection(s.id)}
              className={cn(
                '-mb-px cursor-pointer whitespace-nowrap border-0 border-b-2 bg-transparent px-0 pb-2.5 text-[15px] transition-colors',
                on ? 'border-fg text-fg' : 'border-transparent text-fg-2 hover:text-fg',
              )}
            >
              {s.label}
            </button>
          )
        })}
      </div>
      <div className="no-scrollbar -mx-5 flex gap-1.5 overflow-x-auto px-5 min-[900px]:hidden" role="tablist" aria-label="Diagnostics sections">
        {DIAG_SECTIONS.map(s => (
          <Pill key={s.id} role="tab" aria-selected={s.id === section} selected={s.id === section} onClick={() => setSection(s.id)}>
            {s.label}
          </Pill>
        ))}
      </div>

      <div className="flex min-w-0 flex-col gap-3.5">
        {section === 'overview' && <OverviewPanel thermal={thermal} history={history} onJump={setSection} />}
        {section === 'thermal' && <ThermalPanel thermal={thermal} history={history} />}
        {section === 'scheduler' && <SchedulerPanel />}
        {section === 'biometrics' && <BiometricsPanel />}
        {section === 'health' && <HealthPanel />}
        {section === 'calibration' && <CalibrationPanel />}
        {section === 'autopilot' && <AutopilotPanel />}
        {section === 'logs' && <SystemLogViewer />}
      </div>
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

function OverviewPanel({ thermal, history, onJump }: { thermal: ThermalQuery, history: ThermalHistory, onJump: (s: SectionId) => void }) {
  const system = trpc.health.system.useQuery({}, { refetchInterval: 10000 })
  const hardware = trpc.health.hardware.useQuery({}, { refetchInterval: 10000 })
  const scheduler = trpc.health.scheduler.useQuery({}, { refetchInterval: 15000 })

  const t = thermal.data
  const drift = system.data?.scheduler?.drift
  const jobsHint = scheduler.data
    ? `${scheduler.data.jobCounts?.total ?? 0}${drift ? (drift.drifted ? ' · drifted' : ' · in sync') : ''}`
    : undefined

  return (
    <>
      <div className="grid grid-cols-2 gap-2.5 @min-[640px]:grid-cols-3 @min-[960px]:grid-cols-6">
        <Metric label="DB" value={system.data?.database?.status === 'ok' ? fmtMs(system.data.database.latencyMs) : (system.data?.database?.status ?? '—')} ok={system.data ? system.data.database?.status === 'ok' : undefined} />
        <Metric label="DAC socket" value={hardware.data?.status === 'ok' ? fmtMs(hardware.data.latencyMs) : (hardware.data?.status ?? '—')} ok={hardware.data ? hardware.data.status === 'ok' : undefined} />
        <Metric label="Scheduler" value={scheduler.data ? (scheduler.data.enabled ? `${scheduler.data.jobCounts?.total ?? 0} jobs` : 'off') : '—'} ok={scheduler.data ? (scheduler.data.healthy ?? true) : undefined} />
        {/* armed = green; opt-in off = amber */}
        <Metric label="Pump-stall" value={t ? (t.pumpStallProtectionEnabled ? 'armed' : 'opt-in off') : '—'} ok={t ? t.pumpStallProtectionEnabled : undefined} />
        <Metric label="Heatsink" value={fmtF(t?.heatsinkTempF)} />
        <Metric label="Hub ambient" value={fmtF(t?.ambientTempF)} />
      </div>

      <SectionTitle title="Thermal delivery" hint={thermal.isFetching ? 'refreshing…' : 'live · 5s'} />

      <div className="grid items-start gap-3.5 @min-[640px]:grid-cols-2 @min-[960px]:grid-cols-3">
        {thermal.isLoading && (
          <>
            <Skeleton className="h-[230px]" />
            <Skeleton className="h-[230px]" />
          </>
        )}
        {thermal.error && <Card><InlineError>{thermal.error.message}</InlineError></Card>}
        {t?.sides.map(s => (
          <ThermalSideCard key={s.side} side={s} history={history} onClick={() => onJump('thermal')} />
        ))}

        <Card className="@min-[640px]:col-span-2 @min-[960px]:col-span-1">
          <CardHeader
            title="Next scheduled jobs"
            right={jobsHint && <span className="font-mono text-xs text-fg-2">{jobsHint}</span>}
          />
          <JobList jobs={scheduler.data?.upcomingJobs as SchedJob[] | undefined} limit={6} />
          <button
            type="button"
            onClick={() => onJump('scheduler')}
            className="flex cursor-pointer items-center gap-1 self-start border-0 bg-transparent p-0 text-[13px] text-fg-2 hover:text-fg"
          >
            All jobs
            <ArrowRight size={14} />
          </button>
        </Card>
      </div>
    </>
  )
}

function JobList({ jobs, limit }: { jobs?: SchedJob[], limit: number }) {
  const { sideName } = useSideNames()
  if (!jobs) return <Skeleton className="h-24 border-0" />
  if (jobs.length === 0) return <p className="border-t border-line pt-2.5 text-[13px] text-fg-3">No upcoming jobs</p>
  return (
    <>
      {jobs.slice(0, limit).map((j) => {
        const value = fmtJobValue(j)
        const who = j.side === 'left' || j.side === 'right' ? sideName(j.side) : (j.side ? capitalize(j.side) : 'Pod')
        return (
          <div key={j.id} className="grid grid-cols-[72px_minmax(0,1fr)] gap-x-2.5 gap-y-1 border-t border-line pt-2.5">
            <span className="font-mono text-[13px]">{fmtClock(j.nextRun)}</span>
            <span className="flex min-w-0 items-baseline gap-2 text-sm">
              <span className="truncate">{humanJobType(j.type)}</span>
              <span className="ml-auto shrink-0 font-mono text-[11px] text-fg-3">{fmtRel(j.nextRun)}</span>
            </span>
            <span />
            <span className="text-xs text-fg-2">{value === '—' ? who : `${who} · ${value}`}</span>
          </div>
        )
      })}
    </>
  )
}

function humanJobType(type: string): string {
  const spaced = type.replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()
  return capitalize(spaced)
}

/** "Jon · left", or just "Left side" when the side has no custom name. */
function sideTitle(name: string, side: 'left' | 'right'): string {
  return name.toLowerCase() === side ? `${capitalize(side)} side` : `${name} · ${side}`
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

// ── Thermal ──────────────────────────────────────────────────────────────────

function ThermalSideCard({ side: s, history, onClick, detailed }: {
  side: ThermalSide
  history: ThermalHistory
  onClick?: () => void
  detailed?: boolean
}) {
  const { sideName } = useSideNames()
  const side = s.side as 'left' | 'right'
  const dir = thermalDirection(s)
  const stalled = s.verdict === 'stalled'

  return (
    <Card
      tone={stalled ? 'danger' : undefined}
      onClick={onClick}
      className={cn(onClick && 'hover:bg-active')}
      data-testid={`thermal-${side}`}
    >
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
      {detailed && (s.guardBlocked || s.isAlarmVibrating || s.poweredOnAt) && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-fg-2">
          {s.guardBlocked && <Badge className="border-danger-line text-danger">GUARD BLOCKED</Badge>}
          {s.isAlarmVibrating && <Badge className="border-warn-line text-warn">ALARM VIBRATING</Badge>}
          {s.poweredOnAt && <span className="font-mono">{`on since ${new Date(s.poweredOnAt).toLocaleTimeString()}`}</span>}
        </div>
      )}
      <ThermalTrendChart side={side} points={thermalTrendPoints(history, s.side)} height={detailed ? 120 : 70} />
      <div className="flex justify-between font-mono text-[10px] text-fg-3">
        <span>{history.length > 1 ? `−${Math.max(1, Math.round((history[history.length - 1].t - history[0].t) / 60000))} min` : '−30 min'}</span>
        <span className="flex items-center gap-3">
          <span className="flex items-center gap-1.5">
            <span className="block w-2.5 border-t-2 border-dashed" style={{ borderColor: side === 'left' ? 'var(--accent-cool)' : 'var(--accent-warm)' }} />
            target
          </span>
          <span className="flex items-center gap-1.5">
            <span className="block h-0.5 w-2.5 bg-fg" />
            bed
          </span>
        </span>
        <span>now</span>
      </div>
    </Card>
  )
}

function ThermalPanel({ thermal, history }: { thermal: ThermalQuery, history: ThermalHistory }) {
  const data = thermal.data

  return (
    <>
      <SectionTitle title="Thermal delivery" hint={thermal.isFetching ? 'refreshing…' : 'live · 5s'} />
      {thermal.isLoading && <Skeleton className="h-[300px]" />}
      {thermal.error && <Card><InlineError>{thermal.error.message}</InlineError></Card>}

      {data && (
        <>
          <div className="grid grid-cols-2 gap-2.5 @min-[640px]:grid-cols-3">
            <Metric label="Pump-stall protection" value={data.pumpStallProtectionEnabled ? 'enabled' : 'disabled'} ok={data.pumpStallProtectionEnabled} />
            <Metric label="Heatsink" value={fmtF(data.heatsinkTempF)} />
            <Metric label="Hub ambient" value={fmtF(data.ambientTempF)} />
          </div>

          <div className="grid items-start gap-3.5 @min-[760px]:grid-cols-2">
            {data.sides.map(s => (
              <ThermalSideCard key={s.side} side={s} history={history} detailed />
            ))}
          </div>
        </>
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

// ── Biometrics ───────────────────────────────────────────────────────────────

interface VitalRow { side: string, timestamp: Date, heartRate: number | null, hrv: number | null, breathingRate: number | null }

const FLOW_TONE: Record<'ok' | 'warn' | 'error' | 'idle', Tone> = { ok: 'ok', warn: 'warn', error: 'danger', idle: 'muted' }

const VITALS_DEFAULT_SORT = { key: 'timestamp', dir: 'desc' } as const

function BiometricsPanel() {
  const { side } = useSide()
  const { sideName } = useSideNames()
  const { weekStart, weekEnd } = useWeekNavigator()

  const summary = trpc.biometrics.getVitalsSummary.useQuery({ side, startDate: weekStart, endDate: weekEnd }, { refetchInterval: 30000 })
  const occupancy = trpc.biometrics.getOccupancy.useQuery(undefined, { refetchInterval: 10000 })
  const fileCount = trpc.biometrics.getFileCount.useQuery({}, { refetchInterval: 30000 })
  const vitals = trpc.biometrics.getVitals.useQuery({ side, startDate: weekStart, endDate: weekEnd, limit: 200 }, { refetchInterval: 30000 })

  const rows = (vitals.data ?? []) as VitalRow[]
  const s = summary.data

  const columns: Array<DiagColumn<VitalRow>> = [
    { key: 'timestamp', header: 'Time', render: r => <span className="font-mono text-xs text-fg-2">{new Date(r.timestamp).toLocaleString()}</span>, sortValue: r => new Date(r.timestamp).getTime() },
    { key: 'heartRate', header: 'HR', align: 'right', render: r => fmtNum(r.heartRate), sortValue: r => r.heartRate ?? -1 },
    { key: 'hrv', header: 'HRV', align: 'right', render: r => fmtNum(r.hrv), sortValue: r => r.hrv ?? -1 },
    { key: 'breathingRate', header: 'BR', align: 'right', render: r => fmtNum(r.breathingRate, 1), sortValue: r => r.breathingRate ?? -1 },
    { key: 'side', header: 'Side', render: r => <span className="capitalize text-fg-2">{r.side}</span>, sortValue: r => r.side },
  ]

  // Live "is data actually being written" check — the pitfall is a bed that
  // reads as occupied while the ingest pipeline has quietly stalled.
  const flow = biometricsFlowStatus(rows, occupancy.data, fileCount.data)

  return (
    <>
      <SectionTitle title="Biometrics" hint={`${sideName(side)} · this week`} />

      <Card
        tone={flow.tone === 'warn' ? 'warn' : flow.tone === 'error' ? 'danger' : undefined}
        highlight={flow.tone === 'ok'}
        className="flex-row items-center gap-2.5 py-3"
      >
        <HeartPulse size={15} className="shrink-0 text-icon" />
        <StatusDot tone={FLOW_TONE[flow.tone]} label={flow.label} className="whitespace-normal text-[13px]" />
      </Card>

      <div className="grid grid-cols-2 gap-2.5 @min-[640px]:grid-cols-3 @min-[960px]:grid-cols-6">
        <Metric label="Avg HR" value={s ? fmtNum(s.avgHeartRate) : '—'} />
        <Metric label="HR min/max" value={s ? `${fmtNum(s.minHeartRate)}/${fmtNum(s.maxHeartRate)}` : '—'} />
        <Metric label="Avg HRV" value={s ? fmtNum(s.avgHRV) : '—'} />
        <Metric label="Avg BR" value={s ? fmtNum(s.avgBreathingRate, 1) : '—'} />
        <Metric label="Records" value={s ? String(s.recordCount) : '—'} />
        <Metric label="RAW files" value={fileCount.data ? `${fileCount.data.rawFiles.left}+${fileCount.data.rawFiles.right} · ${fileCount.data.totalSizeMB}MB` : '—'} />
      </div>

      <Card>
        <CardHeader title={`Vitals trend · ${sideName(side)}`} />
        <BiometricsTrendChart rows={rows} />
      </Card>

      {occupancy.data && (
        <div className="grid gap-3.5 @min-[640px]:grid-cols-2">
          {(['left', 'right'] as const).map((sd) => {
            const o = occupancy.data[sd]
            return (
              <Card key={sd}>
                <CardHeader title={sideTitle(sideName(sd), sd)} right={<StatusDot tone={o.occupied ? 'ok' : 'muted'} label={o.occupied ? 'in bed' : 'empty'} />} />
                <div className="grid grid-cols-2 gap-x-3 gap-y-2.5">
                  <KeyValue label="Occupied" value={o.occupied ? 'yes' : 'no'} />
                  <KeyValue label="Available" value={o.available ? 'yes' : 'no'} />
                  <KeyValue label="Movement" value={o.movement.active ? `active (${fmtNum(o.movement.peakScore)})` : 'idle'} />
                  <KeyValue label="Level dev" value={fmtNum(o.level.deviation, 1)} />
                </div>
              </Card>
            )
          })}
        </div>
      )}

      <Card>
        <CardHeader title="Recent vitals" right={<span className="font-mono text-xs text-fg-2">{rows.length}</span>} />
        <DiagTable
          columns={columns}
          rows={rows}
          getRowKey={(r, i) => `${new Date(r.timestamp).getTime()}-${i}`}
          empty={vitals.isLoading ? 'Loading…' : 'No vitals this week'}
          searchText={r => `${new Date(r.timestamp).toLocaleString()} ${r.side} ${fmtNum(r.heartRate)} ${fmtNum(r.hrv)} ${fmtNum(r.breathingRate, 1)}`}
          pageSize={25}
          defaultSort={VITALS_DEFAULT_SORT}
        />
      </Card>
    </>
  )
}

// ── Health ───────────────────────────────────────────────────────────────────

function HealthPanel() {
  const system = trpc.health.system.useQuery({}, { refetchInterval: 10000 })
  const hardware = trpc.health.hardware.useQuery({}, { refetchInterval: 10000 })
  const dacMonitor = trpc.health.dacMonitor.useQuery({}, { refetchInterval: 10000 })
  const scheduler = trpc.health.scheduler.useQuery({}, { refetchInterval: 15000 })
  const wifi = trpc.system.wifiStatus.useQuery({}, { refetchInterval: 10000 })
  const internet = trpc.system.internetStatus.useQuery({}, { refetchInterval: 10000 })
  const logSources = trpc.system.getLogSources.useQuery({}, { refetchInterval: 30000 })

  const coreServices = [
    {
      name: 'Database',
      description: system.data?.database?.status === 'ok' ? `Latency: ${fmtMs(system.data.database.latencyMs)}` : undefined,
      status: (system.data?.database?.status ?? 'unknown') as ServiceStatus,
      detail: system.data?.database?.error,
    },
    {
      name: 'System',
      description: system.data?.status === 'ok' ? 'All checks passing' : 'Degraded',
      status: (system.data?.status ?? 'unknown') as ServiceStatus,
    },
    {
      name: 'Scheduler',
      description: scheduler.data?.enabled ? `Enabled · ${scheduler.data.jobCounts?.total ?? 0} jobs` : 'Disabled',
      status: (scheduler.data?.healthy ? 'ok' : scheduler.data?.enabled ? 'degraded' : 'ok') as ServiceStatus,
    },
  ]

  const hardwareServices = [
    {
      name: 'DAC Socket',
      description: hardware.data?.status === 'ok' ? `Connected · ${fmtMs(hardware.data.latencyMs)}` : hardware.data?.error ?? 'Checking…',
      status: (hardware.data?.status ?? 'unknown') as ServiceStatus,
      detail: hardware.data?.socketPath,
    },
    {
      name: 'DAC Monitor',
      description: dacMonitor.data?.status === 'not_initialized' ? 'Not initialized' : dacMonitor.data?.status ?? 'Checking…',
      status: (dacMonitor.data?.status === 'polling' || dacMonitor.data?.status === 'connected' || dacMonitor.data?.status === 'running'
        ? 'ok'
        : dacMonitor.data?.status === 'error' || dacMonitor.data?.status === 'disconnected'
          ? 'error'
          : dacMonitor.data?.status === 'not_initialized'
            ? 'degraded'
            : 'unknown') as ServiceStatus,
      detail: dacMonitor.data?.podVersion ? `Pod version: ${dacMonitor.data.podVersion}` : undefined,
    },
  ]

  const networkServices = [
    {
      name: 'WiFi',
      description: wifi.data?.connected ? `${wifi.data.ssid ?? 'Connected'} · ${wifi.data.signal ?? 0}%` : 'Not connected',
      status: (wifi.data?.connected ? 'ok' : 'degraded') as ServiceStatus,
    },
    {
      name: 'Internet',
      description: internet.data?.blocked ? 'Blocked (local only)' : 'Available',
      status: 'ok' as ServiceStatus,
    },
  ]

  const systemdServices = (logSources.data?.sources ?? []).map(source => ({
    name: source.name,
    description: source.unit,
    status: (source.active ? 'ok' : 'degraded') as ServiceStatus,
  }))

  return (
    <>
      <SectionTitle title="System health" />
      {/*
        Two columns with a deliberate information architecture:
          · Operational — live subsystem status, ordered by what you check
            first when debugging: brain (Core) → thermal link (Hardware) →
            connectivity (Network) → granular systemd units (Services).
          · Device — identity/capacity facts and the two control surfaces
            (internet access, updates), which are actions rather than health.
        Cards start expanded on desktop — there's room to show every check.
      */}
      <div className="grid items-start gap-3.5 @min-[900px]:grid-cols-2">
        <div className="flex flex-col gap-2.5">
          <SectionLabel>Operational</SectionLabel>
          <HealthStatusCard title="Core" description="Server, database, scheduler" icon={Server} iconColor="text-icon" iconBg="bg-active" services={coreServices} isLoading={system.isLoading} defaultExpanded />
          <HealthStatusCard title="Hardware" description="DAC socket and monitoring" icon={Cpu} iconColor="text-icon" iconBg="bg-active" services={hardwareServices} isLoading={hardware.isLoading || dacMonitor.isLoading} defaultExpanded />
          <HealthStatusCard title="Network" description="WiFi and internet" icon={Radio} iconColor="text-icon" iconBg="bg-active" services={networkServices} isLoading={wifi.isLoading} defaultExpanded />
          <HealthStatusCard title="Services" description="Systemd service units" icon={Cog} iconColor="text-icon" iconBg="bg-active" services={systemdServices} isLoading={logSources.isLoading} defaultExpanded />
        </div>

        <div className="flex flex-col gap-2.5">
          <SectionLabel>Device &amp; maintenance</SectionLabel>
          <SystemInfoCard />
          <InternetToggleCard />
          <UpdateCard />
        </div>
      </div>
    </>
  )
}

// ── Calibration (inline, no modal) ───────────────────────────────────────────

const CAL_SENSORS = ['piezo', 'capacitance', 'temperature'] as const
type CalSensor = (typeof CAL_SENSORS)[number]

const CAL_TONE: Record<string, Tone> = {
  completed: 'ok',
  running: 'warn',
  pending: 'muted',
  failed: 'danger',
  unknown: 'muted',
}

function CalibrationPanel() {
  const { side } = useSide()
  const { sideName } = useSideNames()
  const utils = trpc.useUtils()
  const [triggering, setTriggering] = useState<CalSensor | null>(null)

  const status = trpc.calibration.getStatus.useQuery({ side }, { refetchInterval: 5000 })
  const triggerSingle = trpc.calibration.triggerCalibration.useMutation({
    onSuccess: () => {
      utils.calibration.getStatus.invalidate({ side })
      setTriggering(null)
    },
    onError: () => setTriggering(null),
  })
  const triggerFull = trpc.calibration.triggerFullCalibration.useMutation({
    onSuccess: () => utils.calibration.getStatus.invalidate({ side }),
  })

  const data = status.data
  const anyActive = data && CAL_SENSORS.some(t => data[t]?.status === 'running' || data[t]?.status === 'pending')

  return (
    <>
      <SectionTitle
        title="Calibration"
        hint={sideName(side)}
        right={(
          <Button
            size="sm"
            icon={SlidersHorizontal}
            onClick={() => triggerFull.mutate({})}
            disabled={triggerFull.isPending || !!anyActive}
          >
            {triggerFull.isPending ? 'Starting…' : 'Calibrate all'}
          </Button>
        )}
      />

      {(triggerSingle.error || triggerFull.error) && (
        <Card tone="danger" className="py-3">
          <InlineError>{triggerSingle.error?.message || triggerFull.error?.message}</InlineError>
        </Card>
      )}

      <div className="grid items-start gap-3.5 @min-[760px]:grid-cols-3">
        {CAL_SENSORS.map((type) => {
          const p = data?.[type]
          const st = p?.status ?? 'unknown'
          const active = st === 'running' || st === 'pending'
          const q = p?.qualityScore
          return (
            <Card key={type}>
              <CardHeader
                title={capitalize(type)}
                right={<StatusDot tone={CAL_TONE[st] ?? 'muted'} label={st.toUpperCase()} mono />}
              />
              <div className="grid grid-cols-2 gap-x-3 gap-y-2.5">
                <KeyValue label="Quality" value={q != null ? `${Math.round(q * 100)}%` : '—'} />
                <KeyValue label="Samples" value={p?.samplesUsed != null ? String(p.samplesUsed) : '—'} />
                <KeyValue label="Calibrated" value={p?.createdAt ? new Date(p.createdAt).toLocaleDateString() : '—'} />
                <KeyValue label="Expires" value={p?.expiresAt ? new Date(p.expiresAt).toLocaleDateString() : '—'} />
              </div>
              {p?.errorMessage && <InlineError className="text-xs">{p.errorMessage}</InlineError>}
              <Button
                full
                onClick={() => {
                  setTriggering(type)
                  triggerSingle.mutate({ side, sensorType: type })
                }}
                disabled={triggering === type || active}
              >
                {triggering === type
                  ? 'Starting…'
                  : active ? (st === 'running' ? 'Running…' : 'Pending') : 'Calibrate'}
              </Button>
            </Card>
          )
        })}
      </div>

    </>
  )
}

// ── Autopilot ──────────────────────────────────────────────────────────────
// Compact mirror of the Autopilot console's diagnostics. The full builder
// lives at /autopilot; this surfaces live state and the audit trail
// alongside the pod's other diagnostics.

function autopilotAgo(d: Date | string | null): string {
  if (!d) return 'never'
  const ms = Date.now() - new Date(d).getTime()
  if (ms < 60_000) return 'now'
  const m = Math.floor(ms / 60_000)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

function AutopilotPanel() {
  const pathname = usePathname()
  const lang = pathname?.split('/')[1] ?? 'en'
  const status = trpc.automations.status.useQuery({}, { refetchInterval: 15000 })
  const runs = trpc.automations.runs.useQuery({ limit: 40 }, { refetchInterval: 15000 })
  const setKill = trpc.automations.setKillSwitch.useMutation({ onSuccess: () => status.refetch() })

  const globalEnabled = status.data?.globalEnabled ?? true
  const rules = status.data?.rules ?? []
  const runRows = runs.data ?? []

  return (
    <>
      <SectionTitle
        title="Autopilot"
        hint="WHEN / IF / THEN rules"
        right={(
          <>
            <Button
              size="sm"
              variant={globalEnabled ? 'secondary' : 'danger'}
              onClick={() => setKill.mutate({ enabled: !globalEnabled })}
              aria-label={globalEnabled ? 'Halt all automations' : 'Resume automations'}
            >
              <StatusDot tone={globalEnabled ? 'ok' : 'danger'} />
              {globalEnabled ? 'Running' : 'Halted'}
            </Button>
            <Link
              href={`/${lang}/autopilot`}
              className="inline-flex items-center gap-1.5 rounded-ctl border border-line-2 px-2.5 py-1.5 text-xs text-fg hover:bg-active"
            >
              Open builder
              <ArrowRight size={14} />
            </Link>
          </>
        )}
      />

      <div className="grid items-start gap-3.5 @min-[640px]:grid-cols-2 @min-[1100px]:grid-cols-3">
        {status.isLoading && <Skeleton className="h-28" />}
        {!status.isLoading && rules.length === 0 && (
          <Card dashed>
            <p className="text-[13px] text-fg-2">No automations yet. Build one in the Autopilot console.</p>
          </Card>
        )}
        {rules.map(r => (
          <Card key={r.id}>
            <CardHeader
              title={<span className="truncate">{r.name}</span>}
              right={(
                <StatusDot
                  mono
                  tone={!r.enabled ? 'muted' : r.dryRun ? 'warn' : 'ok'}
                  label={!r.enabled ? 'PAUSED' : r.dryRun ? 'DRY-RUN' : 'ACTIVE'}
                />
              )}
            />
            <div className="grid grid-cols-2 gap-x-3 gap-y-2.5">
              <KeyValue label="Side" value={r.side ?? 'L+R'} />
              <KeyValue label="Today" value={String(r.firesToday)} />
              <KeyValue label="Last" value={autopilotAgo(r.lastFiredAt)} />
              <KeyValue label="Cooldown" value={r.cooldownMin ? `${r.cooldownMin}m` : '—'} />
            </div>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader title="Run log" subtitle="Audit trail" right={<span className="font-mono text-xs text-fg-2">{runRows.length}</span>} />
        <div className="max-h-[360px] overflow-y-auto">
          {runRows.length === 0
            ? <p className="text-[13px] text-fg-3">No evaluations recorded yet.</p>
            : runRows.map((r) => {
                const d = new Date(r.firedAt)
                const tone = r.outcome === 'fired' || r.outcome === 'clamped' ? 'text-danger' : r.outcome === 'dry_run' ? 'text-warn' : 'text-fg-2'
                return (
                  <div key={r.id} className="grid grid-cols-[52px_minmax(0,1fr)_auto] items-baseline gap-2.5 border-t border-line py-2 text-[13px]">
                    <span className="font-mono text-xs text-fg-2">{`${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`}</span>
                    <span className="truncate">{r.ruleName ?? `#${r.automationId}`}</span>
                    <span className={cn('font-mono text-xs', tone)}>{r.outcome.replace('_', '-')}</span>
                  </div>
                )
              })}
        </div>
      </Card>
    </>
  )
}

// ── Small shared bits ────────────────────────────────────────────────────────

function SectionTitle({ title, hint, right }: { title: string, hint?: string, right?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2.5">
      <span className="text-base font-medium">{title}</span>
      {hint && <span className="font-mono text-xs text-fg-2">{hint}</span>}
      {right && <div className="ml-auto flex items-center gap-2">{right}</div>}
    </div>
  )
}

