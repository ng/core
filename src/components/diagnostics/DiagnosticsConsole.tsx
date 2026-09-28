'use client'

import { useMemo, useState } from 'react'
import dynamic from 'next/dynamic'
import { ArrowRight, Cog, Cpu, Radio, Server, SlidersHorizontal } from 'lucide-react'
import type { inferRouterOutputs } from '@trpc/server'
import type { AppRouter } from '@/src/server/routers/app'
import { trpc } from '@/src/utils/trpc'
import { useSide } from '@/src/hooks/useSide'
import { useSideNames } from '@/src/hooks/useSideNames'
import { useTrendBuffer } from '@/src/hooks/useTrendBuffer'
import {
  Badge, Button, Card, CardHeader, InlineError, KeyValue, Metric, Skeleton, StatusDot, type Tone,
} from '@/src/components/ds'
import { cn } from '@/lib/utils'
import {
  fmtF, fmtAge, fmtMs, fmtRel, fmtClock, fmtDayLabel,
  buildWeekLanes, jobTone, fmtJobValue, thermalDirection, thermalTrendPoints,
  type SchedJob, type ThermalSideSnapshot,
} from '@/src/components/diagnostics/diagnosticsLogic'
import { DiagTable, type DiagColumn } from './DiagTable'
import { capitalize, SectionTitle, sideTitle } from './parts'
import { HealthStatusCard } from '@/src/components/status/HealthStatusCard'
import { PodStatusSummary } from '@/src/components/status/StatusScreen'

// Chart and sensor dependencies load only when their section is opened.
const ThermalTrendChart = dynamic(() => import('./ThermalTrendChart').then(m => m.ThermalTrendChart), {
  loading: () => <div className="h-[70px]" />,
})

// Formatting, scheduler-lane, and biometrics/thermal derivations live in
// ./diagnosticsLogic so they can be unit-tested without React/tRPC.

type ServiceStatus = 'ok' | 'degraded' | 'error' | 'unknown'

// ── Sections ─────────────────────────────────────────────────────────────────

/** The System pages this console renders; System owns navigation. */
export type DiagSection = 'dashboard' | 'calibration' | 'health' | 'scheduler' | 'thermal'

/** 30 minutes of thermal samples at the 5s poll. */
const THERMAL_HISTORY_POINTS = 360

type ThermalData = inferRouterOutputs<AppRouter>['health']['thermal']
type ThermalSide = ThermalData['sides'][number]
type ThermalHistory = Array<{ t: number, sides: ThermalSideSnapshot[] }>

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
      {section === 'dashboard' && <OverviewPanel thermal={thermal} history={history} onJump={onJump} />}
      {section === 'thermal' && <ThermalPanel thermal={thermal} history={history} />}
      {section === 'scheduler' && <SchedulerPanel />}
      {section === 'health' && <HealthPanel />}
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

function OverviewPanel({ thermal, history, onJump }: { thermal: ThermalQuery, history: ThermalHistory, onJump: (s: DiagSection) => void }) {
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
      <PodStatusSummary />
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
      <div className="grid items-start gap-3.5 @min-[900px]:grid-cols-2">
        <HealthStatusCard title="Core" description="Server, database, scheduler" icon={Server} iconColor="text-icon" iconBg="bg-active" services={coreServices} isLoading={system.isLoading} defaultExpanded />
        <HealthStatusCard title="Hardware" description="DAC socket and monitoring" icon={Cpu} iconColor="text-icon" iconBg="bg-active" services={hardwareServices} isLoading={hardware.isLoading || dacMonitor.isLoading} defaultExpanded />
        <HealthStatusCard title="Network" description="WiFi and internet" icon={Radio} iconColor="text-icon" iconBg="bg-active" services={networkServices} isLoading={wifi.isLoading} defaultExpanded />
        <HealthStatusCard title="Services" description="Systemd service units" icon={Cog} iconColor="text-icon" iconBg="bg-active" services={systemdServices} isLoading={logSources.isLoading} defaultExpanded />
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

// ── Small shared bits ────────────────────────────────────────────────────────

