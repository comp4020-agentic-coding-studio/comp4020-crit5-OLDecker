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
