// Who else is on the river. The pure half of the connection: every decision
// about what the link is *doing* lives here, so the half that cannot be tested
// (real WebRTC against a real public relay) stays as thin as possible. Nothing
// in this file imports trystero, touches the DOM, reads the clock, or rolls a
// die -- times and randomness arrive as arguments, which is what makes
// connect-latency and room-code generation assertable with nothing mocked.
//
// This started as a throwaway transport spike (da848c2) and survived contact
// with the real game unchanged apart from losing its demo action, which is the
// best argument available that the seam was drawn in the right place.

/**
 * `waiting` is deliberately NOT a failure: being alone in a room is the normal
 * state of whoever arrives first. `lonely` marks the point where waiting has
 * gone on long enough to be suspicious — but it still isn't proof of a fault,
 * because "nobody joined yet" and "your NAT is blocking me" look identical from
 * in here. The UI has to say both.
 */
export type Phase = "idle" | "joining" | "waiting" | "connected" | "failed";

export type FailureReason = "offline" | "relay-unreachable" | "join-error";

export type RoomState = {
  phase: Phase;
  selfId: string | null;
  peers: string[];
  joinedAt: number | null;
  connectedAt: number | null;
  lonely: boolean;
  failure: { reason: FailureReason; detail: string } | null;
};

export type RoomEvent =
  | { type: "join"; selfId: string; at: number }
  | { type: "settled" }
  | { type: "peer-join"; peerId: string; at: number }
  | { type: "peer-leave"; peerId: string }
  | { type: "lonely" }
  | { type: "fail"; reason: FailureReason; detail: string }
  | { type: "leave" };

export function initialState(): RoomState {
  return {
    phase: "idle",
    selfId: null,
    peers: [],
    joinedAt: null,
    connectedAt: null,
    lonely: false,
    failure: null,
  };
}

export function reduce(state: RoomState, event: RoomEvent): RoomState {
  switch (event.type) {
    case "join":
      return {
        ...initialState(),
        phase: "joining",
        selfId: event.selfId,
        joinedAt: event.at,
      };

    // The relay gives us no "connected" callback, so a short grace timer is the
    // only way to distinguish "still dialling" from "in the room, alone".
    case "settled":
      return state.phase === "joining" ? { ...state, phase: "waiting" } : state;

    case "peer-join": {
      if (state.peers.includes(event.peerId)) return state;
      const peers = [...state.peers, event.peerId];
      return {
        ...state,
        phase: "connected",
        peers,
        lonely: false,
        // first peer only: latency to the *first* successful connection is the
        // number the spike exists to measure.
        connectedAt: state.connectedAt ?? event.at,
      };
    }

    case "peer-leave": {
      const peers = state.peers.filter((id) => id !== event.peerId);
      if (peers.length === state.peers.length) return state;
      return {
        ...state,
        peers,
        phase: peers.length > 0 ? "connected" : "waiting",
      };
    }

    case "lonely":
      return state.phase === "connected" ? state : { ...state, lonely: true };

    case "fail":
      return {
        ...state,
        phase: "failed",
        failure: { reason: event.reason, detail: event.detail },
      };

    case "leave":
      return initialState();
  }
}

export function connectLatencyMs(state: RoomState): number | null {
  if (state.joinedAt === null || state.connectedAt === null) return null;
  return state.connectedAt - state.joinedAt;
}

// Lookalike glyphs (0/o, 1/l/i) are omitted: a room code's whole job is to
// survive being read aloud or retyped from a phone screen.
const CODE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const CODE_LENGTH = 6;

export function makeRoomCode(rand: () => number): string {
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    const pick = Math.min(
      Math.floor(rand() * CODE_ALPHABET.length),
      CODE_ALPHABET.length - 1,
    );
    code += CODE_ALPHABET.charAt(pick);
  }
  return code;
}

export function normaliseRoomCode(input: string): string | null {
  const cleaned = input.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  if (cleaned.length !== CODE_LENGTH) return null;
  for (const ch of cleaned) {
    if (!CODE_ALPHABET.includes(ch)) return null;
  }
  return cleaned;
}

/** Reads `#r=abc123`. The hash never leaves the browser — no server sees it. */
export function roomFromHash(hash: string): string | null {
  const match = /(?:^|[#&])r=([^&]*)/.exec(hash);
  return match ? normaliseRoomCode(match[1]) : null;
}

// ---------------------------------------------------------------------------
// The rival's trail. Snapshots arrive about ten times a second over a link with
// no delivery guarantees and no clock in common, so what gets drawn is not the
// newest one: it's the position the peer held a fixed delay ago, interpolated
// between the two snapshots straddling it. At drift speed that delay is
// invisible, and it is the whole reason 10 Hz of jittery packets can be drawn
// as a boat rather than a strobe.
//
// `t` is the LOCAL time the snapshot arrived, never the sender's clock. Nothing
// here needs the two machines to agree on what time it is, which removes the
// only piece of state that would have had to be synchronised.
// ---------------------------------------------------------------------------

export type Snapshot = {
  t: number;
  x: number;
  y: number;
  lean: number;
  capsizing: boolean;
};

/**
 * Where the peer was at local time `at`.
 *
 * Never extrapolates past the newest snapshot. A peer whose packets stop is
 * held where they were last seen rather than sailing on forever: "the link
 * dropped" and "they are still paddling" must not look the same, and of the two
 * readings a boat that stops dead is the honest one.
 */
export function sampleTrail(trail: Snapshot[], at: number): Snapshot | null {
  if (trail.length === 0) return null;
  const newest = trail[trail.length - 1];
  if (at >= newest.t) return newest;
  if (at <= trail[0].t) return trail[0];

  for (let i = 1; i < trail.length; i += 1) {
    const b = trail[i];
    if (b.t < at) continue;
    const a = trail[i - 1];
    const span = b.t - a.t;
    const f = span <= 0 ? 1 : (at - a.t) / span;
    return {
      t: at,
      x: a.x + (b.x - a.x) * f,
      y: a.y + (b.y - a.y) * f,
      lean: a.lean + (b.lean - a.lean) * f,
      // A capsize is a state, not a quantity: crossfading it would render a
      // boat that is half rolled over, which is not a thing that happens.
      capsizing: f < 0.5 ? a.capsizing : b.capsizing,
    };
  }
  return newest;
}

/**
 * Drops snapshots no longer needed to interpolate at `at`, keeping the one
 * immediately before it. Without that straggler the trail would run out from
 * underneath the render delay and the rival would snap forward every trim.
 */
export function trimTrail(trail: Snapshot[], at: number): Snapshot[] {
  let keep = 0;
  while (keep + 1 < trail.length && trail[keep + 1].t <= at) keep += 1;
  return keep === 0 ? trail : trail.slice(keep);
}

// ---------------------------------------------------------------------------
// More than one rival. Every peer's snapshots arrive on the same callback and
// the sender's id is the only thing separating them -- fold them into one trail
// and `sampleTrail` will cheerfully interpolate between two different people,
// drawing a single boat that swings across the river at the combined send rate.
// The maths succeeds, so nothing reports a fault: it just draws the wrong boat.
// Hence a trail per peer, keyed by the id the transport already hands over.
// ---------------------------------------------------------------------------

export type Trails = ReadonlyMap<string, Snapshot[]>;

export function recordSnapshot(
  trails: Trails,
  peerId: string,
  snap: Snapshot,
): Trails {
  const next = new Map(trails);
  const own = next.get(peerId);
  next.set(peerId, own ? [...own, snap] : [snap]);
  return next;
}

/**
 * Drops a peer entirely. Used when they leave, and also when they *join* — a
 * rejoining id arrives with a stale trail from their last race, and
 * interpolating across the gap would drag their boat in from wherever it
 * stopped. Only that peer is affected; everyone else is mid-race.
 */
export function forgetPeer(trails: Trails, peerId: string): Trails {
  if (!trails.has(peerId)) return trails;
  const next = new Map(trails);
  next.delete(peerId);
  return next;
}

export type IdentifiedPose = Snapshot & { id: string };

/**
 * Every rival's pose at local time `at`, with the trails trimmed to match.
 * Each peer is trimmed and sampled against its own trail only. A peer with
 * nothing usable yet is skipped rather than emitting a hole, so the caller gets
 * a list it can draw straight through.
 *
 * The id rides along with each pose -- a standings list has to tell rivals
 * apart the same way `recordSnapshot` does, or two boats collapse into one row
 * exactly like they'd collapse into one interpolated boat without it.
 */
export function posesFrom(
  trails: Trails,
  at: number,
): { trails: Trails; poses: IdentifiedPose[] } {
  const next = new Map<string, Snapshot[]>();
  const poses: IdentifiedPose[] = [];
  for (const [peerId, trail] of trails) {
    const trimmed = trimTrail(trail, at);
    next.set(peerId, trimmed);
    const pose = sampleTrail(trimmed, at);
    if (pose) poses.push({ ...pose, id: peerId });
  }
  return { trails: next, poses };
}
