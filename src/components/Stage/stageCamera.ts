// Camera for the stage: an orbit around the bed's centre with a few named goals
// that the live parameters ease toward every frame. Pure maths; the scene applies it.

import type { StageSide } from './stageColors'

export interface CameraParams {
  /** Azimuth around +y, radians. 0 looks along −x from the +x end. */
  phi: number
  /** Horizontal distance from the look target. */
  r: number
  /** Camera height. */
  h: number
  /** Look target on the floor plane. */
  ox: number
  oz: number
  /** Look target slides this far along the camera's right so the bed sits left of the panel. */
  lateral: number
}

export const CAMERA = {
  fov: 28,
  lookY: 0.25,
  ease: 0.07,
  /** Lateral drag on empty floor. */
  orbitRate: 0.008,
  /** Arrow keys. */
  orbitStep: 0.25,
  minR: 5,
  maxR: 13,
  /** Ms without input before an unselected view drifts home. */
  autoReturnMs: 8000,
  /** Header and timeline heights the bed must centre between. */
  bandTop: 150,
  bandBottom: 230,
  /** Side panel width; a selected side shifts the bed left by half of it. */
  panelWidth: 320,
} as const

export const DEFAULT_CAMERA: CameraParams = { phi: 0.62, r: 9.5, h: 3.9, ox: 0, oz: 0, lateral: 0 }

/** Where the camera wants to be for a selection; drag and zoom adjust from here. */
export function cameraGoal(selected: StageSide | null, linked: boolean): CameraParams {
  if (!selected) return { ...DEFAULT_CAMERA }
  if (linked) return { phi: 0.62, r: 8, h: 3.3, ox: 0, oz: 0, lateral: 1.05 }
  return selected === 'left'
    ? { phi: 0.35, r: 6.8, h: 2.8, ox: 0, oz: 0.35, lateral: 1.05 }
    : { phi: 2.75, r: 6.8, h: 2.8, ox: 0, oz: -0.35, lateral: 1.05 }
}

const KEYS: (keyof CameraParams)[] = ['phi', 'r', 'h', 'ox', 'oz', 'lateral']
const EPSILON = 0.0005

/**
 * Move `current` 7% of the way to `goal` (or all the way with reduced motion).
 * Returns true while there is still distance to cover.
 */
export function easeCamera(current: CameraParams, goal: CameraParams, snap = false, rate = CAMERA.ease): boolean {
  let moving = false
  for (const key of KEYS) {
    const delta = goal[key] - current[key]
    if (Math.abs(delta) < EPSILON) {
      current[key] = goal[key]
      continue
    }
    current[key] = snap ? goal[key] : current[key] + delta * rate
    if (!snap) moving = true
  }
  return moving
}

export interface CameraPose {
  position: [number, number, number]
  target: [number, number, number]
}

/** Camera position and look target for the parameters, with the lateral slide applied. */
export function cameraPose(p: CameraParams, scale = 1): CameraPose {
  // Right-hand vector of a camera at azimuth phi looking at the target.
  const rightX = Math.sin(p.phi)
  const rightZ = -Math.cos(p.phi)
  const tx = p.ox + rightX * p.lateral
  const tz = p.oz + rightZ * p.lateral
  const r = p.r * scale
  return {
    position: [tx + r * Math.cos(p.phi), p.h * scale, tz + r * Math.sin(p.phi)],
    target: [tx, CAMERA.lookY, tz],
  }
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

/**
 * Pull back when the band between header and timeline is short relative to the
 * viewport, and on narrow (tall) viewports, so the whole bed stays inside the band.
 */
export function viewScale(width: number, height: number): number {
  if (!width || !height) return 1
  const band = Math.max(1, height - CAMERA.bandTop - CAMERA.bandBottom)
  const aspect = width / height
  return clamp(height / band, 1, 1.45) * clamp(1.6 / aspect, 1, 1.3)
}

export interface ViewOffset { x: number, y: number }

/**
 * Pixel offset for PerspectiveCamera.setViewOffset: positive y moves the image up so
 * the bed centres in the band; positive x moves it left when the panel is open.
 */
export function viewOffset(height: number, panelOpen: boolean): ViewOffset {
  const bandCentre = CAMERA.bandTop + (height - CAMERA.bandTop - CAMERA.bandBottom) / 2
  return { x: panelOpen ? CAMERA.panelWidth / 2 : 0, y: Math.round(height / 2 - bandCentre) }
}

export const clampDistance = (r: number) => clamp(r, CAMERA.minR, CAMERA.maxR)

/**
 * Projected rows that land too close read as one smudge. Keep their order, and push
 * later rows down until each sits at least `gap` below the one before. Returns a new
 * array in the input order.
 */
export function spreadRows(rows: number[], gap: number): number[] {
  const order = rows.map((y, i) => i).sort((a, b) => rows[a] - rows[b])
  const out = [...rows]
  for (let k = 1; k < order.length; k++) {
    const prev = out[order[k - 1]]
    const i = order[k]
    if (out[i] < prev + gap) out[i] = prev + gap
  }
  return out
}
