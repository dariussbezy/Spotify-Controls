import { lookupModule } from '@valenced/modules/finders'
import { withProps } from '@valenced/modules/finders/filters'
import type { ComponentType, ReactNode } from 'react'

export interface PanEvent {
	x: number
	translationX: number
	translationY: number
	velocityX: number
	velocityY: number
}
export interface PanGesture {
	runOnJS(value: boolean): PanGesture
	minDistance(value: number): PanGesture
	activeOffsetX(value: [number, number]): PanGesture
	activeOffsetY(value: [number, number]): PanGesture
	failOffsetY(value: [number, number]): PanGesture
	onBegin(callback: (event: PanEvent) => void): PanGesture
	onStart(callback: (event: PanEvent) => void): PanGesture
	onUpdate(callback: (event: PanEvent) => void): PanGesture
	onEnd(callback: (event: PanEvent) => void): PanGesture
	onFinalize(callback: (event: PanEvent, success: boolean) => void): PanGesture
}
export interface GestureHandler {
	Gesture: { Pan(): PanGesture }
	GestureDetector: ComponentType<{ gesture: PanGesture; children: ReactNode }>
}

/** Set while the progress bar is being scrubbed, so the dock does not treat the same touch as a swipe. */
export const scrub = { active: false }

/** react-native-gesture-handler as Discord ships it, or null when it cannot be found. */
export function gestureHandler(): GestureHandler | null {
	try {
		const found = lookupModule(withProps('GestureDetector', 'Gesture'))[0] as
			| Partial<GestureHandler>
			| undefined
		return typeof found?.Gesture?.Pan === 'function' && found.GestureDetector
			? (found as GestureHandler)
			: null
	} catch {
		return null
	}
}
