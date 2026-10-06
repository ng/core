import type * as T from 'three'
import type { Three } from '@/src/components/Base/loadThree'
import { createBedModel, HALF_WIDTH, SIDE_Z } from '@/src/components/Base/bedModel3D'
import { contactShadow, isLightTheme, paletteFor, roundedBoxGeometry, smoothNormals, studioEnvironment } from '@/src/components/Base/bedLook'
import { attachOrbitInput, createOrbit } from '@/src/components/Base/bedOrbit'
import { layoutThermalLabels } from './thermalLabels'
import { meanTemperature, THERMAL_RAMP, thermalColor } from './thermalData'
import { formatSensorC } from '@/src/lib/tempUtils'
import type { TempUnit } from '@/src/lib/tempUtils'
import type { ThermalSide, ThermalState, ThermalView } from './thermalData'

const SIDES: ThermalSide[] = ['left', 'right']
const ZONES = ['Outer', 'Center', 'Inner'] as const
/** Top of the flat mattress; the heat field fades out down its rounded edge. */
const SURFACE_Y = 0.75
const BED_LENGTH = 5.2
const PLATFORM = { width: 5.7, depth: HALF_WIDTH * 2 + 0.5, height: 0.6, radius: 0.24, top: 0.2 }
// A high three-quarter product shot with a long lens: the cover dominates, both sides read.
const CAMERA = { azimuth: 0.36, elevation: 0.73, distance: 14, fov: 26, fovNarrow: 30 }
/** Below this host width the pills drop their zone names so six of them fit on the bed. */
const COMPACT_WIDTH = 520

interface HeatUniforms {
  zoneColors: { value: T.Color[] }
  intent: { value: T.Color }
  cover: { value: T.Color }
  sideZ: { value: number }
  time: { value: number }
  direction: { value: number }
  strength: { value: number }
  selected: { value: number }
  motion: { value: number }
}

const heatPars = `
  varying vec3 vHeatPos;
  uniform vec3 zoneColors[3];
  uniform vec3 intent;
  uniform vec3 cover;
  uniform float sideZ, time, direction, strength, selected, motion;
  float zoneWeight(float w, float centre) {
    float d = (w - centre) / 0.19;
    return exp(-d * d);
  }
`
// Runs after color_fragment, so diffuseColor is the lit fabric colour. The heat is a tint
// inside the fabric: three readings blend into one soft field across the width, the body
// warms the middle of the bed, a fine rib runs across the width and a slow pulse travels
// toward the target. Everything fades out down the rounded edge via the world height.
const heatFragment = `
  {
    float top = smoothstep(${(SURFACE_Y - 0.14).toFixed(2)}, ${(SURFACE_Y - 0.03).toFixed(2)}, vHeatPos.y);
    float u = clamp((vHeatPos.x + ${(BED_LENGTH / 2).toFixed(2)}) / ${BED_LENGTH.toFixed(2)}, 0.0, 1.0);
    float w = clamp((vHeatPos.z - sideZ) / ${(HALF_WIDTH - 0.02).toFixed(2)} * sign(sideZ) + 0.5, 0.0, 1.0);
    float w0 = zoneWeight(w, 1.0 / 6.0);
    float w1 = zoneWeight(w, 0.5);
    float w2 = zoneWeight(w, 5.0 / 6.0);
    vec3 field = (zoneColors[0] * w0 + zoneColors[1] * w1 + zoneColors[2] * w2) / (w0 + w1 + w2);
    // Lighting and the grey cover desaturate the tint; push the field back toward the legend's hue.
    field = clamp(mix(vec3(dot(field, vec3(0.299, 0.587, 0.114))), field, 1.4), 0.0, 1.0);
    float body = smoothstep(0.0, 0.22, u) * (1.0 - smoothstep(0.8, 1.0, u));
    float presence = top * (0.6 + 0.4 * body);
    vec3 heat = mix(cover, field, 1.0);
    float rib = 0.5 + 0.5 * sin(vHeatPos.x * ${(Math.PI * 2 / 0.05).toFixed(3)});
    float ribFade = 1.0 - smoothstep(0.015, 0.045, fwidth(vHeatPos.x));
    heat *= 1.0 - 0.07 * rib * ribFade;
    float pulse = pow(0.5 + 0.5 * sin(vHeatPos.x * 3.1416 - time * direction * 1.9), 2.0);
    float breath = 1.0 + 0.04 * sin(time * 1.2566) * motion * step(0.5, abs(direction));
    heat = mix(heat, intent, (motion * pulse * 0.12 + (1.0 - motion) * 0.08) * strength * body);
    heat *= breath;
    vec3 shown = mix(diffuseColor.rgb, heat, presence);
    diffuseColor.rgb = mix(shown, cover, 0.55 * (1.0 - selected));
  }
`

const pillStyle = (light: boolean, compact: boolean, tint: string) => `position:absolute;z-index:1;pointer-events:none;transform:translate(-50%,-50%);display:flex;align-items:center;gap:${compact ? 6 : 8}px;`
  + `padding:${compact ? '5px 8px 5px 10px' : '7px 10px 7px 14px'};border-radius:999px;white-space:nowrap;line-height:1;`
  + `backdrop-filter:blur(14px) saturate(1.2);-webkit-backdrop-filter:blur(14px) saturate(1.2);`
  + `background:linear-gradient(${tint}2e, ${tint}2e), rgba(255,255,255,0.08);`
  + (light
    ? 'border:1px solid rgba(0,0,0,0.08);color:#1a1a1c;box-shadow:0 2px 12px rgba(0,0,0,0.08)'
    : 'border:1px solid rgba(255,255,255,0.28);color:#ffffff;box-shadow:0 4px 18px rgba(0,0,0,0.3)')

/** Flat schematic: sensor placement along the bed's length is not known. */
export function mountThermalScene(THREE: Three, host: HTMLDivElement, onFail: () => void, view: ThermalView = 'regions') {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
  renderer.setClearColor(0, 0)
  renderer.toneMapping = THREE.NeutralToneMapping
  const canvas = renderer.domElement
  canvas.style.cssText = 'width:100%;height:100%;display:block;touch-action:pan-y'
  const scene = new THREE.Scene()
  let light = isLightTheme()
  let palette = paletteFor(light)
  const theme = () => light ? 'light' as const : 'dark' as const
  const hemisphere = new THREE.HemisphereLight('#e8e4dc', '#62626a', 1.5)
  scene.add(hemisphere)
  const key = new THREE.DirectionalLight('#fff1e0', 2.0)
  key.position.set(-4.5, 7, 3)
  scene.add(key)
  const fill = new THREE.DirectionalLight('#cfdcf0', 0.6)
  fill.position.set(4, 2.5, 4)
  scene.add(fill)
  const rim = new THREE.DirectionalLight('#ffffff', 0.6)
  rim.position.set(0, 4, -6)
  scene.add(rim)
  let environment = studioEnvironment(THREE, renderer, light)
  // A white card needs less light than a dark one for the same perceived softness.
  const relight = () => {
    scene.environment = environment.texture
    scene.environmentIntensity = light ? 0.6 : 0.8
    renderer.toneMappingExposure = light ? 1.0 : 1.1
    hemisphere.intensity = light ? 1.2 : 1.5
    key.intensity = light ? 1.5 : 2.0
    rim.intensity = light ? 0.3 : 0.6
  }
  relight()

  const uniformsBySide = {} as Record<ThermalSide, HeatUniforms>
  const heatMaterial = (side: ThermalSide) => {
    const uniforms: HeatUniforms = {
      zoneColors: { value: [0, 1, 2].map(() => new THREE.Color(THERMAL_RAMP[theme()][2])) },
      intent: { value: new THREE.Color(THERMAL_RAMP[theme()][2]) },
      cover: { value: new THREE.Color(palette.mattress) },
      sideZ: { value: SIDE_Z[side] },
      time: { value: 0 },
      direction: { value: 0 },
      strength: { value: 0 },
      selected: { value: 1 },
      motion: { value: 1 },
    }
    uniformsBySide[side] = uniforms
    const material = new THREE.MeshPhysicalMaterial({ color: palette.mattress, roughness: 0.92, sheen: 0.45, sheenRoughness: 0.85, sheenColor: new THREE.Color('#ffffff') })
    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms)
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vHeatPos;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvHeatPos = (modelMatrix * vec4(position, 1.0)).xyz;')
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${heatPars}`)
        .replace('#include <color_fragment>', `#include <color_fragment>\n${heatFragment}`)
    }
    material.customProgramCacheKey = () => 'thermal-cover'
    material.userData.uniforms = uniforms
    return material
  }
  const model = createBedModel(THREE, SIDES, { palette, frame: false, mattressTop: heatMaterial })
  const flat = { pose: { head: 0, feet: 0 }, target: { head: 0, feet: 0 }, moving: false }
  model.update({ left: flat, right: flat }, 'mattress')
  scene.add(model.root)
  // Upholstered platform in place of the frame, as on the cover showroom renders.
  const platformGeometry = smoothNormals(roundedBoxGeometry(THREE, PLATFORM.width, PLATFORM.height, PLATFORM.depth, PLATFORM.radius, 16))
  const platformMaterial = new THREE.MeshPhysicalMaterial({ color: palette.platform, roughness: 0.95, sheen: 0.3, sheenRoughness: 0.9, sheenColor: new THREE.Color('#ffffff') })
  const platform = new THREE.Mesh(platformGeometry, platformMaterial)
  platform.position.set(0.1, PLATFORM.top - PLATFORM.height / 2, 0)
  scene.add(platform)
  const shadow = contactShadow(THREE, PLATFORM.width * 1.5, PLATFORM.depth * 1.5, palette.shadow)
  shadow.mesh.position.set(0.2, PLATFORM.top - PLATFORM.height - 0.001, 0)
  scene.add(shadow.mesh)

  let compact = false
  const labels = SIDES.flatMap(side => (view === 'regions' ? [...ZONES] : []).map((zone, index) => {
    const label = document.createElement('div')
    label.dataset.thermalRegion = `${side}-${zone.toLowerCase()}`
    const title = document.createElement('span')
    title.style.cssText = 'font-size:11px;letter-spacing:0.04em;text-transform:uppercase;opacity:0.72'
    title.textContent = `${side === 'left' ? 'L' : 'R'} ${zone.toLowerCase()}`
    const value = document.createElement('span')
    value.style.cssText = 'font-size:14px;font-variant-numeric:tabular-nums;font-weight:500'
    // The ring carries the zone's colour; in compact mode it and the position are the only cue.
    const ring = document.createElement('span')
    ring.style.cssText = 'width:10px;height:10px;border-radius:999px;flex:none;box-sizing:border-box;border:2.5px solid currentColor'
    label.title = title.textContent
    label.append(title, value, ring)
    host.append(label)
    const z = SIDE_Z[side] + (side === 'left' ? 1 : -1) * (1 - index) * (HALF_WIDTH - 0.1) / 3
    // Anchors step along the bed so six pills never stack on phones.
    const anchor = new THREE.Vector3(1.1 - index * 1.1 + (side === 'right' ? 0.55 : 0), SURFACE_Y + 0.02, z)
    return { side, index, label, title, value, ring, anchor, color: THERMAL_RAMP[theme()][2] as string }
  }))
  const restyleLabels = () => {
    for (const item of labels) {
      item.label.style.cssText = pillStyle(light, compact, item.color)
      item.title.style.display = compact ? 'none' : ''
      item.ring.style.color = item.color
    }
  }
  const camera = new THREE.PerspectiveCamera(CAMERA.fov, 1, 0.1, 40)
  const orbit = createOrbit(CAMERA.azimuth)
  orbit.state.elevation = CAMERA.elevation
  orbit.state.distance = CAMERA.distance
  const place = () => {
    const p = orbit.position(0)
    camera.position.set(p.x, p.y, p.z)
    camera.lookAt(0.1, 0.3, 0)
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
      const anchors = labels.map((item) => {
        const p = item.anchor.clone().project(camera)
        return { x: (p.x + 1) / 2 * host.clientWidth, y: (1 - p.y) / 2 * host.clientHeight, width: item.label.offsetWidth, height: item.label.offsetHeight }
      })
      const placed = layoutThermalLabels(anchors, host.clientWidth, host.clientHeight)
      labels.forEach(({ label }, i) => {
        label.style.left = `${placed[i].x}px`
        label.style.top = `${placed[i].y}px`
      })
      for (const side of SIDES) {
        uniformsBySide[side].time.value = reduced.matches ? 0 : now / 1000
        uniformsBySide[side].motion.value = reduced.matches ? 0 : 1
      }
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
    const next = width < COMPACT_WIDTH
    if (next !== compact) {
      compact = next
      restyleLabels()
    }
    renderer.setSize(width, height, false)
    camera.aspect = width / height
    // A longer lens on phones too: widen a little rather than pulling back.
    camera.fov = width / height < 1.2 ? CAMERA.fovNarrow : CAMERA.fov
    camera.updateProjectionMatrix()
    requestRender()
  }
  let latest: { states: Record<ThermalSide, ThermalState>, focus: ThermalSide | null, unit: TempUnit } | null = null
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
    for (const side of SIDES) uniformsBySide[side].cover.value.set(palette.mattress)
    if (latest) api.update(latest.states, latest.focus, latest.unit)
    else requestRender()
  }
  const themeObserver = new MutationObserver(applyTheme)
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] })
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
  const api = {
    update(states: Record<ThermalSide, ThermalState>, focus: ThermalSide | null, unit: TempUnit) {
      latest = { states, focus, unit }
      const ramp = THERMAL_RAMP[theme()]
      moving = SIDES.some(side => states[side].direction !== 0 && states[side].zones.some(value => value !== null))
      for (const side of SIDES) {
        const state = states[side]
        const uniforms = uniformsBySide[side]
        const readings = view === 'regions' ? state.zones : state.zones.map(() => meanTemperature(state.zones))
        readings.forEach((measured, index) => uniforms.zoneColors.value[index].set(thermalColor(measured, theme())))
        const any = readings.some(value => value !== null)
        // A side with no readings stays the cover's colour, even while it has an active target.
        uniforms.direction.value = any ? state.direction : 0
        uniforms.strength.value = any ? state.strength : 0
        uniforms.intent.value.set(state.direction > 0 ? ramp[4] : ramp[0])
        uniforms.selected.value = focus && focus !== side ? 0 : 1
      }
      for (const item of labels) {
        const measured = states[item.side].zones[item.index]
        item.color = thermalColor(measured, theme())
        item.label.style.opacity = focus && focus !== item.side ? '0.5' : '1'
        item.value.textContent = formatSensorC(measured, unit, { decimals: 1, includeUnit: false })
      }
      restyleLabels()
      requestRender()
    },
    dispose() {
      disposed = true
      cancelAnimationFrame(frame)
      observer.disconnect()
      intersection.disconnect()
      themeObserver.disconnect()
      detach()
      document.removeEventListener('visibilitychange', requestRender)
      reduced.removeEventListener('change', requestRender)
      canvas.removeEventListener('webglcontextlost', lost)
      model.dispose()
      platformGeometry.dispose()
      platformMaterial.dispose()
      shadow.dispose()
      environment.dispose()
      for (const { label } of labels) label.remove()
      renderer.dispose()
      renderer.forceContextLoss()
      canvas.remove()
    },
  }
  return api
}
