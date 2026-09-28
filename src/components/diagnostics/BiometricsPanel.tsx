'use client'

import dynamic from 'next/dynamic'
import { HeartPulse } from 'lucide-react'
import { trpc } from '@/src/utils/trpc'
import { useSide } from '@/src/hooks/useSide'
import { useSideNames } from '@/src/hooks/useSideNames'
import { useWeekNavigator } from '@/src/hooks/useWeekNavigator'
import { Card, CardHeader, KeyValue, Metric, Skeleton, StatusDot, type Tone } from '@/src/components/ds'
import { biometricsFlowStatus, fmtNum } from './diagnosticsLogic'
import { DiagTable, type DiagColumn } from './DiagTable'
import { SectionTitle, sideTitle } from './parts'

const BiometricsTrendChart = dynamic(() => import('./BiometricsTrendChart').then(m => m.BiometricsTrendChart), {
  loading: () => <Skeleton className="h-[180px]" />,
})

interface VitalRow { side: string, timestamp: Date, heartRate: number | null, hrv: number | null, breathingRate: number | null }

const FLOW_TONE: Record<'ok' | 'warn' | 'error' | 'idle', Tone> = { ok: 'ok', warn: 'warn', error: 'danger', idle: 'muted' }

const VITALS_DEFAULT_SORT = { key: 'timestamp', dir: 'desc' } as const

/**
 * Sleep → Biometrics: ingest health (is data being written), weekly vitals
 * summary, trend, per-side presence, and the searchable recent-vitals table.
 */
export function BiometricsPanel() {
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
