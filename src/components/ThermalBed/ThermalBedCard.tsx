'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { langFromPath } from '@/src/components/AppShell/navItems'
import dynamic from 'next/dynamic'
import { useEffect, useState } from 'react'
import { useSensorFrame, useSensorStream } from '@/src/hooks/useSensorStream'
import { Card, SectionLabel } from '@/src/components/ds'
import { SensorAge } from '@/src/components/Sensors/SensorAge'
import { formatSensorC, formatSetpointF } from '@/src/lib/tempUtils'
import type { TempUnit } from '@/src/lib/tempUtils'
import { trpc } from '@/src/utils/trpc'
import { latestThermalReading, THERMAL_STALE_SECONDS, thermalLegend, thermalState } from './thermalData'
import type { ThermalControl, ThermalSide, Zones } from './thermalData'

const ThermalCanvas = dynamic(() => import('./ThermalCanvas'), { ssr: false })
const SIDES: ThermalSide[] = ['left', 'right']
const EMPTY: Zones = [null, null, null]
interface Props {
  unit: TempUnit
  names: Record<ThermalSide, string>
  controls: Record<ThermalSide, ThermalControl | undefined>
  blocked: Record<ThermalSide, boolean>
}

export default function ThermalBedCard({ unit, names, controls, blocked }: Props) {
  const lang = langFromPath(usePathname())
  useSensorStream({ sensors: ['bedTemp', 'bedTemp2'] })
  const older = useSensorFrame('bedTemp')
  const newer = useSensorFrame('bedTemp2')
  const [now, setNow] = useState(() => Date.now() / 1000)
  const [focus, setFocus] = useState<ThermalSide | null>(null)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now() / 1000), 5000)
    return () => clearInterval(timer)
  }, [])
  const live = latestThermalReading(older, newer)
  const liveFresh = live !== null && now - live.ts < THERMAL_STALE_SECONDS
  const stored = trpc.environment.getLatestBedTemp.useQuery({ unit: 'C' }, {
    enabled: !liveFresh, refetchInterval: 30_000, staleTime: 15_000,
  })
  const reading = latestThermalReading(older, newer, stored.data)
  const stale = reading === null || now - reading.ts >= THERMAL_STALE_SECONDS
  const states = {
    left: thermalState(reading?.left ?? EMPTY, controls.left, stale, blocked.left),
    right: thermalState(reading?.right ?? EMPTY, controls.right, stale, blocked.right),
  }
  return (
    <Card className="mb-4 gap-0 overflow-hidden p-0">
      <div className="px-5 pt-4">
        <SectionLabel right={<SensorAge timestamp={reading?.ts} />}>
          Thermal view
          <span className="ml-2 normal-case tracking-normal text-fg-3">
            {reading ? stale ? 'Stale readings' : reading.source === 'live' ? 'Live surface' : 'Stored surface' : 'Waiting for sensors'}
          </span>
        </SectionLabel>
      </div>
      <div className="grid min-[1000px]:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-w-0">
          <ThermalCanvas states={states} focus={focus} unit={unit} view="overview" />
          <div className="mx-auto mb-5 flex max-w-72 items-center gap-3 px-5 font-mono text-[10px] text-fg-2">
            <span>{formatSensorC(18, unit)}</span>
            <div className="h-1.5 flex-1 rounded-full" style={{ background: thermalLegend }} />
            <span>{formatSensorC(36, unit)}</span>
          </div>
        </div>
        <div className="flex flex-col justify-center gap-3 px-5 pb-5 min-[1000px]:pt-5">
          <div className="grid grid-cols-2 gap-3 min-[1000px]:grid-cols-1">
            {SIDES.map((side) => {
              const control = controls[side]
              const powered = control !== undefined && control.targetLevel !== 0
              const state = states[side]
              const label = !control
                ? 'Unavailable'
                : !powered
                    ? 'Off'
                    : blocked[side]
                      ? 'Paused'
                      : stale
                        ? 'Waiting for sensors'
                        : control.currentTemperature === null || control.targetTemperature === null
                          ? 'Waiting for status'
                          : state.direction === -1 ? 'Cooling target' : state.direction === 1 ? 'Warming target' : 'At target'
              return (
                <button
                  key={side}
                  type="button"
                  aria-label={`Inspect ${names[side]} temperatures`}
                  aria-pressed={focus === side}
                  onClick={() => setFocus(focus === side ? null : side)}
                  className={`rounded-xl border p-3 text-left transition-colors ${focus === side ? 'border-fg-3 bg-active' : 'border-line bg-surface'}`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-1 text-xs">
                    <span className="font-medium text-fg">{names[side]}</span>
                    <span className="text-fg-2">{label}</span>
                  </div>
                  <div className="mt-2 flex flex-wrap items-baseline gap-x-2 font-mono">
                    <span className="text-xl text-fg">{formatSetpointF(control?.currentTemperature, unit)}</span>
                    <span className="text-xs text-fg-3">{powered ? `→ ${formatSetpointF(control?.targetTemperature, unit)} target` : 'control off'}</span>
                  </div>

                </button>
              )
            })}
          </div>
          <p className="text-[11px] leading-relaxed text-fg-3">
            Surface color shows the average of available sensors on each side. Moving bands show the heating or cooling target.
          </p>
          <Link href={`/${lang}/system?tab=sensors`} className="text-xs text-fg-2 underline underline-offset-4">Explore all six temperature regions →</Link>
        </div>
      </div>
    </Card>
  )
}
