// SPIKE — not part of the crit-5 deliverable. Lives on `spike/multiplayer`,
// never merged to main. See docs/spike-multiplayer.md.
//
// The impure half: everything that touches trystero, the DOM, the clock or the
// RNG. It makes no decisions of its own — it translates callbacks into events,
// hands them to the reducer in spike-room.ts, and renders whatever comes back.

import { defaultRelayUrls, joinRoom, selfId } from "trystero";
import {
  connectLatencyMs,
  initialState,
  makeRoomCode,
  normaliseRoomCode,
  reduce,
  roomFromHash,
  type RoomEvent,
  type RoomState,
} from "./spike-room.ts";

// How long to sit in "joining" before admitting we're simply alone in the room.
const GRACE_MS = 2_500;
// How long before being alone stops looking normal and starts looking wrong.
// Nothing observable distinguishes the two, which is why this sets a flag
// rather than declaring a failure.
const PATIENCE_MS = 20_000;

const APP_ID = "comp4020-oldecker-spike";
// Without a password trystero derives the SDP key from appId + room id, which a
// relay operator can reverse. This is a public room code, so it's a low bar --
// but leaving it off would be a worse habit to carry into anything real.
const ROOM_PASSWORD = "spike-not-a-secret";

const el = <T extends HTMLElement>(id: string): T => {
  const found = document.getElementById(id);
  if (!found) throw new Error(`spike: #${id} missing from spike.html`);
  return found as T;
};

const ui = {
  dot: el("dot"),
  phase: el("phase"),
  detail: el("detail"),
  self: el("self"),
  peers: el("peers"),
  latency: el("latency"),
  link: el<HTMLInputElement>("link"),
  copy: el<HTMLButtonElement>("copy"),
  code: el<HTMLInputElement>("code"),
  join: el<HTMLButtonElement>("join"),
  fresh: el<HTMLButtonElement>("fresh"),
  nudge: el<HTMLButtonElement>("nudge"),
  counter: el("counter"),
  lastby: el("lastby"),
  log: el("log"),
  relays: el("relays"),
};

type Room = ReturnType<typeof joinRoom>;
// `makeAction` is overloaded (message vs request). A bare ReturnType<> picks
// the LAST overload, RequestAction, which has no .send/.onMessage at all --
// so pin the message overload by inferring from an actual call.
const makeNudgeAction = (target: Room) => target.makeAction<number>("nudge");
type NudgeAction = ReturnType<typeof makeNudgeAction>;

let state: RoomState = initialState();
let room: Room | null = null;
let nudge: NudgeAction | null = null;
let graceTimer: number | undefined;
let patienceTimer: number | undefined;
let startedAt = 0;

const short = (id: string): string => id.slice(0, 6);

function log(line: string): void {
  const item = document.createElement("li");
  const at = startedAt ? `+${((Date.now() - startedAt) / 1000).toFixed(1)}s ` : "";
  item.textContent = `${at}${line}`;
  ui.log.prepend(item);
}

// The only path that mutates state. Every trystero callback funnels through it.
function dispatch(event: RoomEvent): void {
  state = reduce(state, event);
  render();
}

const PHASE_COPY: Record<RoomState["phase"], string> = {
  idle: "not connected",
  joining: "finding the room…",
  waiting: "in the room, alone",
  connected: "connected, peer to peer",
  failed: "failed",
};

function detailCopy(current: RoomState): string {
  if (current.phase === "failed" && current.failure) {
    const { reason, detail } = current.failure;
    if (reason === "offline") return "This device is offline.";
    if (reason === "relay-unreachable") {
      return `No signalling relay answered — ${detail}`;
    }
    return `The relay rejected the join — ${detail}`;
  }
  if (current.phase === "connected") {
    return "Data is flowing directly between browsers. No server is involved.";
  }
  if (current.lonely) {
    // The honest answer. These two causes are genuinely indistinguishable from
    // in here, and saying so beats a spinner that implies progress.
    return `Nobody has arrived in ${PATIENCE_MS / 1000}s. Either no one else has opened this room link, or a network between you is blocking direct connections — without a TURN relay this page cannot tell which.`;
  }
  if (current.phase === "waiting") {
    return "Signalling is up. Waiting for someone to open the same room link.";
  }
  return "";
}

function render(): void {
  ui.dot.dataset.phase = state.phase;
  ui.phase.textContent = PHASE_COPY[state.phase];
  ui.detail.textContent = detailCopy(state);
  ui.self.textContent = state.selfId ? short(state.selfId) : "—";
  ui.peers.textContent = state.peers.length
    ? state.peers.map(short).join(", ")
    : "none";

  const latency = connectLatencyMs(state);
  ui.latency.textContent = latency === null ? "—" : `${(latency / 1000).toFixed(2)}s`;

  ui.counter.textContent = String(state.counter);
  ui.lastby.textContent = state.lastNudgeBy
    ? `last nudge by ${state.lastNudgeBy === state.selfId ? "you" : short(state.lastNudgeBy)}`
    : "";
  ui.nudge.disabled = state.phase !== "connected";
}

function clearTimers(): void {
  window.clearTimeout(graceTimer);
  window.clearTimeout(patienceTimer);
}

async function enter(code: string): Promise<void> {
  clearTimers();
  if (room) {
    await room.leave();
    room = null;
    nudge = null;
  }

  window.location.hash = `r=${code}`;
  ui.link.value = window.location.href;
  ui.code.value = code;

  if (!navigator.onLine) {
    dispatch({ type: "fail", reason: "offline", detail: "navigator.onLine" });
    return;
  }

  startedAt = Date.now();
  dispatch({ type: "join", selfId, at: startedAt });
  log(`joining room ${code} as ${short(selfId)}`);

  graceTimer = window.setTimeout(() => dispatch({ type: "settled" }), GRACE_MS);
  patienceTimer = window.setTimeout(() => {
    dispatch({ type: "lonely" });
    log("no peer yet — see the note above for why this is ambiguous");
  }, PATIENCE_MS);

  room = joinRoom({ appId: APP_ID, password: ROOM_PASSWORD }, code, {
    onJoinError: ({ error }) => {
      log(`join error: ${error}`);
      dispatch({ type: "fail", reason: "join-error", detail: error });
    },
  });

  // Bound to a local const first: narrowing an outer `let` doesn't survive
  // into the callbacks below.
  const action = makeNudgeAction(room);
  nudge = action;

  action.onMessage = (value, { peerId }) => {
    log(`nudge from ${short(peerId)} → ${value}`);
    dispatch({ type: "nudge", from: peerId, counter: value });
  };

  room.onPeerJoin = (peerId) => {
    const at = Date.now();
    log(`peer joined: ${short(peerId)} (${((at - startedAt) / 1000).toFixed(2)}s)`);
    dispatch({ type: "peer-join", peerId, at });
  };

  room.onPeerLeave = (peerId) => {
    log(`peer left: ${short(peerId)}`);
    dispatch({ type: "peer-leave", peerId });
  };
}

ui.nudge.addEventListener("click", () => {
  const next = state.counter + 1;
  dispatch({ type: "nudge", from: selfId, counter: next });
  void nudge?.send(next);
});

ui.copy.addEventListener("click", () => {
  void navigator.clipboard?.writeText(ui.link.value);
  ui.copy.textContent = "Copied";
  window.setTimeout(() => (ui.copy.textContent = "Copy"), 1_200);
});

ui.join.addEventListener("click", () => {
  const code = normaliseRoomCode(ui.code.value);
  if (!code) {
    ui.detail.textContent = "That doesn't look like a room code (6 characters).";
    return;
  }
  void enter(code);
});

ui.fresh.addEventListener("click", () => void enter(makeRoomCode(Math.random)));

window.addEventListener("offline", () => {
  log("browser went offline");
  dispatch({ type: "fail", reason: "offline", detail: "offline event" });
});

ui.relays.textContent = defaultRelayUrls.join(", ");
render();
void enter(roomFromHash(window.location.hash) ?? makeRoomCode(Math.random));
