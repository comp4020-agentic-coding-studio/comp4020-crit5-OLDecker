// Wiring: input, the frame loop, and the handful of DOM nodes that sit over the
// canvas. Everything with a rule in it lives in regatta.ts; everything with a
// pixel in it lives in scene3d.ts (plus assets.ts, water.ts and paddle.ts).
// This file owns the clock and the browser.

import type { Ending, Rival, Scene, Stroke } from "./scene3d.ts";
import { createRenderer } from "./scene3d.ts";
import type { Input, Race, Steer } from "./regatta.ts";
import type { Pose } from "./net.ts";
import {
  BOAT_RADIUS,
  IDLE,
  initialRace,
  outcome,
  pacerPose,
  pacerTargetMs,
  step,
} from "./regatta.ts";
import { buildRiver, centreAt, halfWidthAt, seedFromCode } from "./river.ts";
import { makeRoomCode, roomFromHash } from "./room.ts";
import { connectRoom } from "./net.ts";

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
const fieldEl = document.querySelector<HTMLOListElement>("#field");

if (
  !canvas ||
  !titleEl ||
  !resultEl ||
  !verdictEl ||
  !timesEl ||
  !againEl ||
  !inviteEl ||
  !shareEl ||
  !shareFaceEl ||
  !fieldEl
) {
  throw new Error("the page is missing an element the race needs");
}

// Aliased after the guard, not used directly: TypeScript's null-narrowing of an
// outer const survives into arrow closures but NOT into the hoisted function
// declarations below, which would otherwise all be TS18047.
const view = canvas;
const title = titleEl;
const result = resultEl;
const verdict = verdictEl;
const times = timesEl;
const invite = inviteEl;
const shareFace = shareFaceEl;
const standings = fieldEl;

// The room code is the seed. Two people who open the same link race the same
// water without a byte of terrain crossing between them.
const code = roomFromHash(location.hash) ?? makeRoomCode(Math.random);
if (roomFromHash(location.hash) !== code) {
  history.replaceState(null, "", `#r=${code}`);
}
const river = buildRiver(seedFromCode(code));

// No async asset loading here -- procedural geometry builds synchronously, so
// the renderer is ready before the first requestAnimationFrame.
const { resize: resizeRenderer, renderScene } = createRenderer(view, river);

let race: Race = initialRace();
let cameraX = race.boat.x;
let ending: Ending | null = null;
let finishedAt = 0;
let firstRace = true;
let selfFinishMs: number | null = null;

// Optional, and never waited on: this returns before a packet has moved and the
// river is already playable. If somebody opens the same link the pacer quietly
// becomes them; if nobody does, or the relay is unreachable, or the NAT refuses,
// nothing about the game changes. See net.ts.
const net = connectRoom(code, () => showResult());

// ---------------------------------------------------------------------------
// Input. One gesture carries propulsion and steering: hold, and the boat both
// paddles and makes for where you are holding.
//
// A held finger names a *place*, not a direction. The canvas maps across the
// channel -- hold a third of the way in from the left edge and the boat goes to
// a third of the way in from the left bank, and stays there. This replaced a
// three-zone scheme (left of 42% meant "turn left" for as long as you held it),
// which on a phone meant steering by dabbing: press, watch, lift before the
// overshoot, press again. Naming a target instead makes holding still the
// normal state, which is what a thumb on a phone is good at.
//
// Keys stay directional, because a key has no position to name.
// ---------------------------------------------------------------------------

const keys = { left: false, right: false, straight: false };

/** Live contacts, each holding where across the canvas it sits, 0..1. */
const pointers = new Map<number, number>();

/**
 * How far ahead of the boat to aim, as a multiplier on its heel. `lean` is a
 * smoothed copy of recent steering, so it stands in for lateral speed; steering
 * on present error alone overshoots the target and then hunts around it.
 */
const LEAD = 0.42;

/** Close enough. Wide enough not to chatter, tight enough to feel aimed. */
const ARRIVED = 0.045;

function pointerSteer(race: Race): Steer {
  let sum = 0;
  for (const fraction of pointers.values()) sum += fraction;
  const across = sum / pointers.size;

  const y = race.boat.y;
  // The reachable water at this point of the course: bank to bank, less the
  // boat's own beam, so the far edges of the screen ask for the far edges of
  // the river rather than for a capsize.
  const usable = halfWidthAt(y) - BOAT_RADIUS;
  const targetX = centreAt(y) + (across * 2 - 1) * usable;

  const predicted = race.boat.x + race.boat.lean * LEAD;
  const error = targetX - predicted;
  if (Math.abs(error) < ARRIVED) return 0;
  return error < 0 ? -1 : 1;
}

function readInput(race: Race): Input {
  // A key is an explicit instruction and outranks a resting finger.
  if (keys.left && keys.right) return { paddling: true, steer: 0 };
  if (keys.left) return { paddling: true, steer: -1 };
  if (keys.right) return { paddling: true, steer: 1 };
  if (keys.straight) return { paddling: true, steer: 0 };
  if (pointers.size > 0) return { paddling: true, steer: pointerSteer(race) };
  return IDLE;
}

function acrossOf(clientX: number): number {
  const box = view.getBoundingClientRect();
  const rel = (clientX - box.left) / Math.max(1, box.width);
  return rel < 0 ? 0 : rel > 1 ? 1 : rel;
}

view.addEventListener("pointerdown", (event: PointerEvent) => {
  // Without this a real click-drag over the canvas starts the browser's own
  // selection gesture and eats the pointer stream the paddle runs on.
  event.preventDefault();
  view.setPointerCapture(event.pointerId);
  pointers.set(event.pointerId, acrossOf(event.clientX));
});

view.addEventListener("pointermove", (event: PointerEvent) => {
  if (pointers.has(event.pointerId)) {
    pointers.set(event.pointerId, acrossOf(event.clientX));
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

/** Your place in the field, spelled out. Two-up this reads exactly as it always
 *  did -- first or second -- and simply keeps counting past that. */
const PLACES = ["First", "Second", "Third", "Fourth", "Fifth"];

function placed(place: number): string {
  return `${PLACES[place - 1] ?? `${place}th`} to the bend`;
}

const TOGETHER = "Together at the bend";

/** A real rival still on the water. Their lantern hasn't gone up yet. */
const STILL_OUT = "At the bend";

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Called on finishing, and again if a live rival finishes after you. Racing a
 * person means their time can arrive later than yours -- both clocks start on
 * their own owner's first stroke, so there is no shared start to line them up
 * against -- and the panel fills in the verdict when it does. Against the pacer
 * the second call never comes, because the pacer's time is known up front.
 */
function showResult(): void {
  const selfMs = selfFinishMs;
  const at = ending;
  if (selfMs === null || !at) return;

  // Against the pacer there is exactly one time to beat; against people there
  // are as many as have finished, and the fastest of them is the one the
  // lantern turns on -- they either beat you or they did not.
  const rivalTimes = net.live
    ? net.rivalFinishTimes
    : [pacerTargetMs(race.startY)];
  const rivalMs = net.live ? net.rivalFinishMs : rivalTimes[0];

  const field = 1 + rivalTimes.length;
  const place = 1 + rivalTimes.filter((ms) => ms < selfMs).length;

  if (rivalMs === null) {
    verdict.textContent = STILL_OUT;
    times.textContent = seconds(selfMs);
    // field === 1: yours is the only lantern up, which is what the panel says.
    ending = { ...at, place, field };
  } else {
    // Not named `result`: that is the panel element this function unhides.
    const standing = outcome(selfMs, rivalMs);
    ending = { ...at, outcome: standing, place, field };
    verdict.textContent = standing === "tied" ? TOGETHER : placed(place);
    // Yours first, always, then the rest quickest first: sorting the whole row
    // would read as a leaderboard with no way to tell which line is you.
    times.textContent = [selfMs, ...rivalTimes].map(seconds).join(" · ");
  }
  result.hidden = false;
  invite.classList.remove("dim");
}

/**
 * Ranked live by distance down the river, never by finish time -- the one
 * thing this can say that the finish panel can't. Empty and hidden until a
 * real rival's pose actually lands, same signal the boat itself is drawn
 * from, so the indicator never claims a connection the scene doesn't show.
 */
function renderStandings(rivals: Pose[]): void {
  if (rivals.length === 0) {
    standings.hidden = true;
    return;
  }
  // Sorted by id, not join order, so a row's label stays put across a
  // mid-race leave/rejoin instead of relabelling everyone still in the room.
  const ids = rivals.map((r) => r.id).sort();
  const label = (id: string): string =>
    ids.length === 1 ? "Rival" : `Rival ${ids.indexOf(id) + 1}`;

  const entries = [
    { label: "You", y: race.boat.y, self: true },
    ...rivals.map((r) => ({ label: label(r.id), y: r.y, self: false })),
  ].sort((a, b) => b.y - a.y);

  standings.replaceChildren(
    ...entries.map(({ label: text, self }, i) => {
      const li = document.createElement("li");
      li.textContent = `${i + 1} ${text}`;
      if (self) li.classList.add("self");
      return li;
    }),
  );
  standings.hidden = false;
}

function finish(selfMs: number): void {
  selfFinishMs = selfMs;
  finishedAt = performance.now();
  // Both lanterns rise together until there is a reason for one to go first.
  ending = { outcome: "tied", ageMs: 0, place: 1, field: 1 };
  showResult();
}

function restart(): void {
  race = initialRace();
  cameraX = race.boat.x;
  ending = null;
  selfFinishMs = null;
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

// scene3d.ts's resize() takes CSS pixel dimensions and handles the device
// pixel ratio internally (Three.js's setPixelRatio + setSize(w, h, false)),
// so this passes the bounding box straight through with no manual scaling.
function resize(): void {
  const box = view.getBoundingClientRect();
  resizeRenderer(Math.max(1, box.width), Math.max(1, box.height));
}

new ResizeObserver(resize).observe(view);
resize();

let previous = performance.now();
const openedAt = previous;

function frame(now: number): void {
  const elapsed = Math.min(120, now - previous);
  previous = now;

  const input = readInput(race);
  if (!ending) {
    for (let left = elapsed; left > 0; left -= MAX_SUB_MS) {
      race = step(river, race, input, Math.min(MAX_SUB_MS, left));
    }
    if (race.finishedMs !== null) finish(race.finishedMs);
  }

  // Ease the camera rather than pinning it to the boat, so a stroke reads as
  // the boat moving across the river instead of the river jumping sideways.
  const lead = 1 - Math.exp((-elapsed / 1000) * 3.5);
  cameraX += (race.boat.x - cameraX) * lead;

  title.classList.toggle("away", race.started);
  invite.classList.toggle("dim", race.started && !ending);
  invite.classList.toggle("live", net.live);

  net.publish(
    {
      x: race.boat.x,
      y: race.boat.y,
      lean: race.boat.lean,
      capsizing: race.boat.capsizeMs > 0,
      done: race.finishedMs,
    },
    now,
  );

  // Real people displace the pacer the moment their snapshots land -- all of
  // them, however many are in the room. The pacer only paces an empty river.
  const peers = net.posesAt(now);
  renderStandings(peers);
  const pacer = pacerPose(race.elapsedMs, race.startY);
  const rivals: Rival[] =
    peers.length > 0
      ? peers.map((p) => ({ x: p.x, y: p.y, lean: p.lean, ghost: false }))
      : [{ x: pacer.x, y: pacer.y, lean: 0, ghost: true }];

  const hint =
    firstRace && !race.started
      ? Math.min(1, Math.max(0, (now - openedAt - HINT_AFTER_MS) / 900))
      : 0;

  // The alternation itself belongs to the animation, not to this loop: hand
  // over whether the paddle is being worked and which side is being favoured,
  // and let paddle.ts run the cycle off its own clock. A wall-clock square wave
  // here used to decide which blade was down, which meant the stroke had no way
  // to keep alternating while steering -- it just held one blade out.
  const stroke: Stroke = { active: input.paddling, side: input.steer };

  if (ending) ending = { ...ending, ageMs: now - finishedAt };

  const frameScene: Scene = {
    river,
    race,
    rivals,
    cameraX,
    timeMs: now,
    hint,
    stroke,
    ending,
  };
  renderScene(frameScene);

  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
