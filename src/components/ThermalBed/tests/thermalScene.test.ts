import * as THREE from 'three'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Three } from '@/src/components/Base/loadThree'
import { mountThermalScene } from '../thermalScene'
import { thermalColor } from '../thermalData'

class Observer {
  observe() {}
  disconnect() {}
}
afterEach(() => vi.unstubAllGlobals())

interface HeatUniforms { zoneColors: { value: THREE.Color[] }, direction: { value: number }, strength: { value: number }, selected: { value: number } }
const heat = (materials: THREE.MeshPhysicalMaterial[]) => materials.filter(m => m.userData.uniforms).map(m => m.userData.uniforms as HeatUniforms)

describe('six measured regions in 3D', () => {
  it('paints each side from its three readings, grays missing regions and disposes annotations', () => {
    vi.stubGlobal('ResizeObserver', Observer)
    vi.stubGlobal('IntersectionObserver', Observer)
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
    const materials: THREE.MeshPhysicalMaterial[] = []
    const library = {
      ...THREE,
      MeshPhysicalMaterial: class extends THREE.MeshPhysicalMaterial {
        constructor(params: THREE.MeshPhysicalMaterialParameters) {
          super(params)
          materials.push(this)
        }
      },
      WebGLRenderer: class {
        domElement = document.createElement('canvas')
        setPixelRatio() {}
        setClearColor() {}
        setSize() {}
        dispose() {}
        forceContextLoss() {}
      },
      // No GL in jsdom: the studio environment prefilter is skipped.
      PMREMGenerator: class {
        fromScene() {
          return { texture: null, dispose() {} }
        }

        dispose() {}
      },
    } as unknown as Three
    const host = document.createElement('div')
    const scene = mountThermalScene(library, host, vi.fn())
    const left = { zones: [20, null, 24] as [number, null, number], direction: -1 as const, strength: 1, mode: 'cooling' as const, targetF: 70, currentF: 80 }
    const right = { zones: [30, 32, 34] as [number, number, number], direction: 1 as const, strength: 1, mode: 'heating' as const, targetF: 90, currentF: 80 }
    scene.update({ left, right }, null, 'F')
    // Region callouts only; the status pills belong to the overview.
    expect(host.querySelectorAll('[data-thermal-pill]')).toHaveLength(0)
    // The heat field lives in the mattress top material, one per side.
    const sides = heat(materials)
    expect(sides).toHaveLength(2)
    const zoneColors = () => sides.flatMap(u => u.zoneColors.value.map(c => c.getHexString()))
    expect(zoneColors()).toEqual([20, null, 24, 30, 32, 34].map(v => new THREE.Color(thermalColor(v)).getHexString()))
    expect(sides.map(u => u.direction.value)).toEqual([-1, 1])
    scene.update({ left: { ...left, zones: [null, null, null] }, right }, null, 'F')
    expect(sides[0].strength.value).toBe(0)
    expect(sides[0].direction.value).toBe(0)
    scene.update({ left, right }, null, 'F')
    expect(host.querySelector('[data-thermal-region="left-outer"]')?.textContent).toBe('L outer68.0°')
    expect(host.querySelector('[data-thermal-region="left-center"]')?.textContent).toBe('L center--')
    scene.update({ left, right }, 'left', 'C')
    expect(host.querySelector('[data-thermal-region="right-inner"]')?.textContent).toBe('R inner34.0°')
    expect(sides.map(u => u.selected.value)).toEqual([1, 0])
    const dispose = materials.map(m => vi.spyOn(m, 'dispose'))
    scene.dispose()
    expect(host.childElementCount).toBe(0)
    dispose.forEach(fn => expect(fn).toHaveBeenCalledOnce())
    materials.length = 0
    const overview = mountThermalScene(library, host, vi.fn(), 'overview')
    overview.update({ left, right }, null, 'C')
    const means = heat(materials)
    expect(means).toHaveLength(2)
    // The overview paints each side's mean into all three zones.
    expect(means.map(u => new Set(u.zoneColors.value.map(c => c.getHexString())).size)).toEqual([1, 1])
    expect(means.map(u => u.zoneColors.value[0].getHexString())).toEqual([22, 32].map(v => new THREE.Color(thermalColor(v)).getHexString()))
    expect(host.querySelectorAll('[data-thermal-region]')).toHaveLength(0)
    // One status pill per side: surface mean, setpoint and the pod's mode for the ring.
    const pill = (side: string) => host.querySelector<HTMLElement>(`[data-thermal-pill="${side}"]`)
    expect(pill('left')?.dataset.mode).toBe('cooling')
    expect(pill('left')?.title).toBe('Cooling')
    expect(pill('left')?.textContent).toBe('22°→ 21°')
    expect(pill('right')?.textContent).toBe('32°→ 32°')
    overview.update({ left: { ...left, zones: [null, null, null], mode: 'off', targetF: null }, right }, 'right', 'F')
    expect(pill('left')?.dataset.mode).toBe('off')
    expect(pill('left')?.textContent).toBe('--')
    expect(pill('left')?.style.opacity).toBe('0.45')
    expect(pill('right')?.style.opacity).toBe('1')
    overview.dispose()
    expect(host.childElementCount).toBe(0)
  })
})
