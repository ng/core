'use client'

import { useCallback, useState, useSyncExternalStore } from 'react'
import { trpc } from '@/src/utils/trpc'
import { PullToRefresh } from '@/src/components/PullToRefresh/PullToRefresh'
import { Card, SectionLabel, StatusDot, type Tone } from '@/src/components/ds'
import { cn } from '@/lib/utils'
import { HealthCircle, podModelName } from './HealthCircle'
import { UpdateCard } from './UpdateCard'
import { WaterModal } from './WaterModal'
import { WaterLevelCard } from './WaterLevelCard'
import { CalibrationModal } from './CalibrationModal'
import { InternetAccessToggle } from './InternetToggleCard'
import { PumpAlertsCard } from './PumpAlertsCard'

const POLL_INTERVAL = 10_000
const noopSubscribe = () => () => {}

type ServiceStatus = 'ok' | 'degraded' | 'error' | 'unknown'

interface ServiceRow {
  name: string
  value: string
  status: ServiceStatus
  detail?: string
}

const STATUS_TONE: Record<ServiceStatus, Tone> = {
  ok: 'ok',
  degraded: 'warn',
  error: 'danger',
  unknown: 'muted',
}

function formatMs(ms: number): string {
  if (ms < 1) return '<1ms'
  return `${Math.round(ms)}ms`
}

export function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86_400)
  const h = Math.floor((seconds % 86_400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

function dacMonitorStatus(status?: string): ServiceStatus {
  if (!status) return 'unknown'
  if (status === 'not_initialized') return 'degraded'
  if (status === 'polling' || status === 'connected' || status === 'running') return 'ok'
  if (status === 'error' || status === 'disconnected') return 'error'
  return 'ok'
}

/**
 * All health queries behind Settings → Status, plus the derived service rows
 * and the N/N healthy count. Shared with the phone Settings index summary
 * (React Query dedupes the requests).
 */
export function useStatusSummary() {
  const system = trpc.health.system.useQuery({}, { refetchInterval: POLL_INTERVAL })
  const hardware = trpc.health.hardware.useQuery({}, { refetchInterval: POLL_INTERVAL })
  const scheduler = trpc.health.scheduler.useQuery({}, { refetchInterval: POLL_INTERVAL })
  const dacMonitor = trpc.health.dacMonitor.useQuery({}, { refetchInterval: POLL_INTERVAL })
  const performance = trpc.health.performance.useQuery({}, { refetchInterval: 60_000 })

  const version = trpc.system.getVersion.useQuery({}, { refetchInterval: 60_000 })
  const internet = trpc.system.internetStatus.useQuery({}, { refetchInterval: POLL_INTERVAL })
  const wifi = trpc.system.wifiStatus.useQuery({}, { refetchInterval: POLL_INTERVAL })
  const logSources = trpc.system.getLogSources.useQuery({}, { refetchInterval: 30_000 })
  const storage = trpc.system.getStorageBreakdown.useQuery({}, { refetchInterval: 30_000 })
  const waterLatest = trpc.waterLevel.getLatest.useQuery({}, { refetchInterval: 30_000 })
  const deviceStatus = trpc.device.getStatus.useQuery({}, { refetchInterval: POLL_INTERVAL })
  const calibrationStatus = trpc.calibration.getStatus.useQuery(
    { side: 'left' },
    { refetchInterval: POLL_INTERVAL },
  )

  const drift = system.data?.scheduler?.drift
  const coreServices: ServiceRow[] = [
    {
      name: 'Database',
      value: system.data?.database?.status === 'ok'
        ? formatMs(system.data.database.latencyMs)
        : system.data?.database?.error ?? '—',
      status: system.data?.database?.status ?? 'unknown',
      detail: system.data?.database?.error,
    },
    {
      name: 'System',
      value: system.data ? (system.data.status === 'ok' ? 'all checks passing' : 'degraded') : '—',
      status: system.data?.status ?? 'unknown',
    },
    {
      name: 'Scheduler',
      value: scheduler.data
        ? scheduler.data.enabled
          ? `${scheduler.data.jobCounts?.total ?? 0} jobs${drift ? (drift.drifted ? ' · drifted' : ' · in sync') : ''}`
          : 'disabled'
        : '—',
      status: scheduler.data ? (scheduler.data.healthy ? 'ok' : scheduler.data.enabled ? 'degraded' : 'ok') : 'unknown',
    },
  ]

  const hardwareServices: ServiceRow[] = [
    {
      name: 'DAC socket',
      value: hardware.data?.status === 'ok'
        ? formatMs(hardware.data.latencyMs)
        : hardware.data?.error ?? 'checking…',
      status: hardware.data?.status ?? 'unknown',
      detail: hardware.data?.socketPath,
    },
    {
      name: 'DAC monitor',
      value: dacMonitor.data?.status === 'not_initialized'
        ? 'not initialized'
        : dacMonitor.data?.status ?? 'checking…',
      status: dacMonitorStatus(dacMonitor.data?.status),
    },
  ]

  const calStatus = calibrationStatus.data
  const calibrationServices: ServiceRow[] = (['piezo', 'capacitance', 'temperature'] as const).map((type) => {
    const p = calStatus?.[type]
    return {
      name: type.charAt(0).toUpperCase() + type.slice(1),
      value: p
        ? p.status === 'completed'
          ? p.qualityScore != null ? `${Math.round(p.qualityScore * 100)}%` : '--'
          : p.status
        : 'no data',
      status: p?.status === 'completed'
        ? 'ok'
        : p?.status === 'running' || p?.status === 'pending' ? 'degraded' : 'unknown',
    }
  })

  const networkServices: ServiceRow[] = [
    {
      name: 'Wi-Fi',
      value: wifi.data?.connected
        ? `${wifi.data.ssid ?? 'connected'} · ${wifi.data.signal ?? 0}%`
        : wifi.data ? 'not connected' : '—',
      status: wifi.data ? (wifi.data.connected ? 'ok' : 'degraded') : 'unknown',
    },
    {
      name: 'Internet',
      value: internet.data?.blocked ? 'blocked (local only)' : 'available',
      status: 'ok',
    },
  ]

  const unitServices: ServiceRow[] = (logSources.data?.sources ?? []).map(source => ({
    name: source.name,
    value: source.active ? 'active' : 'inactive',
    status: source.active ? 'ok' : 'degraded',
    detail: source.unit,
  }))

  const allServices = [...coreServices, ...hardwareServices, ...calibrationServices, ...networkServices, ...unitServices]
  const healthy = allServices.filter(s => s.status === 'ok').length

  return {
    healthy,
    total: allServices.length,
    groups: { core: coreServices, hardware: hardwareServices, calibration: calibrationServices, network: networkServices, units: unitServices },
    loading: system.isLoading,
    podName: podModelName(deviceStatus.data?.podVersion ?? dacMonitor.data?.podVersion),
    version: version.data,
    wifi: wifi.data,
    internetBlocked: internet.data?.blocked,
    waterLevel: waterLatest.data?.level ?? deviceStatus.data?.waterLevel,
    diskPercent: storage.data && storage.data.emmc.totalBytes > 0 ? storage.data.emmc.usedPercent : undefined,
    uptimeSeconds: performance.data?.uptimeSeconds,
    updatedAt: system.dataUpdatedAt,
  }
}

function ServiceLine({ row }: { row: ServiceRow }) {
  return (
    <div className="flex items-center gap-2 text-[13px]" title={row.detail}>
      <StatusDot tone={STATUS_TONE[row.status]} />
      <span className="shrink-0">{row.name}</span>
      <span className="ml-auto truncate pl-2 font-mono text-xs text-fg-2">{row.value}</span>
    </div>
  )
}

function ServiceGroup({ label, rows, right, first }: { label: string, rows: ServiceRow[], right?: React.ReactNode, first?: boolean }) {
  if (rows.length === 0) return null
  return (
    <>
      <SectionLabel right={right} className={cn(!first && 'mt-1.5')}>{label}</SectionLabel>
      {rows.map(r => <ServiceLine key={r.name} row={r} />)}
    </>
  )
}

/**
 * Settings → Status: health summary, water level, software, services
 * (with the internet access toggle), pump alerts, and the water/calibration
 * dialogs.
 */
export function StatusScreen() {
  const [waterModalOpen, setWaterModalOpen] = useState(false)
  const [calibrationModalOpen, setCalibrationModalOpen] = useState(false)
  const s = useStatusSummary()
  const host = useSyncExternalStore(noopSubscribe, () => window.location.hostname, () => '')

  const utils = trpc.useUtils()

  /** Pull-to-refresh: refetch all status queries. */
  const handleRefresh = useCallback(async () => {
    await Promise.all([
      utils.health.system.invalidate(),
      utils.health.hardware.invalidate(),
      utils.health.scheduler.invalidate(),
      utils.health.dacMonitor.invalidate(),
      utils.health.performance.invalidate(),
      utils.system.getVersion.invalidate(),
      utils.system.internetStatus.invalidate(),
      utils.system.wifiStatus.invalidate(),
      utils.system.getLogSources.invalidate(),
      utils.system.getStorageBreakdown.invalidate(),
      utils.waterLevel.getLatest.invalidate(),
      utils.waterLevel.getHistory.invalidate(),
      utils.waterLevel.getAlerts.invalidate(),
      utils.calibration.getStatus.invalidate(),
      utils.pumpAlerts.list.invalidate(),
    ])
  }, [utils])

  const commit = s.version && s.version.commitHash !== 'unknown' ? s.version.commitHash.slice(0, 7) : null
  const branch = s.version && s.version.branch !== 'unknown' ? s.version.branch : null

  const items = [
    { label: 'Pod', value: s.podName ?? '—' },
    { label: 'Build', value: [branch, commit].filter(Boolean).join(' · ') || '—' },
    {
      label: 'Wi-Fi',
      value: s.wifi ? (s.wifi.connected ? `${s.wifi.ssid ?? 'connected'} · ${s.wifi.signal ?? 0}%` : 'offline') : '—',
    },
    { label: 'Address', value: host || '—' },
    {
      label: 'Water',
      value: s.waterLevel
        ? <span className={s.waterLevel === 'ok' ? 'text-ok' : 'text-warn'}>{s.waterLevel === 'ok' ? 'OK' : 'Low'}</span>
        : '—',
      onClick: () => setWaterModalOpen(true),
    },
    { label: 'Internet', value: s.internetBlocked === undefined ? '—' : s.internetBlocked ? 'Blocked (local)' : 'Allowed' },
    { label: 'Disk', value: s.diskPercent !== undefined ? `${Math.round(s.diskPercent)}% used` : '—' },
    { label: 'Uptime', value: s.uptimeSeconds !== undefined ? formatUptime(s.uptimeSeconds) : '—' },
  ]

  const recalibrate = (
    <button
      type="button"
      onClick={() => setCalibrationModalOpen(true)}
      className="cursor-pointer border-0 bg-transparent p-0 font-sans text-xs text-fg hover:underline"
    >
      Recalibrate
    </button>
  )

  return (
    <PullToRefresh onRefresh={handleRefresh}>
      <div className="flex flex-col gap-3.5">
        <HealthCircle healthy={s.healthy} total={s.total} items={items} />

        <PumpAlertsCard />

        <div className="grid items-start gap-3.5 @min-[800px]:grid-cols-2">
          <WaterLevelCard onOpen={() => setWaterModalOpen(true)} />
          <UpdateCard compact />
        </div>

        <Card className="gap-0 p-0 @min-[800px]:grid @min-[800px]:grid-cols-2">
          <div className="flex min-w-0 flex-col gap-[9px] px-[18px] py-3.5 @min-[800px]:border-r @min-[800px]:border-line">
            <ServiceGroup first label="CORE" rows={s.groups.core} />
            <ServiceGroup label="HARDWARE" rows={s.groups.hardware} />
            <ServiceGroup label="SERVICES" rows={s.groups.units} />
          </div>
          <div className="flex min-w-0 flex-col gap-[9px] border-t border-line px-[18px] py-3.5 @min-[800px]:border-t-0">
            <ServiceGroup first label="CALIBRATION" rows={s.groups.calibration} right={recalibrate} />
            <ServiceGroup label="NETWORK" rows={s.groups.network.filter(r => r.name !== 'Internet')} />
            <InternetAccessToggle dot />
          </div>
        </Card>

        {s.updatedAt > 0 && (
          <p className="text-center font-mono text-xs text-fg-3">
            {`Updated ${new Date(s.updatedAt).toLocaleTimeString()}`}
          </p>
        )}
      </div>

      <WaterModal open={waterModalOpen} onClose={() => setWaterModalOpen(false)} />
      <CalibrationModal open={calibrationModalOpen} onClose={() => setCalibrationModalOpen(false)} />
    </PullToRefresh>
  )
}
