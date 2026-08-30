// Animates the paddle pivot built by assets.ts's buildKayak. Phase is driven
// by boat speed rather than the wall clock, so cadence tracks motion and
// freezes when the boat stops.

import type * as THREE from "three";

const TAU = Math.PI * 2;

/** Full left-and-right cycles per second at speed. */
const CADENCE = 1.15;

/** How far the shaft tips off horizontal. Enough that the low blade's tip
 *  passes below y=0 -- the blade visibly enters the water rather than waving
 *  at it. */
const ROLL = 0.74;

/** Fore-and-aft swing. Combined with ROLL this walks each blade around an
 *  ellipse, which is what a paddle stroke actually traces. */
const SWEEP = 0.4;

/** What is left of a stroke on the side that is not being favoured. Not zero:
 *  a kayaker steering right still lifts the left blade over the boat. */
const OFF_SIDE = 0.15;

/** How hard the shaft is planted out to the steering side, in radians. */
const PLANT = 0.13;

const EASE_BACK = 0.11;

export type PaddleState = {
  phase: number;
  /** The favoured side, eased. Following `side` directly would snap the shaft
   *  across the boat the instant a key went down. */
  side: number;
};

export function newPaddleState(): PaddleState {
  return { phase: 0, side: 0 };
}

/**
 * The paddle's shaft runs along local X with a blade at each end (see
 * assets.ts). Rolling the pivot around Z dips one blade and lifts the other;
 * swinging it around Y carries the dipped blade aft. Together they alternate
 * left and right, which is what paddling forward looks like.
 *
 * `side` biases that cycle rather than replacing it. The previous version
 * pinned the shaft to `strokeSide` while steering, which froze the paddle in
 * one position for as long as the key was held -- the boat surged forward with
 * a motionless paddle stuck out sideways. Here the alternation never stops;
 * steering just deepens the stroke on the favoured side and shallows the other
 * one, so "paddle harder on the left" reads as exactly that.
 *
 * The favouring weight is a smooth function of the roll (not a branch on which
 * half of the cycle we are in) specifically so nothing jumps at the crossover:
 * a hard branch is continuous in the roll, which passes through zero there,
 * but not in the sweep, which is at its extreme.
 */
export function stepPaddle(
  pivot: THREE.Group,
  state: PaddleState,
  strokeSide: -1 | 0 | 1,
  active: boolean,
  dtSeconds: number,
): void {
  state.side += (strokeSide - state.side) * Math.min(1, dtSeconds * 9);

  if (!active) {
    // Rest the blades level rather than wherever the last frame left them.
    pivot.rotation.z += (0 - pivot.rotation.z) * EASE_BACK;
    pivot.rotation.y += (0 - pivot.rotation.y) * EASE_BACK;
    return;
  }

  state.phase = (state.phase + CADENCE * dtSeconds) % 1;
  const angle = state.phase * TAU;
  const roll = Math.sin(angle);
  const sweep = Math.cos(angle);

  // Full stroke unless this half of the cycle opposes the favoured side, and
  // full stroke on both halves when no side is favoured at all. Written as a
  // clamp of roll*side rather than as two cases so that it is continuous in
  // both of them: at side = 0 it collapses to a constant 1, and at the roll
  // crossover it is 1 from either direction.
  const suppress = Math.min(1, Math.max(0, -roll * state.side));
  const weight = 1 - (1 - OFF_SIDE) * suppress;

  pivot.rotation.z = roll * ROLL * weight + state.side * PLANT;
  pivot.rotation.y = sweep * SWEEP * weight;
}
