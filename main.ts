// Wiring: input, the frame loop, and the handful of DOM nodes that sit over the
// canvas. Everything with a rule in it lives in regatta.ts; everything with a
// pixel in it lives in render.ts. This file owns the clock and the browser.

import type { Ending, Rival } from "./render.ts";
import { draw } from "./render.ts";
import type { Input, Race } from "./regatta.ts";
import {
  IDLE,
  initialRace,
  outcome,
  pacerPose,
  pacerTargetMs,
  step,
} from "./regatta.ts";
import { buildRiver, seedFromCode } from "./river.ts";
import { makeRoomCode, roomFromHash } from "./room.ts";

/**
 * Physics runs in slices no longer than this however long the frame took. At
 * full speed the boat covers about a tenth of a world unit per slice and a rock
 * is a third of a unit across, so it cannot be tunnelled through by a slow
 * frame or a backgrounded tab.
 */
const MAX_SUB_MS = 16;

/** How long a player is left alone before the water offers a hint. */
const HINT_AFTER_MS = 2200;

// Bound to non-null locals up front: TypeScript's narrowing of an outer const
// does not survive into a function declaration later in the same block.
const canvas = document.querySelector<HTMLCanvasElement>("#river");
const titleEl = document.querySelector<HTMLElement>("#title");
const resultEl = document.querySelector<HTMLElement>("#result");
const verdictEl = document.querySelector<HTMLElement>("#verdict");
const timesEl = document.querySelector<HTMLElement>("#times");
const againEl = document.querySelector<HTMLButtonElement>("#again");
const inviteEl = document.querySelector<HTMLElement>("#invite");
const shareEl = document.querySelector<HTMLButtonElement>("#share");
const shareFaceEl = document.querySelector<HTMLElement>("#share-face");

if (
  !canvas ||
  !titleEl ||
  !resultEl ||
  !verdictEl ||
  !timesEl ||
  !againEl ||
  !inviteEl ||
  !shareEl ||
  !shareFaceEl
) {
  throw new Error("the page is missing an element the race needs");
}

const ctx = canvas.getContext("2d");
if (!ctx) throw new Error("no 2d context");

// Aliased after the guard, not used directly: TypeScript's null-narrowing of an
// outer const survives into arrow closures but NOT into the hoisted function
// declarations below, which would otherwise all be TS18047.
const view = canvas;
const surface = ctx;
const title = titleEl;
const result = resultEl;
const verdict = verdictEl;
const times = timesEl;
const invite = inviteEl;
const shareFace = shareFaceEl;

// The room code is the seed. Two people who open the same link race the same
// water without a byte of terrain crossing between them.
const code = roomFromHash(location.hash) ?? makeRoomCode(Math.random);
if (roomFromHash(location.hash) !== code) {
  history.replaceState(null, "", `#r=${code}`);
}
const river = buildRiver(seedFromCode(code));

let race: Race = initialRace();
let cameraX = race.boat.x;
let ending: Ending | null = null;
let finishedAt = 0;
let firstRace = true;

// ---------------------------------------------------------------------------
// Input. One gesture carries propulsion and steering: hold a side to paddle on
// that side. Holding both, or a key with no side to it, paddles straight.
// ---------------------------------------------------------------------------

const keys = { left: false, right: false, straight: false };
const pointers = new Map<number, -1 | 0 | 1>();

function readInput(): Input {
  let left = keys.left;
  let right = keys.right;
  let straight = keys.straight;
  for (const side of pointers.values()) {
    if (side === -1) left = true;
    else if (side === 1) right = true;
    else straight = true;
  }
  if (left && right) return { paddling: true, steer: 0 };
  if (left) return { paddling: true, steer: -1 };
  if (right) return { paddling: true, steer: 1 };
  if (straight) return { paddling: true, steer: 0 };
  return IDLE;
}

function sideOf(clientX: number): -1 | 0 | 1 {
  const box = view.getBoundingClientRect();
  const rel = (clientX - box.left) / box.width;
  // A dead band down the middle so a centre tap means "straight ahead" rather
  // than an arbitrary lurch to whichever side of the pixel it landed on.
  if (rel < 0.42) return -1;
  if (rel > 0.58) return 1;
  return 0;
}

view.addEventListener("pointerdown", (event: PointerEvent) => {
  // Without this a real click-drag over the canvas starts the browser's own
  // selection gesture and eats the pointer stream the paddle runs on.
  event.preventDefault();
  view.setPointerCapture(event.pointerId);
  pointers.set(event.pointerId, sideOf(event.clientX));
});

view.addEventListener("pointermove", (event: PointerEvent) => {
  if (pointers.has(event.pointerId)) {
    pointers.set(event.pointerId, sideOf(event.clientX));
  }
});

for (const type of ["pointerup", "pointercancel", "pointerleave"] as const) {
  view.addEventListener(type, (event: PointerEvent) => {
    pointers.delete(event.pointerId);
  });
}

function keyToField(key: string): keyof typeof keys | null {
  switch (key) {
    case "ArrowLeft":
    case "a":
    case "A":
      return "left";
    case "ArrowRight":
    case "d":
    case "D":
      return "right";
    case "ArrowUp":
    case "w":
    case "W":
    case " ":
      return "straight";
    default:
      return null;
  }
}

window.addEventListener("keydown", (event: KeyboardEvent) => {
  const field = keyToField(event.key);
  if (!field) return;
  event.preventDefault();
  keys[field] = true;
});

window.addEventListener("keyup", (event: KeyboardEvent) => {
  const field = keyToField(event.key);
  if (field) keys[field] = false;
});

// A tab that loses focus mid-stroke must not leave the paddle jammed down.
window.addEventListener("blur", () => {
  keys.left = false;
  keys.right = false;
  keys.straight = false;
  pointers.clear();
});

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

const VERDICTS: Record<Ending["outcome"], string> = {
  won: "First to the bend",
  lost: "Second to the bend",
  tied: "Together at the bend",
};

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function finish(selfMs: number, rivalMs: number): void {
  ending = { outcome: outcome(selfMs, rivalMs), ageMs: 0 };
  finishedAt = performance.now();
  verdict.textContent = VERDICTS[ending.outcome];
  times.textContent = `${seconds(selfMs)} · ${seconds(rivalMs)}`;
  result.hidden = false;
  invite.classList.remove("dim");
}

function restart(): void {
  race = initialRace();
  cameraX = race.boat.x;
  ending = null;
  firstRace = false;
  result.hidden = true;
  view.focus();
}

againEl.addEventListener("click", restart);

shareEl.addEventListener("click", () => {
  void (async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      shareFace.textContent = "✓";
      invite.classList.add("copied");
      setTimeout(() => {
        shareFace.textContent = "\u{1F517}";
        invite.classList.remove("copied");
      }, 1600);
    } catch {
      // Clipboard access can be refused outright; the URL bar still has the
      // link, so there is nothing useful to say about it.
      invite.classList.add("copied");
    }
  })();
});

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

function resize(): void {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const box = view.getBoundingClientRect();
  view.width = Math.max(1, Math.round(box.width * dpr));
  view.height = Math.max(1, Math.round(box.height * dpr));
  surface.setTransform(dpr, 0, 0, dpr, 0, 0);
}

new ResizeObserver(resize).observe(view);
resize();

let previous = performance.now();
const openedAt = previous;

function frame(now: number): void {
  const elapsed = Math.min(120, now - previous);
  previous = now;

  const input = readInput();
  if (!ending) {
    for (let left = elapsed; left > 0; left -= MAX_SUB_MS) {
      race = step(river, race, input, Math.min(MAX_SUB_MS, left));
    }
    if (race.finishedMs !== null) {
      finish(race.finishedMs, pacerTargetMs(race.startY));
    }
  }

  // Ease the camera rather than pinning it to the boat, so a stroke reads as
  // the boat moving across the river instead of the river jumping sideways.
  const lead = 1 - Math.exp((-elapsed / 1000) * 3.5);
  cameraX += (race.boat.x - cameraX) * lead;

  title.classList.toggle("away", race.started);
  invite.classList.toggle("dim", race.started && !ending);

  const pacer = pacerPose(race.elapsedMs, race.startY);
  const rival: Rival = { x: pacer.x, y: pacer.y, ghost: true };

  const hint =
    firstRace && !race.started
      ? Math.min(1, Math.max(0, (now - openedAt - HINT_AFTER_MS) / 900))
      : 0;

  const strokeSide =
    input.steer !== 0
      ? input.steer
      : input.paddling
        ? Math.sin(now * 0.012) > 0
          ? 1
          : -1
        : 0;

  if (ending) ending = { ...ending, ageMs: now - finishedAt };

  const box = view.getBoundingClientRect();
  draw(surface, box.width, box.height, {
    river,
    race,
    rival,
    cameraX,
    timeMs: now,
    hint,
    stroke: strokeSide,
    ending,
  });

  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
