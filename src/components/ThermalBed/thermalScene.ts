import type * as T from 'three'
import type { Three } from '@/src/components/Base/loadThree'
import { createBedModel, SIDE_Z } from '@/src/components/Base/bedModel3D'
import { contactShadow, isLightTheme, paletteFor, roundedBoxGeometry, smoothNormals, studioEnvironment } from '@/src/components/Base/bedLook'
import { attachOrbitInput, createOrbit } from '@/src/components/Base/bedOrbit'
import { layoutThermalLabels } from './thermalLabels'
import { meanTemperature, THERMAL_RAMP, thermalColor } from './thermalData'
import { formatSensorC } from '@/src/lib/tempUtils'
import type { TempUnit } from '@/src/lib/tempUtils'
import type { ThermalSide, ThermalState, ThermalView } from './thermalData'

const SIDES: ThermalSide[] = ['left', 'right']
const ZONES = ['Outer', 'Center', 'Inner'] as const
/** Top of the flat mattress, where the cover's heat map is drawn. */
const SURFACE_Y = 0.762
const SURFACE = { length: 4.92, width: 1.8 }
const PLATFORM = { width: 5.7, depth: 4.4, height: 0.52, radius: 0.2, top: 0.2 }
// A high three-quarter product shot: both sides read, the cover dominates the frame.
const CAMERA = { azimuth: 0.36, elevation: 0.58, distance: 12, fov: 30, fovNarrow: 34 }

const vertexShader = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`
// One surface per side. The three zone readings blend into a soft field across the
// width; a fine knit runs along the length; a slow pulse travels toward the target.
const fragmentShader = `
  varying vec2 vUv;
  uniform vec3 zoneColors[3];
  uniform vec3 cover;
  uniform float time, direction, strength, selected, light;
  float zone(float v, float centre) {
    float d = (v - centre) / 0.24;
    return exp(-d * d);
  }
  float roundedMask(vec2 uv, vec2 size, float radius, float soft) {
    vec2 p = (uv - 0.5) * size;
    vec2 q = abs(p) - (size * 0.5 - radius);
    float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - radius;
    return 1.0 - smoothstep(-soft, soft, d);
  }
  void main() {
    float w0 = zone(vUv.y, 1.0 / 6.0);
    float w1 = zone(vUv.y, 0.5);
    float w2 = zone(vUv.y, 5.0 / 6.0);
    vec3 field = (zoneColors[0] * w0 + zoneColors[1] * w1 + zoneColors[2] * w2) / (w0 + w1 + w2);
    // The sleeper warms the middle of the bed; the head and foot ends fade toward the cover.
    float body = smoothstep(0.0, 0.3, vUv.x) * (1.0 - smoothstep(0.72, 1.0, vUv.x));
    float presence = 0.35 + 0.65 * body;
    vec3 color = mix(cover, field, presence * (0.78 + 0.1 * light));
    float knit = 1.0 - 0.045 * (0.5 + 0.5 * sin(vUv.y * 6.2832 * 92.0));
    color *= knit;
    vec3 intent = direction > 0.0 ? vec3(1.0, 0.56, 0.42) : vec3(0.55, 0.74, 1.0);
    float pulse = pow(0.5 + 0.5 * sin(vUv.x * 7.0 - time * direction * 1.1), 3.0);
    color = mix(color, intent, pulse * 0.16 * strength * body);
    color *= mix(0.6, 1.0, selected);
    float edge = roundedMask(vUv, vec2(${SURFACE.length.toFixed(2)}, ${SURFACE.width.toFixed(2)}), 0.16, 0.03);
    gl_FragColor = vec4(color, edge * 0.96);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`

const pillStyle = (light: boolean) => `position:absolute;z-index:1;pointer-events:none;transform:translate(-50%,-50%);display:flex;align-items:center;gap:7px;`
  + `padding:6px 12px 6px 10px;border-radius:999px;white-space:nowrap;line-height:1;`
  + `backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);`
  + (light
    ? 'background:rgba(255,255,255,0.72);border:1px solid rgba(0,0,0,0.08);color:#1b1b1f;box-shadow:0 2px 12px rgba(0,0,0,0.08)'
    : 'background:rgba(22,22,26,0.62);border:1px solid rgba(255,255,255,0.14);color:#f2f2f4;box-shadow:0 4px 18px rgba(0,0,0,0.35)')

/** Flat schematic: sensor placement along the bed's length is not known. */
export function mountThermalScene(THREE: Three, host: HTMLDivElement, onFail: () => void, view: ThermalView = 'regions') {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5))
  renderer.setClearColor(0, 0)
  renderer.toneMapping = THREE.NeutralToneMapping
  renderer.toneMappingExposure = 1.1
  const canvas = renderer.domElement
  canvas.style.cssText = 'width:100%;height:100%;display:block;touch-action:pan-y'
  const scene = new THREE.Scene()
  let light = isLightTheme()
  let palette = paletteFor(light)
  const hemisphere = new THREE.HemisphereLight('#fbf7f0', '#62626a', 1.7)
  scene.add(hemisphere)
  const key = new THREE.DirectionalLight('#fff6ea', 2.0)
  key.position.set(-3, 7, 4)
  scene.add(key)
  const fill = new THREE.DirectionalLight('#dfe8ff', 0.6)
  fill.position.set(5, 3, -3)
  scene.add(fill)
  let environment = studioEnvironment(THREE, renderer, light)
  // A white card needs less light than a dark one for the same perceived softness.
  const relight = () => {
    scene.environment = environment.texture
    scene.environmentIntensity = light ? 0.7 : 0.9
    hemisphere.intensity = light ? 1.3 : 1.7
    key.intensity = light ? 1.5 : 2.0
  }
  relight()

  const model = createBedModel(THREE, SIDES, { palette, frame: false })
  const flat = { pose: { head: 0, feet: 0 }, target: { head: 0, feet: 0 }, moving: false }
  model.update({ left: flat, right: flat }, 'mattress')
  scene.add(model.root)
  // Upholstered platform in place of the frame, as on the cover showroom renders.
  const platformGeometry = smoothNormals(roundedBoxGeometry(THREE, PLATFORM.width, PLATFORM.height, PLATFORM.depth, PLATFORM.radius, 16))
  const platformMaterial = new THREE.MeshPhysicalMaterial({ color: palette.platform, roughness: 0.9, sheen: 0.4, sheenRoughness: 0.9, sheenColor: new THREE.Color('#ffffff') })
  const platform = new THREE.Mesh(platformGeometry, platformMaterial)
  platform.position.set(0.1, PLATFORM.top - PLATFORM.height / 2, 0)
  scene.add(platform)
  const shadow = contactShadow(THREE, PLATFORM.width * 1.5, PLATFORM.depth * 1.5, palette.shadow)
  shadow.mesh.position.set(0.1, PLATFORM.top - PLATFORM.height - 0.001, 0)
  scene.add(shadow.mesh)

  const geometry = new THREE.PlaneGeometry(SURFACE.length, SURFACE.width)
  const sides = SIDES.map((side) => {
    const material = new THREE.ShaderMaterial({
      vertexShader, fragmentShader, transparent: true, depthWrite: false,
      uniforms: {
        zoneColors: { value: [0, 1, 2].map(() => new THREE.Color(THERMAL_RAMP.missing)) },
        cover: { value: new THREE.Color(palette.mattress) },
        time: { value: 0 }, direction: { value: 0 }, strength: { value: 0 }, selected: { value: 1 }, light: { value: light ? 1 : 0 },
      },
    })
    const mesh = new THREE.Mesh(geometry, material)
    mesh.rotation.x = -Math.PI / 2
    // uv.y runs from the outer edge to the seam on both sides.
    if (side === 'right') mesh.rotation.z = Math.PI
    mesh.position.set(0.25, SURFACE_Y, SIDE_Z[side])
    scene.add(mesh)
    const labels = (view === 'regions' ? [...ZONES] : []).map((zone, index) => {
      const label = document.createElement('div')
      label.dataset.thermalRegion = `${side}-${zone.toLowerCase()}`
      label.style.cssText = pillStyle(light)
      const dot = document.createElement('span')
      dot.style.cssText = 'width:9px;height:9px;border-radius:999px;flex:none;box-shadow:0 0 0 2px rgba(255,255,255,0.18)'
      const title = document.createElement('span')
      title.style.cssText = 'font-size:10px;letter-spacing:0.04em;text-transform:uppercase;opacity:0.7'
      title.textContent = `${side === 'left' ? 'L' : 'R'} ${zone.toLowerCase()}`
      const value = document.createElement('span')
      value.style.cssText = 'font-size:13px;font-variant-numeric:tabular-nums;font-weight:500'
      label.append(dot, title, value)
      const leader = document.createElement('div')
      leader.style.cssText = 'position:absolute;z-index:1;pointer-events:none;width:1px;transform-origin:top center;opacity:0.5;background:currentColor'
      host.append(leader, label)
      const z = SIDE_Z[side] + (side === 'left' ? 1 : -1) * (1 - index) * SURFACE.width / 3
      // Anchors step along the bed so six pills never stack on phones.
      const anchor = new THREE.Vector3(1.1 - index * 1.1 + (side === 'right' ? 0.55 : 0), SURFACE_Y + 0.02, z)
      return { index, label, leader, dot, value, anchor }
    })
    return { side, material, labels }
  })
  const camera = new THREE.PerspectiveCamera(CAMERA.fov, 1, 0.1, 40)
  const orbit = createOrbit(CAMERA.azimuth)
  orbit.state.elevation = CAMERA.elevation
  orbit.state.distance = CAMERA.distance
  const place = () => {
    const p = orbit.position(0)
    camera.position.set(p.x, p.y, p.z)
    camera.lookAt(0.1, 0.35, 0)
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
      const all = sides.flatMap(side => side.labels)
      const anchors = all.map((region) => {
        const p = region.anchor.clone().project(camera)
        return { x: (p.x + 1) / 2 * host.clientWidth, y: (1 - p.y) / 2 * host.clientHeight, width: region.label.offsetWidth, height: region.label.offsetHeight }
      })
      const placed = layoutThermalLabels(anchors, host.clientWidth, host.clientHeight)
      all.forEach(({ label, leader }, i) => {
        const from = anchors[i]
        const to = placed[i]
        label.style.left = `${to.x}px`
        label.style.top = `${to.y}px`
        const dx = to.x - from.x
        const dy = to.y - from.y
        leader.style.left = `${from.x}px`
        leader.style.top = `${from.y}px`
        leader.style.height = `${Math.hypot(dx, dy)}px`
        leader.style.transform = `rotate(${Math.atan2(-dx, dy)}rad)`
      })
      for (const side of sides) side.material.uniforms.time.value = reduced.matches ? 0 : now / 1000
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
    camera.fov = width / height < 1.2 ? CAMERA.fovNarrow : CAMERA.fov
    camera.updateProjectionMatrix()
    requestRender()
  }
  const applyTheme = () => {
    const next = isLightTheme()
    if (next === light) return
    light = next
    palette = paletteFor(light)
    environment.dispose()
    environment = studioEnvironment(THREE, renderer, light)
    relight()
    model.recolor(palette)
    platformMaterial.color.set(palette.platform)
    shadow.setOpacity(palette.shadow)
    for (const side of sides) {
      ;(side.material.uniforms.cover.value as T.Color).set(palette.mattress)
      side.material.uniforms.light.value = light ? 1 : 0
      for (const { label } of side.labels) label.style.cssText = pillStyle(light)
    }
    requestRender()
  }
  const theme = new MutationObserver(applyTheme)
  theme.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] })
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
      for (const { side, material, labels } of sides) {
        const state = states[side]
        const readings = view === 'regions' ? state.zones : state.zones.map(() => meanTemperature(state.zones))
        const colors = material.uniforms.zoneColors.value as T.Color[]
        readings.forEach((measured, index) => colors[index].set(thermalColor(measured)))
        const any = readings.some(value => value !== null)
        // A side with no readings stays the cover's colour, even while it has an active target.
        material.uniforms.direction.value = any ? state.direction : 0
        material.uniforms.strength.value = any ? state.strength : 0
        material.uniforms.selected.value = focus && focus !== side ? 0 : 1
        for (const { index, label, dot, value, leader } of labels) {
          const measured = state.zones[index]
          const color = thermalColor(measured)
          label.style.opacity = focus && focus !== side ? '0.5' : '1'
          leader.style.opacity = focus && focus !== side ? '0.25' : '0.5'
          dot.style.background = color
          leader.style.color = color
          value.textContent = formatSensorC(measured, unit, { decimals: 1, includeUnit: false })
        }
      }
      requestRender()
    },
    dispose() {
      disposed = true
      cancelAnimationFrame(frame)
      observer.disconnect()
      intersection.disconnect()
      theme.disconnect()
      detach()
      document.removeEventListener('visibilitychange', requestRender)
      reduced.removeEventListener('change', requestRender)
      canvas.removeEventListener('webglcontextlost', lost)
      model.dispose()
      geometry.dispose()
      platformGeometry.dispose()
      platformMaterial.dispose()
      shadow.dispose()
      environment.dispose()
      for (const { material, labels } of sides) {
        material.dispose()
        for (const { label, leader } of labels) {
          label.remove()
          leader.remove()
        }
      }
      renderer.dispose()
      renderer.forceContextLoss()
      canvas.remove()
    },
  }
}
