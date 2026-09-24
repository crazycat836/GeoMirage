import { type ChainPoint } from '../../WaypointChain'
import { haversineM, polylineDistanceM } from '../../../lib/geo'
import { formatCoordCardinal, formatDistanceM, formatDurationS } from '../../../lib/format'
import {
  estimateFlowerPlan,
  flowerPlanDistanceM,
  flowerPlanSeconds,
  type FlowerSettings,
} from '../../../lib/flower'
import { SimMode } from '../../../hooks/useSimulation'
import type { useT } from '../../../i18n'

const MIN_PTS_FOR_DIST = 2

type LatLng = { lat: number; lng: number }
type Translator = ReturnType<typeof useT>

export interface DockCtx {
  title: string
  subtitle: string
  chainPoints: ChainPoint[]
  loop: boolean
}

/** Inputs only the Flower summary needs. */
export interface FlowerDockInput {
  settings: FlowerSettings
  speedKmh: number
}

// Build the per-mode meta (title, subtitle, optional waypoint chain)
// rendered in the dock's `panel-meta` column. Pure derivation from
// the staged waypoints + positions; no side effects.
export function buildDockContext(
  mode: SimMode,
  waypoints: LatLng[],
  currentPos: LatLng | null,
  destPos: LatLng | null,
  t: Translator,
  flower?: FlowerDockInput,
): DockCtx {
  const wp = waypoints
  const toChain = (pts: LatLng[]): ChainPoint[] =>
    pts.map((p, i) => ({
      id: `wp-${i}`,
      label: i === 0 ? t('teleport.my_location') : t('panel.waypoint_num', { n: i + 1 }),
      position: p,
    }))

  switch (mode) {
    case SimMode.Teleport:
      return {
        title: destPos
          ? formatCoordCardinal(destPos)
          : t('teleport.add_destination'),
        subtitle: t('panel.teleport_hint'),
        chainPoints: [], loop: false,
      }
    case SimMode.Navigate: {
      if (!destPos) {
        return {
          title: t('teleport.add_destination'),
          subtitle: t('panel.navigate_hint'),
          chainPoints: [], loop: false,
        }
      }
      const distM = currentPos ? haversineM(currentPos, destPos) : 0
      const distLabel = formatDistanceM(distM)
      return {
        title: `${t('teleport.destination')} · ${distLabel}`,
        subtitle: t('panel.navigate_hint'),
        chainPoints: [], loop: false,
      }
    }
    case SimMode.Loop: {
      const count = wp.length
      const totalDist = count >= MIN_PTS_FOR_DIST
        ? polylineDistanceM(wp) + haversineM(wp[count - 1], wp[0])
        : 0
      return {
        title: count === 0
          ? t('panel.waypoints_none')
          : `${t('mode.loop')} · ${count} ${t('panel.pts_short')}${formatChainDist(totalDist)}`,
        subtitle: count === 0 ? t('panel.waypoints_empty') : t('pause.loop'),
        chainPoints: toChain(wp),
        loop: true,
      }
    }
    case SimMode.MultiStop: {
      const count = wp.length
      const totalDist = count >= MIN_PTS_FOR_DIST ? polylineDistanceM(wp) : 0
      return {
        title: count === 0
          ? t('panel.waypoints_none')
          : `${t('mode.multi_stop')} · ${count} ${t('panel.pts_short')}${formatChainDist(totalDist)}`,
        subtitle: count === 0 ? t('panel.waypoints_empty') : t('pause.multi_stop'),
        chainPoints: toChain(wp),
        loop: false,
      }
    }
    case SimMode.Flower: {
      const count = wp.length
      if (count === 0 || !flower) {
        return {
          title: count === 0 ? t('panel.waypoints_none') : t('mode.flower'),
          subtitle: count === 0 ? t('panel.waypoints_empty') : t('panel.flower_hint'),
          chainPoints: toChain(wp),
          loop: false,
        }
      }
      const plan = estimateFlowerPlan(wp, flower.settings, currentPos)
      const dist = flowerPlanDistanceM(plan)
      const secs = flowerPlanSeconds(plan, flower.speedKmh)
      const eta = secs == null ? t('dock.flower_forever') : formatDurationS(secs, t)
      return {
        title: `${t('mode.flower')} · ${count} ${t('panel.pts_short')}${dist == null ? '' : formatChainDist(dist)}`,
        subtitle: `${t('dock.est_time')} ${eta} · ${t('panel.flower_hint')}`,
        chainPoints: toChain(wp),
        loop: false,
      }
    }
    case SimMode.RandomWalk:
      return {
        title: t('mode.random_walk'),
        subtitle: t('pause.random_walk'),
        chainPoints: [], loop: false,
      }
    case SimMode.Joystick:
      return {
        title: t('mode.joystick'),
        subtitle: t('panel.joystick_hint'),
        chainPoints: [], loop: false,
      }
  }
}

function formatChainDist(distM: number): string {
  if (distM <= 0) return ''
  return ` · ${formatDistanceM(distM, 1)}`
}
