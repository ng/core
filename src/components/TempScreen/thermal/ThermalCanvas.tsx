'use client'

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { hasWebGL, loadThree } from '@/src/components/Base/loadThree'
import { mountThermalScene } from './thermalScene'
import { thermalColor } from './thermalData'
import type { ThermalSide, ThermalState } from './thermalData'

interface Props {
  states: Record<ThermalSide, ThermalState>
  focus: ThermalSide | null
}

export default function ThermalCanvas({ states, focus }: Props) {
  const host = useRef<HTMLDivElement>(null)
  const scene = useRef<ReturnType<typeof mountThermalScene> | null>(null)
  const [mode, setMode] = useState<'loading' | '3d' | '2d'>('loading')
  const latest = useRef({ states, focus })
  useLayoutEffect(() => {
    latest.current = { states, focus }
    scene.current?.update(states, focus)
  }, [states, focus])
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
        scene.current = mountThermalScene(three, host.current, fail)
        scene.current.update(latest.current.states, latest.current.focus)
        setMode('3d')
      }
      catch { fail() }
    })()
    return () => {
      alive = false
      scene.current?.dispose()
      scene.current = null
    }
  }, [])
  return (
    <div className="relative h-[300px] min-[600px]:h-[360px]" aria-label="Bed surface temperature visualization">
      <div ref={host} aria-hidden="true" className="absolute inset-0" />
      {mode === 'loading' && <div role="status" className="absolute inset-0 grid place-items-center text-sm text-fg-3">Loading thermal view…</div>}
      {mode === '2d' && (
        <div aria-hidden="true" className="absolute inset-8 mx-auto grid max-w-72 grid-cols-2 gap-1 rounded-3xl border border-line bg-active p-3">
          {(['left', 'right'] as const).map(side => (
            <div key={side} className="relative overflow-hidden rounded-xl" style={{ background: `linear-gradient(to ${side === 'left' ? 'right' : 'left'}, ${states[side].zones.map(thermalColor).join(', ')})` }}>
              <div className="absolute inset-x-3 top-3 h-12 rounded-xl bg-white/40" />
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
