// Painting the river. The only module that touches a canvas.
//
// The depth read is a fake perspective, not 3D: distance ahead of the boat is
// compressed toward a horizon and everything scales by the same factor, so the
// meander recedes instead of reading as a wiggly 2D strip. That buys the whole
// 2.5D effect for a few lines of arithmetic, which is a better trade at this
// scope than a scene graph -- see CLAUDE.md's long list of what the 3D path
// costs.
//
// Deliberately stateless: every mark on screen is a pure function of the race
// state and the wall clock, so a frame can be reproduced exactly by replaying
// the same two numbers.

import type { Race } from "./regatta.ts";
import { BOAT_RADIUS, CAPSIZE_MS } from "./regatta.ts";
import type { River } from "./river.ts";
import { COURSE_LENGTH, centreAt, flowAt, halfWidthAt } from "./river.ts";

/** How far downstream the player can see, in world units. */
const VIEW_DEPTH = 34;

/**
 * How far upstream of the boat the world keeps being painted. Without it the
 * river stops in a hard horizontal line at the boat's own waterline and the
 * boat reads as sitting on the lip of a waterfall. Must stay well under FOCAL:
 * the projection's scale factor blows up at a depth of exactly -FOCAL.
 */
const BEHIND = 4.5;

/** Perspective strength: distance at which everything is half size. */
const FOCAL = 10;

/** Where the boat sits on screen, as a fraction of height. */
const BOAT_SCREEN_Y = 0.79;
const HORIZON_Y = 0.3;

/**
 * World units to pixels, derived from viewport HEIGHT alone. A 1920x1080 screen
 * therefore shows more meadow either side rather than more river ahead: the
 * look-ahead distance, and so the difficulty, is identical at both marking
 * viewports.
 */
const SCALE_OF_HEIGHT = 0.14;

const SKY_TOP = "#171833";
const SKY_MID = "#4b3663";
const SKY_LOW = "#c9764a";
const HILLS_FAR = "#332f52";
const HILLS_NEAR = "#262845";
const TREELINE = "#1b1e33";
const MEADOW_FAR = "#2e3444";
const MEADOW = "#232a2f";
const MEADOW_NEAR = "#161b1f";
const GRASS = "58, 74, 47";

/** How far the grass bank sticks out past the water, in world units. */
const BANK_SPREAD = 0.52;
const BANK = "#2c3527";
const WATER_FAR = "#3d4a6b";
const WATER_NEAR = "#16203a";
const PAPER = "#f6ecd8";
const PAPER_FOLD = "#d3bf9c";
const RIVAL_PAPER = "#cfe6f2";
const RIVAL_FOLD = "#9dbccf";
const ROCK_DARK = "#22232b";
const ROCK_LIT = "#4d4e5c";
const EMBER = "#ffb765";

export type Rival = { x: number; y: number; lean: number; ghost: boolean };

export type Ending = {
  outcome: "won" | "lost" | "tied";
  /** Milliseconds since the finish, for the lantern rise. */
  ageMs: number;
};

export type Scene = {
  river: River;
  race: Race;
  rival: Rival | null;
  /** Smoothed camera, so the frame doesn't twitch with every stroke. */
  cameraX: number;
  /** Wall clock, for water and sky motion that runs whether or not the race does. */
  timeMs: number;
  /** 0..1 strength of the paddle hint. Falls to 0 for good on first input. */
  hint: number;
  /** -1, 0 or 1: which side the paddle just went in, for the splash. */
  stroke: number;
  ending: Ending | null;
};

type View = {
  w: number;
  h: number;
  scale: number;
  baseY: number;
  horizon: number;
  boatY: number;
  cameraX: number;
};

/** Screen position and depth factor of a world point. */
function project(
  view: View,
  x: number,
  y: number,
): { sx: number; sy: number; k: number } {
  const d = Math.max(-BEHIND, y - view.boatY);
  const k = FOCAL / (FOCAL + d);
  return {
    sx: view.w / 2 + (x - view.cameraX) * view.scale * k,
    sy: view.horizon + (view.baseY - view.horizon) * k,
    k,
  };
}

/** Deterministic scatter from an integer, so scenery never jitters between frames. */
function noise(n: number): number {
  let t = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  t ^= t >>> 13;
  t = Math.imul(t, 0xc2b2ae35);
  return ((t ^ (t >>> 16)) >>> 0) / 4294967296;
}

function sky(ctx: CanvasRenderingContext2D, view: View): void {
  const grad = ctx.createLinearGradient(0, 0, 0, view.horizon + 40);
  grad.addColorStop(0, SKY_TOP);
  grad.addColorStop(0.55, SKY_MID);
  grad.addColorStop(1, SKY_LOW);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, view.w, view.horizon + 40);
}

/**
 * Lanterns other boats already sent up, drifting in the high sky. The ending is
 * visible from the first frame, which is the only way a wordless game can tell
 * you what you are racing toward.
 */
function skyLanterns(ctx: CanvasRenderingContext2D, view: View, timeMs: number): void {
  const t = timeMs * 0.001;
  ctx.save();
  for (let i = 0; i < 14; i += 1) {
    const drift = (noise(i) + t * 0.006 * (0.5 + noise(i + 300))) % 1.2;
    const x = ((noise(i * 7 + 1) + drift * 0.15) % 1) * view.w;
    const y = view.horizon * (0.08 + noise(i * 3 + 5) * 0.78) - drift * 6;
    const r = 1.4 + noise(i * 11) * 1.6;
    const pulse = 0.55 + 0.45 * Math.sin(t * 0.9 + i);
    const glow = ctx.createRadialGradient(x, y, 0, x, y, r * 6);
    glow.addColorStop(0, `rgba(255, 183, 101, ${0.5 * pulse})`);
    glow.addColorStop(1, "rgba(255, 183, 101, 0)");
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(x, y, r * 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = EMBER;
    ctx.globalAlpha = 0.85 * pulse;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }
  ctx.restore();
}

/** One rolling silhouette ridge. Parallax comes from `sway`, not from the world. */
function ridge(
  ctx: CanvasRenderingContext2D,
  view: View,
  colour: string,
  height: number,
  wavelength: number,
  sway: number,
  seed: number,
): void {
  ctx.fillStyle = colour;
  ctx.beginPath();
  ctx.moveTo(0, view.horizon + 2);
  for (let sx = 0; sx <= view.w; sx += 8) {
    const u = (sx + sway) / wavelength;
    const y =
      view.horizon -
      height *
        (0.55 +
          0.45 * Math.sin(u + seed) * Math.cos(u * 0.37 + seed * 1.7));
    ctx.lineTo(sx, y);
  }
  ctx.lineTo(view.w, view.horizon + 2);
  ctx.closePath();
  ctx.fill();
}

function land(ctx: CanvasRenderingContext2D, view: View): void {
  // The banks slide sideways with the camera; the hills barely move. That
  // difference is the whole parallax budget and it is enough.
  const sway = -view.cameraX * view.scale;
  ridge(ctx, view, HILLS_FAR, view.h * 0.075, 420, sway * 0.06, 0.4);
  ridge(ctx, view, HILLS_NEAR, view.h * 0.055, 260, sway * 0.13, 2.1);
  ridge(ctx, view, TREELINE, view.h * 0.032, 90, sway * 0.28, 5.3);

  meadow(ctx, view);
}

/**
 * The ground the river runs through. A flat fill reads as a void with a river
 * floating in it, so the depth has to come from somewhere: a vertical gradient
 * for the recession, and grass scattered on a *world* grid rather than a screen
 * one, so it streams past the boat and parallaxes with the camera instead of
 * sliding around with the viewport.
 */
function meadow(ctx: CanvasRenderingContext2D, view: View): void {
  const grad = ctx.createLinearGradient(0, view.horizon, 0, view.h);
  // Start on the treeline's own colour, or its flat base rules a hard line
  // across the full width at exactly the horizon.
  grad.addColorStop(0, TREELINE);
  grad.addColorStop(0.07, MEADOW_FAR);
  grad.addColorStop(0.34, MEADOW);
  grad.addColorStop(1, MEADOW_NEAR);
  ctx.fillStyle = grad;
  ctx.fillRect(0, view.horizon, view.w, view.h - view.horizon);

  const SPACING = 1.15;
  const first = Math.floor((view.boatY - BEHIND) / SPACING);
  const last = Math.ceil((view.boatY + VIEW_DEPTH) / SPACING);

  ctx.save();
  ctx.lineCap = "round";
  for (let row = first; row <= last; row += 1) {
    const y = row * SPACING;
    const p = project(view, view.cameraX, y);
    if (p.sy < view.horizon || p.sy > view.h + 40) continue;
    // World units the screen spans at this depth. A wide viewport widens this
    // and nothing else, which is exactly the fairness property we want.
    const span = view.w / (view.scale * p.k);
    const centre = centreAt(y);
    const hw = halfWidthAt(y);
    for (let j = 0; j < 9; j += 1) {
      const x = view.cameraX + (noise(row * 149 + j * 733) - 0.5) * span;
      // Anything in the channel is about to be painted over by the water.
      if (Math.abs(x - centre) < hw + 0.25) continue;
      const q = project(view, x, y);
      const shade = noise(row * 31 + j * 17);
      const height = (7 + shade * 14) * q.k;
      if (height < 1) continue;
      const lean = (shade - 0.5) * height * 0.8;
      ctx.strokeStyle = `rgba(${GRASS}, ${0.14 + 0.32 * Math.min(1, q.k)})`;
      ctx.lineWidth = Math.max(0.5, 1.5 * q.k);
      ctx.beginPath();
      ctx.moveTo(q.sx, q.sy);
      ctx.quadraticCurveTo(
        q.sx + lean * 0.3,
        q.sy - height * 0.6,
        q.sx + lean,
        q.sy - height,
      );
      ctx.stroke();
    }
  }
  ctx.restore();
}

/** The list of cross-sections the water and its banks are both built from. */
function sections(view: View): {
  y: number;
  left: number;
  right: number;
  k: number;
  sy: number;
}[] {
  const out = [];
  const steps = 52;
  const kFar = FOCAL / (FOCAL + VIEW_DEPTH);
  const kNear = FOCAL / (FOCAL - BEHIND);
  for (let i = 0; i <= steps; i += 1) {
    // Step in even slices of *screen* depth, not world depth: stepping the
    // world evenly facets the far end of the ribbon while spending most of the
    // samples on the near end, where they buy nothing. Far end first, so the
    // ribbon path runs far -> near down one bank and back up the other.
    const k = kFar + (kNear - kFar) * (i / steps);
    const y = view.boatY + FOCAL / k - FOCAL;
    const centre = centreAt(y);
    const hw = halfWidthAt(y);
    const l = project(view, centre - hw, y);
    const r = project(view, centre + hw, y);
    out.push({ y, left: l.sx, right: r.sx, k: l.k, sy: l.sy });
  }
  return out;
}

function ribbon(
  ctx: CanvasRenderingContext2D,
  cuts: ReturnType<typeof sections>,
  spread: number,
): void {
  ctx.beginPath();
  for (let i = 0; i < cuts.length; i += 1) {
    const c = cuts[i];
    const x = c.left - spread * c.k;
    if (i === 0) ctx.moveTo(x, c.sy);
    else ctx.lineTo(x, c.sy);
  }
  for (let i = cuts.length - 1; i >= 0; i -= 1) {
    const c = cuts[i];
    ctx.lineTo(c.right + spread * c.k, c.sy);
  }
  ctx.closePath();
}

function water(
  ctx: CanvasRenderingContext2D,
  view: View,
  cuts: ReturnType<typeof sections>,
): void {
  ribbon(ctx, cuts, BANK_SPREAD * view.scale);
  ctx.fillStyle = BANK;
  ctx.fill();

  ribbon(ctx, cuts, 0);
  const grad = ctx.createLinearGradient(0, view.horizon, 0, view.h);
  grad.addColorStop(0, WATER_FAR);
  grad.addColorStop(0.45, "#2a3654");
  grad.addColorStop(1, WATER_NEAR);
  ctx.fillStyle = grad;
  ctx.fill();

  // A band of reflected sunset just under the horizon, clipped to the water.
  ctx.save();
  ribbon(ctx, cuts, 0);
  ctx.clip();
  const sun = ctx.createLinearGradient(0, view.horizon, 0, view.horizon + view.h * 0.22);
  sun.addColorStop(0, "rgba(201, 118, 74, 0.55)");
  sun.addColorStop(1, "rgba(201, 118, 74, 0)");
  ctx.fillStyle = sun;
  ctx.fillRect(0, view.horizon, view.w, view.h * 0.22);
  ctx.restore();
}

/**
 * Distance haze. The ribbon can only be drawn so far before the projection
 * squashes it to nothing, and it stops short of the horizon with a hard
 * horizontal edge; fading the last stretch into the field turns that artefact
 * into the river simply going out of sight.
 *
 * Clipped to the banks, not painted across the frame: unclipped it lightens the
 * whole upper meadow into a flat grey fog band, which is a worse artefact than
 * the one it set out to hide.
 */
function haze(
  ctx: CanvasRenderingContext2D,
  view: View,
  cuts: ReturnType<typeof sections>,
): void {
  const far =
    view.horizon + (view.baseY - view.horizon) * (FOCAL / (FOCAL + VIEW_DEPTH));
  const fade = far + (far - view.horizon) * 1.6;
  ctx.save();
  ribbon(ctx, cuts, BANK_SPREAD * view.scale);
  ctx.clip();
  const grad = ctx.createLinearGradient(0, view.horizon, 0, fade);
  grad.addColorStop(0, MEADOW_FAR);
  grad.addColorStop(0.45, "rgba(52, 58, 76, 0.62)");
  grad.addColorStop(1, "rgba(52, 58, 76, 0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, view.horizon, view.w, fade - view.horizon);
  ctx.restore();
}

/**
 * Foam streaks, longer and brighter where the water runs fast. Nothing tells
 * the player the channel exists; this is how they find it.
 */
function ripples(
  ctx: CanvasRenderingContext2D,
  view: View,
  cuts: ReturnType<typeof sections>,
  timeMs: number,
): void {
  const SPACING = 1.6;
  const drift = ((timeMs * 0.0022) % SPACING) + SPACING;
  const first = Math.floor((view.boatY - BEHIND - SPACING) / SPACING);
  const last = Math.ceil((view.boatY + VIEW_DEPTH) / SPACING);

  ctx.save();
  ribbon(ctx, cuts, 0);
  ctx.clip();
  ctx.lineCap = "round";

  for (let row = first; row <= last; row += 1) {
    const y = row * SPACING + drift;
    if (y < view.boatY - BEHIND || y > view.boatY + VIEW_DEPTH) continue;
    const centre = centreAt(y);
    const hw = halfWidthAt(y);
    for (let j = 0; j < 3; j += 1) {
      const rel = noise(row * 31 + j * 977) * 1.8 - 0.9;
      const x = centre + rel * hw;
      const speed = flowAt(x, y);
      const lift = (speed - 0.5) * 2;
      const head = project(view, x, y);
      const tail = project(view, x, y - 0.35 - lift * 0.9);
      ctx.strokeStyle = `rgba(214, 231, 246, ${(0.05 + 0.22 * lift * lift) * head.k})`;
      ctx.lineWidth = Math.max(0.6, 2.4 * head.k);
      ctx.beginPath();
      ctx.moveTo(head.sx, head.sy);
      ctx.lineTo(tail.sx, tail.sy);
      ctx.stroke();
    }
  }
  ctx.restore();
}

function reeds(ctx: CanvasRenderingContext2D, view: View): void {
  // World rows, not offsets from the boat: reeds pinned to the boat's own depth
  // never approach it, which quietly cancels the depth cue they exist to give.
  const SPACING = 0.85;
  const first = Math.floor((view.boatY - BEHIND) / SPACING);
  const last = Math.ceil((view.boatY + VIEW_DEPTH) / SPACING);
  ctx.strokeStyle = "#1a2418";
  for (let row = first; row <= last; row += 1) {
    if (noise(row * 61) > 0.62) continue;
    const y = row * SPACING;
    const side = noise(row * 97) > 0.5 ? 1 : -1;
    const centre = centreAt(y);
    const hw = halfWidthAt(y);
    const base = project(view, centre + side * (hw + 0.05 + noise(row * 7) * 0.45), y);
    if (base.sy > view.h + 60 || base.k < 0.12) continue;
    const height = (16 + noise(row * 5) * 26) * base.k;
    ctx.lineWidth = Math.max(0.5, 1.8 * base.k);
    ctx.beginPath();
    ctx.moveTo(base.sx, base.sy);
    ctx.quadraticCurveTo(
      base.sx + side * height * 0.25,
      base.sy - height * 0.6,
      base.sx + side * height * 0.5,
      base.sy - height,
    );
    ctx.stroke();
  }
}

function rocks(ctx: CanvasRenderingContext2D, view: View, river: River): void {
  for (const rock of river.rocks) {
    if (rock.y < view.boatY - BEHIND || rock.y > view.boatY + VIEW_DEPTH) continue;
    const p = project(view, rock.x, rock.y);
    const rx = rock.r * view.scale * p.k;
    const ry = rx * 0.62;
    if (rx < 0.7) continue;

    // The waterline ring reads at a distance long before the rock itself does.
    ctx.strokeStyle = `rgba(214, 231, 246, ${0.28 * p.k})`;
    ctx.lineWidth = Math.max(0.6, 1.6 * p.k);
    ctx.beginPath();
    ctx.ellipse(p.sx, p.sy, rx * 1.9, ry * 1.5, 0, 0, Math.PI * 2);
    ctx.stroke();

    ctx.fillStyle = ROCK_DARK;
    ctx.beginPath();
    ctx.ellipse(p.sx, p.sy - ry * 0.5, rx, ry * 1.5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = ROCK_LIT;
    ctx.beginPath();
    ctx.ellipse(p.sx - rx * 0.22, p.sy - ry * 1.1, rx * 0.55, ry * 0.5, 0, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** A folded-paper boat seen from behind, drawn at the origin facing up-screen. */
function paperBoat(
  ctx: CanvasRenderingContext2D,
  size: number,
  hull: string,
  fold: string,
): void {
  ctx.beginPath();
  ctx.moveTo(-size, size * 0.35);
  ctx.quadraticCurveTo(0, size * 0.75, size, size * 0.35);
  ctx.lineTo(size * 0.62, -size * 0.15);
  ctx.lineTo(-size * 0.62, -size * 0.15);
  ctx.closePath();
  ctx.fillStyle = fold;
  ctx.fill();

  ctx.beginPath();
  ctx.moveTo(-size * 0.72, -size * 0.1);
  ctx.lineTo(0, -size * 1.35);
  ctx.lineTo(size * 0.72, -size * 0.1);
  ctx.closePath();
  ctx.fillStyle = hull;
  ctx.fill();

  ctx.beginPath();
  ctx.moveTo(0, -size * 1.35);
  ctx.lineTo(0, -size * 0.1);
  ctx.strokeStyle = fold;
  ctx.lineWidth = Math.max(0.5, size * 0.09);
  ctx.stroke();
}

function wake(ctx: CanvasRenderingContext2D, size: number, strength: number): void {
  if (strength <= 0.01) return;
  ctx.strokeStyle = `rgba(214, 231, 246, ${0.3 * strength})`;
  ctx.lineWidth = Math.max(0.6, size * 0.16);
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(side * size * 0.7, size * 0.3);
    ctx.quadraticCurveTo(
      side * size * 1.7,
      size * 1.3,
      side * size * 2.1,
      size * 2.6,
    );
    ctx.stroke();
  }
}

function drawBoat(
  ctx: CanvasRenderingContext2D,
  view: View,
  x: number,
  y: number,
  lean: number,
  capsizeMs: number,
  hull: string,
  fold: string,
  alpha: number,
  moving: number,
): void {
  const p = project(view, x, y);
  const size = BOAT_RADIUS * view.scale * p.k * 1.5;
  if (size < 0.8) return;

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(p.sx, p.sy);

  if (capsizeMs > 0) {
    // Roll hard, spin off the heading, then settle back level as it rights.
    const done = 1 - capsizeMs / CAPSIZE_MS;
    const settle = Math.max(0, 1 - done * 1.4);
    ctx.rotate(Math.sin(done * Math.PI * 2.4) * 1.5 * settle);
    ctx.scale(1 - 0.25 * settle, 1 - 0.35 * settle);
    ctx.globalAlpha = alpha * (0.45 + 0.55 * done);

    const burst = Math.min(1, done * 3);
    ctx.strokeStyle = `rgba(214, 231, 246, ${0.5 * (1 - burst)})`;
    ctx.lineWidth = Math.max(0.8, size * 0.2);
    ctx.beginPath();
    ctx.ellipse(0, size * 0.2, size * (1 + burst * 3), size * (0.6 + burst * 1.8), 0, 0, Math.PI * 2);
    ctx.stroke();
  } else {
    ctx.rotate(lean * 0.32);
    wake(ctx, size, moving);
  }

  paperBoat(ctx, size, hull, fold);
  ctx.restore();
}

/** The splash a stroke throws, on the side the paddle went in. */
function stroke(
  ctx: CanvasRenderingContext2D,
  view: View,
  race: Race,
  side: number,
  timeMs: number,
): void {
  if (side === 0 || race.boat.capsizeMs > 0) return;
  const p = project(view, race.boat.x, race.boat.y);
  const size = BOAT_RADIUS * view.scale * p.k * 1.5;
  const beat = (timeMs % 260) / 260;
  ctx.save();
  ctx.translate(p.sx + side * size * 1.25, p.sy + size * 0.35);
  ctx.strokeStyle = `rgba(233, 244, 255, ${0.45 * (1 - beat)})`;
  ctx.lineWidth = Math.max(0.8, size * 0.18);
  ctx.beginPath();
  ctx.ellipse(0, 0, size * (0.4 + beat * 1.1), size * (0.2 + beat * 0.5), 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

/**
 * Two ripple chevrons on the water at the boat's flanks, pulsing until the
 * first input and never again after it. Shape, not words -- the spec forbids
 * on-screen instructions, and a arrow drawn in foam is an affordance rather
 * than a sentence.
 */
function hintChevrons(
  ctx: CanvasRenderingContext2D,
  view: View,
  race: Race,
  hint: number,
  timeMs: number,
): void {
  if (hint <= 0.01) return;
  const p = project(view, race.boat.x, race.boat.y);
  const size = BOAT_RADIUS * view.scale * p.k * 1.5;
  const beat = 0.5 + 0.5 * Math.sin(timeMs * 0.004);

  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const side of [-1, 1]) {
    for (let i = 0; i < 2; i += 1) {
      const reach = size * (1.7 + i * 0.85);
      const fade = hint * beat * (1 - i * 0.35);
      ctx.strokeStyle = `rgba(255, 214, 158, ${0.55 * fade})`;
      ctx.lineWidth = Math.max(1.2, size * 0.22);
      ctx.beginPath();
      ctx.moveTo(p.sx + side * reach - side * size * 0.5, p.sy - size * 0.6);
      ctx.lineTo(p.sx + side * reach, p.sy + size * 0.05);
      ctx.lineTo(p.sx + side * reach - side * size * 0.5, p.sy + size * 0.7);
      ctx.stroke();
    }
  }
  ctx.restore();
}

/** Both lanterns going up, however the race went. */
function lanterns(
  ctx: CanvasRenderingContext2D,
  view: View,
  ending: Ending,
): void {
  const t = Math.min(1, ending.ageMs / 4200);
  const ease = 1 - (1 - t) * (1 - t);

  ctx.save();
  ctx.fillStyle = `rgba(10, 12, 26, ${0.35 * Math.min(1, ending.ageMs / 900)})`;
  ctx.fillRect(0, 0, view.w, view.h);

  const pairs: [number, number][] =
    ending.outcome === "lost"
      ? [
          [-0.16, 0],
          [0.16, 0.22],
        ]
      : [
          [-0.16, 0.22],
          [0.16, 0],
        ];

  for (const [offset, delay] of pairs) {
    const local = Math.max(0, Math.min(1, (t - delay) / (1 - delay)));
    if (local <= 0) continue;
    const rise = 1 - (1 - local) * (1 - local);
    const x = view.w / 2 + offset * view.w * 0.5;
    const y = view.baseY - rise * (view.baseY - view.h * 0.12);
    const r = view.h * 0.018;

    const glow = ctx.createRadialGradient(x, y, 0, x, y, r * 9);
    glow.addColorStop(0, `rgba(255, 183, 101, ${0.6 * ease})`);
    glow.addColorStop(1, "rgba(255, 183, 101, 0)");
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(x, y, r * 9, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = "#ffd9a0";
    ctx.beginPath();
    ctx.moveTo(x - r * 0.7, y - r);
    ctx.lineTo(x + r * 0.7, y - r);
    ctx.lineTo(x + r, y + r);
    ctx.lineTo(x - r, y + r);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

/**
 * Draws the eye down the river on a wide viewport, where the meadow otherwise
 * takes up most of the frame.
 */
function vignette(ctx: CanvasRenderingContext2D, view: View): void {
  const cx = view.w / 2;
  const cy = view.baseY * 0.78;
  const grad = ctx.createRadialGradient(
    cx,
    cy,
    view.h * 0.3,
    cx,
    cy,
    Math.max(view.w, view.h) * 0.78,
  );
  grad.addColorStop(0, "rgba(8, 9, 18, 0)");
  grad.addColorStop(1, "rgba(8, 9, 18, 0.34)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, view.w, view.h);
}

/**
 * The bend where the lanterns go up, glowing on the horizon and brightening as
 * you close on it. This is the game's entire progress indicator: a HUD would be
 * a second thing to read, and there is nothing to read here on purpose.
 */
function finishGlow(ctx: CanvasRenderingContext2D, view: View): void {
  const left = COURSE_LENGTH - view.boatY;
  if (left > VIEW_DEPTH * 2.2) return;
  const near = 1 - Math.max(0, left) / (VIEW_DEPTH * 2.2);
  const p = project(view, centreAt(COURSE_LENGTH), Math.min(COURSE_LENGTH, view.boatY + VIEW_DEPTH));
  const r = view.h * (0.06 + near * 0.3);

  ctx.save();
  const glow = ctx.createRadialGradient(p.sx, p.sy, 0, p.sx, p.sy, r);
  glow.addColorStop(0, `rgba(255, 196, 122, ${0.16 + near * 0.5})`);
  glow.addColorStop(1, "rgba(255, 196, 122, 0)");
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(p.sx, p.sy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

export function draw(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  scene: Scene,
): void {
  const view: View = {
    w,
    h,
    scale: h * SCALE_OF_HEIGHT,
    baseY: h * BOAT_SCREEN_Y,
    horizon: h * HORIZON_Y,
    boatY: scene.race.boat.y,
    cameraX: scene.cameraX,
  };

  sky(ctx, view);
  skyLanterns(ctx, view, scene.timeMs);
  land(ctx, view);

  const cuts = sections(view);
  water(ctx, view, cuts);
  ripples(ctx, view, cuts, scene.timeMs);
  haze(ctx, view, cuts);
  finishGlow(ctx, view);
  reeds(ctx, view);

  const { boat } = scene.race;
  const rival = scene.rival;
  const drawRival = (): void => {
    if (!rival) return;
    drawBoat(
      ctx,
      view,
      rival.x,
      rival.y,
      rival.lean,
      0,
      RIVAL_PAPER,
      RIVAL_FOLD,
      rival.ghost ? 0.55 : 1,
      0.7,
    );
  };

  // Depth order: whichever boat is further upstream is painted first, so a rock
  // between the two of them occludes the far boat rather than the near one.
  if (rival && rival.y > boat.y) drawRival();
  rocks(ctx, view, scene.river);
  if (!rival || rival.y <= boat.y) drawRival();

  hintChevrons(ctx, view, scene.race, scene.hint, scene.timeMs);
  stroke(ctx, view, scene.race, scene.stroke, scene.timeMs);
  drawBoat(
    ctx,
    view,
    boat.x,
    boat.y,
    boat.lean,
    boat.capsizeMs,
    PAPER,
    PAPER_FOLD,
    1,
    scene.stroke === 0 ? 0.35 : 1,
  );

  vignette(ctx, view);
  if (scene.ending) lanterns(ctx, view, scene.ending);
}
