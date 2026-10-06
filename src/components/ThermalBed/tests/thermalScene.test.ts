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

describe('six measured regions in 3D', () => {
  it('blends each side from its three readings, grays missing regions and disposes annotations', () => {
    vi.stubGlobal('ResizeObserver', Observer)
    vi.stubGlobal('IntersectionObserver', Observer)
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
    const materials: THREE.ShaderMaterial[] = []
    const library = {
      ...THREE,
      ShaderMaterial: class extends THREE.ShaderMaterial {
        constructor(params: THREE.ShaderMaterialParameters) {
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
    const left = { zones: [20, null, 24] as [number, null, number], direction: -1 as const, strength: 1 }
    const right = { zones: [30, 32, 34] as [number, number, number], direction: 1 as const, strength: 1 }
    scene.update({ left, right }, null, 'F')
    // One surface per side carrying its three zone colours.
    expect(materials).toHaveLength(2)
    const zoneColors = () => materials.flatMap(m => (m.uniforms.zoneColors.value as THREE.Color[]).map(c => c.getHexString()))
    expect(zoneColors()).toEqual([20, null, 24, 30, 32, 34].map(v => new THREE.Color(thermalColor(v)).getHexString()))
    expect(materials[0].uniforms.direction.value).toBe(-1)
    expect(materials[1].uniforms.direction.value).toBe(1)
    scene.update({ left: { ...left, zones: [null, null, null] }, right }, null, 'F')
    expect(materials[0].uniforms.strength.value).toBe(0)
    expect(materials[0].uniforms.direction.value).toBe(0)
    scene.update({ left, right }, null, 'F')
    expect(host.querySelector('[data-thermal-region="left-outer"]')?.textContent).toBe('L outer68.0°')
    expect(host.querySelector('[data-thermal-region="left-center"]')?.textContent).toBe('L center--')
    scene.update({ left, right }, 'left', 'C')
    expect(host.querySelector('[data-thermal-region="right-inner"]')?.textContent).toBe('R inner34.0°')
    const dispose = materials.map(m => vi.spyOn(m, 'dispose'))
    scene.dispose()
    expect(host.childElementCount).toBe(0)
    dispose.forEach(fn => expect(fn).toHaveBeenCalledOnce())
    materials.length = 0
    const overview = mountThermalScene(library, host, vi.fn(), 'overview')
    overview.update({ left, right }, null, 'C')
    expect(materials).toHaveLength(2)
    // The overview paints each side's mean into all three zones.
    expect(materials.map(m => new Set((m.uniforms.zoneColors.value as THREE.Color[]).map(c => c.getHexString())).size)).toEqual([1, 1])
    expect(materials.map(m => (m.uniforms.zoneColors.value as THREE.Color[])[0].getHexString())).toEqual([22, 32].map(v => new THREE.Color(thermalColor(v)).getHexString()))
    expect(host.querySelectorAll('[data-thermal-region]')).toHaveLength(0)
    overview.dispose()
    expect(host.childElementCount).toBe(0)
  })
})
