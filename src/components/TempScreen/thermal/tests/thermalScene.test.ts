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
  it('keeps each measurement independent, grays missing regions and disposes annotations', () => {
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
    } as unknown as Three
    const host = document.createElement('div')
    const scene = mountThermalScene(library, host, vi.fn())
    const left = { zones: [20, null, 24] as [number, null, number], direction: -1 as const, strength: 1 }
    const right = { zones: [30, 32, 34] as [number, number, number], direction: 1 as const, strength: 1 }
    scene.update({ left, right }, null, 'F')
    expect(materials).toHaveLength(6)
    expect(new Set(materials).size).toBe(6)
    expect(materials.map(m => (m.uniforms.surfaceColor.value as THREE.Color).getHexString())).toEqual([20, null, 24, 30, 32, 34].map(v => new THREE.Color(thermalColor(v)).getHexString()))
    expect(materials[1].uniforms.strength.value).toBe(0)
    expect(host.querySelector('[data-thermal-region="left-outer"]')?.textContent).toBe('L outer68.0°')
    expect(host.querySelector('[data-thermal-region="left-center"]')?.textContent).toBe('L center--')
    scene.update({ left, right }, 'left', 'C')
    expect(host.querySelector('[data-thermal-region="right-inner"]')?.textContent).toBe('R inner34.0°')
    const dispose = materials.map(m => vi.spyOn(m, 'dispose'))
    scene.dispose()
    expect(host.childElementCount).toBe(0)
    dispose.forEach(fn => expect(fn).toHaveBeenCalledOnce())
  })
})
