// The river, generated from a seed and nothing else.
//
// Every function here is pure and total: same seed in, same course out, on any
// machine. That property is what lets two peers race the same water without
// sending a single byte of terrain to each other -- they both derive it from
// the six characters of the room code. It is also what makes the course
// testable, since a test can assert the whole 300 units of it without a
// browser, a clock, or a canvas.
//
// World units: 1 unit is roughly the river's baseline half-width. `y` runs
// downstream from 0 to COURSE_LENGTH; `x` is absolute lateral position, which
// is why the boat drifts toward the outer bank of a bend for free -- hold `x`
// still while the centreline moves and you are pushed relatively outward,
// exactly as a real boat is.

const TAU = Math.PI * 2;

/** Distance from the start to the bend where the lanterns go up. */
export const COURSE_LENGTH = 300;

/**
 * The opening is deliberately wide, straight and empty: a player who has been
 * told nothing needs somewhere to discover the paddle before the river asks
 * anything of them. The first rock lands about eight seconds in, right as the
 * first real bend arrives.
 */
export const OPENING_CALM = 46;

/** Calm water again at the finish, so the last thing you do isn't dodge. */
const RUN_OUT = 14;

export const ROCK_RADIUS = 0.17;

/** Half-width of the gap left between the two rocks of a gate, relative. */
const GATE_HALF = 0.32;

const MIN_GAP = 11;
const MAX_GAP = 20;

/** Slowest water, as a fraction of the fast channel's speed. */
const FLOW_MIN = 0.5;

/** How far off the channel you have to stray to be fully in the slack, relative. */
const FLOW_SPREAD = 1.15;

export type Rock = { x: number; y: number; r: number };
export type River = { seed: number; rocks: Rock[] };

/** Small, fast, well-distributed PRNG. Deterministic across engines. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a over the room code, so a shared link is a shared river. */
export function seedFromCode(code: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < code.length; i += 1) {
    hash ^= code.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}

/** 0 at the top of the calm stretch, 1 once the river has woken up. */
function ramp(y: number): number {
  const t = clamp(y / (OPENING_CALM * 0.85), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Lateral position of the river's centreline at `y`. */
export function centreAt(y: number): number {
  const wake = ramp(y);
  return (
    wake * (2.6 * Math.sin((TAU * y) / 96) + 1.1 * Math.sin((TAU * y) / 37 + 1.7))
  );
}

/** Half-width of the channel at `y`. Widest at the start, then it breathes. */
export function halfWidthAt(y: number): number {
  const wake = ramp(y);
  return 1 + wake * 0.22 * Math.sin((TAU * y) / 61 + 0.9) + (1 - wake) * 0.3;
}

/**
 * Where the fast water runs, as a fraction of the half-width either side of the
 * centreline. Real rivers push their thalweg to the outside of a bend, so this
 * is just the centreline's own slope: bending right means the quick water is on
 * the right. Nobody is ever told this -- the pacer boat rides it, and the
 * ripples move visibly faster there.
 */
export function channelAt(y: number): number {
  const h = 0.5;
  const slope = (centreAt(y + h) - centreAt(y - h)) / (2 * h);
  return clamp(slope * 2.4, -0.65, 0.65);
}

/** Downstream speed at a point, as a fraction of the channel's speed. */
export function flowAt(x: number, y: number): number {
  const rel = (x - centreAt(y)) / halfWidthAt(y);
  const off = Math.min(1, Math.abs(rel - channelAt(y)) / FLOW_SPREAD);
  return FLOW_MIN + (1 - FLOW_MIN) * (1 - off * off);
}

/**
 * Rocks are laid down in stations, each either a single rock you go around or a
 * pair with a lane between them. Both shapes are built outward from a clear
 * gap, so a passable line always exists by construction rather than by luck --
 * `spec/river.test.ts` walks the whole course and holds this to it.
 */
export function buildRiver(seed: number): River {
  const rand = mulberry32(seed);
  const rocks: Rock[] = [];
  const end = COURSE_LENGTH - RUN_OUT;

  let y = OPENING_CALM;
  while (y < end) {
    const centre = centreAt(y);
    const hw = halfWidthAt(y);
    const relRadius = ROCK_RADIUS / hw;
    const limit = 1 - relRadius - 0.02;

    if (rand() < 0.45) {
      const gate = (rand() * 2 - 1) * 0.42;
      for (const side of [-1, 1]) {
        const rel = gate + side * (GATE_HALF + relRadius);
        if (Math.abs(rel) <= limit) {
          rocks.push({ x: centre + rel * hw, y, r: ROCK_RADIUS });
        }
      }
    } else {
      const rel = (rand() * 2 - 1) * 0.55;
      rocks.push({ x: centre + rel * hw, y, r: ROCK_RADIUS });
    }

    y += MIN_GAP + rand() * (MAX_GAP - MIN_GAP);
  }

  return { seed, rocks };
}

/** The rocks whose `y` falls in `[from, to]`. The course is short; a scan is plenty. */
export function rocksNear(river: River, from: number, to: number): Rock[] {
  return river.rocks.filter((rock) => rock.y >= from && rock.y <= to);
}
