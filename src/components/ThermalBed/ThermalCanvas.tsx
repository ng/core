'use client'

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { hasWebGL, loadThree } from '@/src/components/Base/loadThree'
import { mountThermalScene } from './thermalScene'
import { formatSensorC } from '@/src/lib/tempUtils'
import type { TempUnit } from '@/src/lib/tempUtils'
import { meanTemperature, thermalColor } from './thermalData'
import type { ThermalSide, ThermalState, ThermalView } from './thermalData'

interface Props {
  states: Record<ThermalSide, ThermalState>
  focus: ThermalSide | null
  unit: TempUnit
  view?: ThermalView
}

export default function ThermalCanvas({ states, focus, unit, view = 'regions' }: Props) {
  const host = useRef<HTMLDivElement>(null)
  const scene = useRef<ReturnType<typeof mountThermalScene> | null>(null)
  const [mode, setMode] = useState<'loading' | '3d' | '2d'>('loading')
  const latest = useRef({ states, focus, unit })
  useLayoutEffect(() => {
    latest.current = { states, focus, unit }
    scene.current?.update(states, focus, unit)
  }, [states, focus, unit])
  useEffect(() => {
    let alive = true
    const fail = () => {
      scene.current?.dispose()
      scene.current = null
      if (alive) setMode('2d')
    }
    void (async () => {
      if (!hasWebGL()) {
        fail()
        return
      }
      const three = await loadThree()
      if (!alive) return
      if (!three || !host.current) {
        fail()
        return
      }
      try {
        scene.current = mountThermalScene(three, host.current, fail, view)
        scene.current.update(latest.current.states, latest.current.focus, latest.current.unit)
        setMode('3d')
      }
      catch { fail() }
    })()
    return () => {
      alive = false
      scene.current?.dispose()
      scene.current = null
    }
  }, [view])
  return (
    <div className="relative h-[300px] min-[600px]:h-[360px]" aria-label="Bed surface temperature visualization">
      <div ref={host} aria-hidden="true" className="absolute inset-0" />
      {mode === 'loading' && <div role="status" className="absolute inset-0 grid place-items-center text-sm text-fg-3">Loading thermal view…</div>}
      {mode === '2d' && (
        <div aria-hidden="true" className="absolute inset-x-5 top-6 bottom-10 mx-auto grid max-w-md grid-cols-2 gap-2 rounded-3xl border border-line bg-active p-2">
          {(['left', 'right'] as const).map(side => (
            <div key={side} className={`relative grid ${view === 'regions' ? 'grid-cols-3' : 'grid-cols-1'} gap-0.5 overflow-hidden rounded-xl pt-12`}>
              <div className="absolute inset-x-3 top-2 h-8 rounded-xl bg-white/40" />
              {(view === 'overview' ? [0] : side === 'left' ? [0, 1, 2] : [2, 1, 0]).map(index => (
                <div key={index} data-thermal-region={`${side}-${view === 'overview' ? 'side' : ['outer', 'center', 'inner'][index]}`} className="flex flex-col items-center justify-center gap-2 text-center font-mono text-[9px] text-white" style={{ backgroundColor: thermalColor(view === 'overview' ? meanTemperature(states[side].zones) : states[side].zones[index]) }}>
                  {view === 'regions' && (
                    <span className="rounded bg-black/70 px-0.5 py-1">
                      <span className="block text-[8px]">
                        {side === 'left' ? 'L' : 'R'}
                        {' '}
                        {['outer', 'center', 'inner'][index]}
                      </span>
                      {formatSensorC(states[side].zones[index], unit, { decimals: 1, includeUnit: false })}
                    </span>
                  )}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
      <span className="absolute inset-x-0 bottom-2 text-center text-[10px] uppercase tracking-[0.15em] text-fg-3">
        {mode === '3d' ? 'Drag to rotate · Pinch to zoom' : mode === '2d' ? 'Surface overview' : ''}
      </span>
    </div>
  )
}
