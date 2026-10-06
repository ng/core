import type { Three } from '@/src/components/Base/loadThree'
import { createBedModel, SIDE_Z } from '@/src/components/Base/bedModel3D'
import { attachOrbitInput, createOrbit } from '@/src/components/Base/bedOrbit'
import { layoutThermalLabels } from './thermalLabels'
import { meanTemperature, thermalColor } from './thermalData'
import { formatSensorC } from '@/src/lib/tempUtils'
import type { TempUnit } from '@/src/lib/tempUtils'
import type { ThermalSide, ThermalState, ThermalView } from './thermalData'

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
  uniform vec3 surfaceColor;
  uniform float time, direction, strength, selected;
  void main() {
    vec2 grid = fract(vUv * vec2(115.0, 15.0)) - 0.5;
    float dots = 1.0 - smoothstep(0.13, 0.3, length(grid));
    float wave = pow(0.5 + 0.5 * sin(vUv.x * 65.0 - time * direction * 1.8 + sin(vUv.y * 6.28) * 1.2), 5.0);
    vec3 intent = direction > 0.0 ? vec3(1.0, 0.32, 0.22) : vec3(0.12, 0.5, 1.0);
    vec3 color = surfaceColor * 0.85;
    color += intent * wave * (0.18 + dots * 0.85) * strength * 1.3;
    float edge = smoothstep(0.0, 0.035, vUv.x) * smoothstep(0.0, 0.035, 1.0 - vUv.x)
      * smoothstep(0.0, 0.06, vUv.y) * smoothstep(0.0, 0.06, 1.0 - vUv.y);
    gl_FragColor = vec4(color * selected, edge * 0.94);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`

/** Flat schematic: sensor placement along the bed's length is not known. */
export function mountThermalScene(THREE: Three, host: HTMLDivElement, onFail: () => void, view: ThermalView = 'regions') {
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
  const geometry = new THREE.PlaneGeometry(4.5, 1.82 / (view === 'regions' ? 3 : 1) - 0.025)
  // One mesh per measurement. Gaps preserve the actual six-channel resolution.
  const regions = SIDES.flatMap(side => (view === 'regions' ? ['Outer', 'Center', 'Inner'] : ['Side']).map((zone, index) => {
    const material = new THREE.ShaderMaterial({
      vertexShader, fragmentShader, transparent: true, depthWrite: false,
      uniforms: {
        surfaceColor: { value: new THREE.Color('#626875') },
        time: { value: 0 }, direction: { value: 0 }, strength: { value: 0 }, selected: { value: 1 },
      },
    })
    const mesh = new THREE.Mesh(geometry, material)
    mesh.rotation.x = -Math.PI / 2
    const z = SIDE_Z[side] + (view === 'regions' ? (side === 'left' ? 1 : -1) * (1 - index) * 1.82 / 3 : 0)
    mesh.position.set(0.25, 0.758, z)
    scene.add(mesh)
    const label = document.createElement('div')
    label.dataset.thermalRegion = `${side}-${zone.toLowerCase()}`
    label.style.cssText = 'position:absolute;z-index:1;pointer-events:none;transform:translate(-50%,-50%);text-align:center;border:1px solid #ffffff40;border-radius:5px;padding:3px 4px;background:#141820dc;color:#fff;font-family:monospace;line-height:1.2;white-space:nowrap'
    const title = document.createElement('div')
    title.style.cssText = 'font-size:8px;color:#c6ccd4'
    title.textContent = `${side === 'left' ? 'L' : 'R'} ${zone.toLowerCase()}`
    const value = document.createElement('div')
    value.style.cssText = 'font-size:11px'
    label.append(title, value)
    const leader = document.createElement('div')
    leader.style.cssText = 'position:absolute;z-index:1;pointer-events:none;width:1px;background:#e2e8f099;transform-origin:top center'
    if (view === 'regions') host.append(leader, label)
    // Stagger annotation anchors so all six readings remain legible on phones.
    // The stripes, not these label positions, encode the schematic regions.
    const anchor = new THREE.Vector3(1.2 - index * 1.2 + (side === 'right' ? 0.6 : 0), 0.8, z)
    return { side, index, material, label, leader, value, anchor }
  }))
  const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 40)
  const orbit = createOrbit(0.36)
  orbit.state.elevation = 0.85
  orbit.state.distance = 11.2
  const place = () => {
    const p = orbit.position(0)
    camera.position.set(p.x, p.y, p.z)
    camera.lookAt(0, 0.3, 0)
    camera.updateMatrixWorld()
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
      const anchors = regions.map((region) => {
        region.material.uniforms.time.value = reduced.matches ? 0 : now / 1000
        const p = region.anchor.clone().project(camera)
        return { x: (p.x + 1) / 2 * host.clientWidth, y: (1 - p.y) / 2 * host.clientHeight, width: region.label.offsetWidth, height: region.label.offsetHeight }
      })
      const labels = layoutThermalLabels(anchors, host.clientWidth, host.clientHeight)
      regions.forEach(({ label, leader }, i) => {
        const from = anchors[i]
        const to = labels[i]
        label.style.left = `${to.x}px`
        label.style.top = `${to.y}px`
        const dx = to.x - from.x
        const dy = to.y - from.y
        leader.style.left = `${from.x}px`
        leader.style.top = `${from.y}px`
        leader.style.height = `${Math.hypot(dx, dy)}px`
        leader.style.transform = `rotate(${Math.atan2(-dx, dy)}rad)`
      })
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
    camera.fov = width / height < 1.2 ? 36 : 32
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
    update(states: Record<ThermalSide, ThermalState>, focus: ThermalSide | null, unit: TempUnit) {
      moving = SIDES.some(side => states[side].direction !== 0 && states[side].zones.some(value => value !== null))
      regions.forEach(({ side, index, material: m, label, value }) => {
        const state = states[side]
        const measured = view === 'regions' ? state.zones[index] : meanTemperature(state.zones)
        const color = thermalColor(measured)
        ;(m.uniforms.surfaceColor.value as InstanceType<Three['Color']>).set(color)
        // A missing region stays gray, including while its side has an active target.
        m.uniforms.direction.value = measured === null ? 0 : state.direction
        m.uniforms.strength.value = measured === null ? 0 : state.strength * 0.5
        m.uniforms.selected.value = focus && focus !== side ? 0.55 : 1
        label.style.opacity = focus && focus !== side ? '0.55' : '1'
        label.style.borderColor = color
        value.textContent = formatSensorC(measured, unit, { decimals: 1, includeUnit: false })
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
      regions.forEach(({ material, label, leader }) => {
        material.dispose()
        label.remove()
        leader.remove()
      })
      renderer.dispose()
      renderer.forceContextLoss()
      canvas.remove()
    },
  }
}
