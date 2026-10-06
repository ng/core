import type { Three } from '@/src/components/Base/loadThree'
import { createBedModel, SIDE_Z } from '@/src/components/Base/bedModel3D'
import { attachOrbitInput, createOrbit } from '@/src/components/Base/bedOrbit'
import { thermalColor } from './thermalData'
import type { ThermalSide, ThermalState } from './thermalData'

const SIDES: ThermalSide[] = ['left', 'right']
const vertexShader = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`
const fragmentShader = `
  varying vec2 vUv;
  uniform vec3 outerColor, centerColor, innerColor;
  uniform float time, direction, strength, flip, selected;
  void main() {
    float across = mix(vUv.y, 1.0 - vUv.y, flip);
    vec3 surface = across < 0.5
      ? mix(outerColor, centerColor, smoothstep(0.0, 0.5, across))
      : mix(centerColor, innerColor, smoothstep(0.5, 1.0, across));
    vec2 grid = fract(vUv * vec2(115.0, 45.0)) - 0.5;
    float dots = 1.0 - smoothstep(0.13, 0.3, length(grid));
    float wave = pow(0.5 + 0.5 * sin(vUv.x * 65.0 - time * direction * 1.8 + sin(vUv.y * 6.28) * 1.2), 5.0);
    vec3 intent = direction > 0.0 ? vec3(1.0, 0.32, 0.22) : vec3(0.12, 0.5, 1.0);
    vec3 color = surface * (0.64 + dots * 0.3);
    color += intent * wave * (0.18 + dots * 0.85) * strength * 1.3;
    float edge = smoothstep(0.0, 0.035, vUv.x) * smoothstep(0.0, 0.035, 1.0 - vUv.x)
      * smoothstep(0.0, 0.06, vUv.y) * smoothstep(0.0, 0.06, 1.0 - vUv.y);
    gl_FragColor = vec4(color * selected, edge * 0.94);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`

/** Flat schematic: sensor placement along the bed's length is not known. */
export function mountThermalScene(THREE: Three, host: HTMLDivElement, onFail: () => void) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5))
  renderer.setClearColor(0, 0)
  const canvas = renderer.domElement
  canvas.style.cssText = 'width:100%;height:100%;display:block;touch-action:pan-y'
  const scene = new THREE.Scene()
  scene.add(new THREE.HemisphereLight('#ffffff', '#343548', 2.5))
  const light = new THREE.DirectionalLight('#fff3e4', 3)
  light.position.set(-3, 6, 4)
  scene.add(light)
  const model = createBedModel(THREE, SIDES)
  const flat = { pose: { head: 0, feet: 0 }, target: { head: 0, feet: 0 }, moving: false }
  model.update({ left: flat, right: flat }, 'mattress')
  scene.add(model.root)
  const geometry = new THREE.PlaneGeometry(4.5, 1.82)
  const materials = SIDES.map((side) => {
    const material = new THREE.ShaderMaterial({
      vertexShader, fragmentShader, transparent: true, depthWrite: false,
      uniforms: {
        outerColor: { value: new THREE.Color('#626875') },
        centerColor: { value: new THREE.Color('#626875') },
        innerColor: { value: new THREE.Color('#626875') },
        time: { value: 0 }, direction: { value: 0 }, strength: { value: 0 },
        flip: { value: side === 'right' ? 1 : 0 }, selected: { value: 1 },
      },
    })
    const mesh = new THREE.Mesh(geometry, material)
    mesh.rotation.x = -Math.PI / 2
    mesh.position.set(0.25, 0.758, SIDE_Z[side])
    scene.add(mesh)
    return material
  })
  const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 40)
  const orbit = createOrbit(0.36)
  orbit.state.elevation = 0.85
  orbit.state.distance = 11.2
  const place = () => {
    const p = orbit.position(0)
    camera.position.set(p.x, p.y, p.z)
    camera.lookAt(0, 0.3, 0)
  }
  place()
  let frame = 0
  let lastDraw = 0
  let visible = true
  let moving = false
  let disposed = false
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')
  const render = (now: number) => {
    frame = 0
    if (disposed || document.hidden || !visible) return
    if (now - lastDraw >= 1000 / 30 || !moving || reduced.matches) {
      lastDraw = now
      for (const m of materials) m.uniforms.time.value = reduced.matches ? 0 : now / 1000
      renderer.render(scene, camera)
    }
    if (moving && !reduced.matches) frame = requestAnimationFrame(render)
  }
  const requestRender = () => {
    if (!frame && !disposed) frame = requestAnimationFrame(render)
  }
  const resize = () => {
    const { width, height } = host.getBoundingClientRect()
    if (!width || !height) return
    renderer.setSize(width, height, false)
    camera.aspect = width / height
    // Keep both sides in frame on narrow phones.
    camera.fov = width / height < 1.2 ? 43 : 32
    camera.updateProjectionMatrix()
    requestRender()
  }
  const detach = attachOrbitInput(canvas, orbit, () => {
    place()
    requestRender()
  })
  const observer = new ResizeObserver(resize)
  observer.observe(host)
  const intersection = new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting
    requestRender()
  })
  intersection.observe(host)
  const lost = (event: Event) => {
    event.preventDefault()
    onFail()
  }
  canvas.addEventListener('webglcontextlost', lost)
  document.addEventListener('visibilitychange', requestRender)
  reduced.addEventListener('change', requestRender)
  host.appendChild(canvas)
  resize()
  return {
    update(states: Record<ThermalSide, ThermalState>, focus: ThermalSide | null) {
      moving = SIDES.some(side => states[side].direction !== 0)
      materials.forEach((m, i) => {
        const state = states[SIDES[i]]
        for (const [zone, key] of ['outerColor', 'centerColor', 'innerColor'].entries()) {
          (m.uniforms[key].value as InstanceType<Three['Color']>).set(thermalColor(state.zones[zone]))
        }
        m.uniforms.direction.value = state.direction
        m.uniforms.strength.value = state.strength
        m.uniforms.selected.value = focus && focus !== SIDES[i] ? 0.55 : 1
      })
      requestRender()
    },
    dispose() {
      disposed = true
      cancelAnimationFrame(frame)
      observer.disconnect()
      intersection.disconnect()
      detach()
      document.removeEventListener('visibilitychange', requestRender)
      reduced.removeEventListener('change', requestRender)
      canvas.removeEventListener('webglcontextlost', lost)
      model.dispose()
      geometry.dispose()
      materials.forEach(m => m.dispose())
      renderer.dispose()
      renderer.forceContextLoss()
      canvas.remove()
    },
  }
}
