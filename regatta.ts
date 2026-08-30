// The rules of the race. Pure: no DOM, no clock, no randomness, no network.
// `step` is handed the elapsed milliseconds and returns the next state, which
// is what lets `spec/regatta.test.ts` assert a capsize costs exactly what it is
// supposed to cost without rendering a frame.

import type { River } from "./river.ts";
import {
  COURSE_LENGTH,
  centreAt,
  channelAt,
  flowAt,
  halfWidthAt,
} from "./river.ts";

/** Half the boat's beam, in world units. */
export const BOAT_RADIUS = 0.17;

/** How long you spend upside down. Long enough to hurt, short enough to forgive. */
export const CAPSIZE_MS = 1400;

/** Downstream speed in the fast channel with no paddling, units/second. */
const CURRENT = 3;

/** What a paddle stroke adds on top of the current. */
const PADDLE = 3.2;

/** The current still carries you while you are righting the boat. */
const CAPSIZE_DRIFT = 0.35;

const TURN = 2.6;

/**
 * You can nudge the tiller while coasting, but paddling is what really steers.
 * This is the whole reason one gesture can carry both jobs: stop paddling and
 * you visibly stop being able to aim.
 */
const COAST_TURN = 0.35;

/** How fast the boat noses back to the centreline while capsized. */
const RIGHTING_PULL = 0.9;

const LEAN_RATE = 5;

/** The pacer's time for the full course. A clean run beats it; two capsizes don't. */
export const PACER_MS = 52_000;

export type Steer = -1 | 0 | 1;
export type Input = { paddling: boolean; steer: Steer };

export const IDLE: Input = { paddling: false, steer: 0 };

export type Boat = {
  x: number;
  y: number;
  /** Render-only heel, -1..1. */
  lean: number;
  /** Milliseconds left of the capsize; 0 when upright. */
  capsizeMs: number;
  capsizes: number;
};

export type Race = {
  boat: Boat;
  /** Only runs once the player has actually done something. */
  elapsedMs: number;
  /**
   * Where the boat was when the clock started. Drifting further down the calm
   * opening before your first stroke shortens the pacer's deadline by the same
   * fraction, so hesitating is neither punished nor rewarded.
   */
  startY: number;
  started: boolean;
  finishedMs: number | null;
};

export function initialRace(): Race {
  return {
    boat: { x: centreAt(0), y: 0, lean: 0, capsizeMs: 0, capsizes: 0 },
    elapsedMs: 0,
    startY: 0,
    started: false,
    finishedMs: null,
  };
}

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}

/** Exported so the course-generation tests can hold the river to the same
 *  collision rule the race actually plays by. */
export function touchesRock(river: River, x: number, y: number): boolean {
  for (const rock of river.rocks) {
    const reach = rock.r + BOAT_RADIUS;
    if (Math.abs(rock.y - y) > reach) continue;
    const dx = rock.x - x;
    const dy = rock.y - y;
    if (dx * dx + dy * dy < reach * reach) return true;
  }
  return false;
}

/** Same shape as `touchesRock`, but against the nearest point on the log's
 *  span instead of a single centre -- a log is a rock stretched sideways. */
export function touchesLog(river: River, x: number, y: number): boolean {
  for (const log of river.logs) {
    const reach = log.r + BOAT_RADIUS;
    if (Math.abs(log.y - y) > reach) continue;
    const nearestX = clamp(x, log.x - log.half, log.x + log.half);
    const dx = nearestX - x;
    const dy = log.y - y;
    if (dx * dx + dy * dy < reach * reach) return true;
  }
  return false;
}

/**
 * Advance the race by `dtMs`. Input is ignored entirely while capsized -- that
 * lost control, not the lost seconds, is what makes a rock feel like a mistake
 * rather than a toll.
 */
export function step(
  river: River,
  race: Race,
  input: Input,
  dtMs: number,
): Race {
  if (race.finishedMs !== null) return race;

  const dt = dtMs / 1000;
  let { x, y, lean, capsizeMs, capsizes } = race.boat;

  const acting = input.paddling || input.steer !== 0;
  const started = race.started || acting;
  if (!started) {
    // The prologue: the boat drifts so the world reads as alive, but the clock
    // hasn't started and nothing can go wrong yet.
    y += CURRENT * flowAt(x, y) * CAPSIZE_DRIFT * dt;
    return { ...race, boat: { x, y, lean, capsizeMs, capsizes } };
  }

  const startY = race.started ? race.startY : y;
  const elapsedMs = race.elapsedMs + dtMs;
  const flow = flowAt(x, y);

  if (capsizeMs > 0) {
    capsizeMs = Math.max(0, capsizeMs - dtMs);
    y += CURRENT * flow * CAPSIZE_DRIFT * dt;
    const pull = RIGHTING_PULL * dt;
    x += clamp(centreAt(y) - x, -pull, pull);
    lean = Math.sin((CAPSIZE_MS - capsizeMs) / 90);
  } else {
    y += (CURRENT * flow + (input.paddling ? PADDLE : 0)) * dt;
    x += input.steer * TURN * (input.paddling ? 1 : COAST_TURN) * dt;

    const towards = input.steer - lean;
    lean += clamp(towards, -LEAN_RATE * dt, LEAN_RATE * dt);

    const centre = centreAt(y);
    const bank = halfWidthAt(y) - BOAT_RADIUS;
    if (Math.abs(x - centre) > bank) {
      x = centre + Math.sign(x - centre) * bank;
      capsizeMs = CAPSIZE_MS;
      capsizes += 1;
    } else if (touchesRock(river, x, y) || touchesLog(river, x, y)) {
      capsizeMs = CAPSIZE_MS;
      capsizes += 1;
    }
  }

  let finishedMs: number | null = null;
  if (y >= COURSE_LENGTH) {
    y = COURSE_LENGTH;
    finishedMs = elapsedMs;
  }

  return {
    boat: { x, y, lean, capsizeMs, capsizes },
    elapsedMs,
    startY,
    started: true,
    finishedMs,
  };
}

/** The pacer's deadline, scaled to the distance it actually has to cover. */
export function pacerTargetMs(startY: number): number {
  return (PACER_MS * (COURSE_LENGTH - startY)) / COURSE_LENGTH;
}

/**
 * The ghost boat. Monotonic, beatable, and -- because it rides the channel --
 * a silent demonstration of where the fast water is.
 */
export function pacerPose(
  elapsedMs: number,
  startY: number,
): { x: number; y: number } {
  const target = pacerTargetMs(startY);
  const p = clamp(target > 0 ? elapsedMs / target : 1, 0, 1);
  const wobble = (0.03 * Math.sin(p * Math.PI * 4)) / (Math.PI * 4);
  const eased = clamp(p + wobble, 0, 1);
  const y = startY + (COURSE_LENGTH - startY) * eased;
  return { x: channelLine(y), y };
}

/** The absolute x a boat sitting perfectly in the fast water would hold. */
export function channelLine(y: number): number {
  return centreAt(y) + channelAt(y) * halfWidthAt(y);
}

export type Outcome = "won" | "lost" | "tied";

/**
 * Both peers run this over the same two numbers, so they always agree on who
 * arrived first without anyone being in charge.
 */
export function outcome(selfMs: number, rivalMs: number): Outcome {
  if (Math.abs(selfMs - rivalMs) < 1) return "tied";
  return selfMs < rivalMs ? "won" : "lost";
}
