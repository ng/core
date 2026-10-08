'use client'

import { usePreference } from '@/src/components/Base/controls'
import type { ZoneMode } from './stageScene'

export const ZONE_MODES: readonly ZoneMode[] = ['hover', 'always', 'off']
export const ZONE_MODE_LABELS: Record<ZoneMode, string> = { hover: 'On hover', always: 'Always', off: 'Off' }

export type TempView = 'cards' | 'stage'
export const TEMP_VIEWS: readonly TempView[] = ['cards', 'stage']

/** The Temperature page's view: the full-screen stage until someone switches to the cards. */
export const useTempView = () => usePreference<TempView>('temp.view', 'stage', TEMP_VIEWS)
/** When the six zone readings glow through the cover. */
export const useStageZones = () => usePreference<ZoneMode>('stageZones', 'hover', ZONE_MODES)
/** Drift the camera home after eight idle seconds with nothing selected. */
export const useStageAutoReturn = () => usePreference('stageAutoReturn', 'true', ['true', 'false'])
