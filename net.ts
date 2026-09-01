// The impure half of the link: everything that touches trystero, the network or
// the wall clock. It makes no decisions -- it turns callbacks into snapshots,
// hands them to the pure helpers in room.ts, and hands back a rival pose.
//
// The design rule this file exists to honour: the network is NEVER on the
// critical path. `connectRoom` returns synchronously, before a single packet
// moves, and the game is already playable. Every failure below -- an insecure
// origin, an unreachable relay, a hostile NAT, nobody else in the room -- ends
// in exactly the same place from the player's side: no rival boat, so the pacer
// keeps the race. There is nothing to report, so nothing is reported.
//
// Note what is NOT here: no countdown, no start handshake, no host, no clock
// sync. Each player's own clock starts on their own first stroke and each times
// their own run, so the verdict is just two elapsed times compared. A start gate
// would have been the one piece of network on the critical path, which is
// exactly the thing this file is built to avoid.

import type { Trails } from "./room.ts";
import { forgetPeer, posesFrom, recordSnapshot } from "./room.ts";

const APP_ID = "comp4020-oldecker-regatta";

// Without a password trystero derives the SDP key from appId + room id, which a
// relay operator can reverse. The room code is public in a shared URL, so this
// is a low bar -- but a hardcoded secret would be worse than a useless one, and
// nothing here is worth protecting. No TURN credential ever goes in this file:
// it would be plain text in dist/ the moment it built.
const ROOM_PASSWORD = "regatta-not-a-secret";

// Named explicitly, because trystero picks its relays deterministically from
// the appId -- and the two this appId happens to land on are duds: one answers
// every announce with `blocked: not authorized`, and an announce failure is a
// console.warn, not a rejected promise, so both peers sit in a room they think
// they joined and never discover each other. Also dropped: relay.damus.io
// (rate-limits at this send rate) and relay.nostr.place (demands proof of work).
const RELAYS = [
  "wss://nos.lol",
  "wss://relay.mostr.pub",
  "wss://purplerelay.com",
  "wss://nostr.data.haus",
];

/** Roughly 10 Hz. Slower than a frame by design; the trail smooths the gap. */
const SEND_EVERY_MS = 100;

/**
 * How far behind live the rival is drawn. Has to exceed ordinary jitter or the
 * trail runs dry and the boat stutters; much beyond this and a close finish
 * starts to feel wrong.
 */
const BUFFER_MS = 140;

/** What crosses the wire. Plain JSON -- no terrain, ever: both ends grow the
 *  same river from the room code, so the course costs zero bytes. */
export type Wire = {
  x: number;
  y: number;
  lean: number;
  capsizing: boolean;
  /** Their finished time in ms, once they have one. */
  done: number | null;
};

export type Pose = {
  x: number;
  y: number;
  lean: number;
  capsizing: boolean;
  /** Which peer this is -- stable for as long as they stay in the room, so a
   *  standings list can label rows consistently instead of by draw order. */
  id: string;
};

export type Net = {
  /** True once at least one real person is in the room. */
  readonly live: boolean;
  /**
   * The quickest run any rival has finished, or null while none have. The
   * verdict turns on this one: the fastest rival either beat you or did not,
   * however many boats were on the water.
   */
  readonly rivalFinishMs: number | null;
  /** Every finished rival's elapsed run, quickest first. */
  readonly rivalFinishTimes: number[];
  /** Where to draw each rival right now; empty when there is nobody to draw. */
  posesAt(now: number): Pose[];
  publish(wire: Wire, now: number): void;
};

/** A room nobody can join. What every failure path degrades to. */
function solo(): Net {
  return {
    live: false,
    rivalFinishMs: null,
    rivalFinishTimes: [],
    posesAt: () => [],
    publish: () => {},
  };
}

export function connectRoom(code: string, onChange: () => void): Net {
  // trystero reaches for `crypto.subtle` unconditionally, and that is undefined
  // on an insecure origin. The call throws inside a floating promise, so the
  // join never settles and nothing is ever logged -- checked up front instead,
  // because "silently hung" is the one failure mode this file must not have.
  if (!globalThis.isSecureContext || !navigator.onLine) return solo();

  let trails: Trails = new Map();
  let peers = 0;
  // Per peer, so a second finisher cannot clobber the first and a late joiner
  // cannot erase either.
  const finishes = new Map<string, number>();
  let send: ((wire: Wire) => void) | null = null;
  let lastSent = Number.NEGATIVE_INFINITY;
  let sentDone = false;

  const net: Net = {
    get live(): boolean {
      return peers > 0;
    },
    get rivalFinishMs(): number | null {
      return finishes.size === 0 ? null : Math.min(...finishes.values());
    },
    get rivalFinishTimes(): number[] {
      return [...finishes.values()].sort((a, b) => a - b);
    },
    posesAt(now: number): Pose[] {
      if (peers === 0) return [];
      const at = now - BUFFER_MS;
      const sampled = posesFrom(trails, at);
      trails = sampled.trails;
      return sampled.poses.map((s) => ({
        x: s.x,
        y: s.y,
        lean: s.lean,
        capsizing: s.capsizing,
        id: s.id,
      }));
    },
    publish(wire: Wire, now: number): void {
      if (!send) return;
      // A finish is the one packet that must not wait for the next tick -- and
      // must not then be resent every frame for the rest of the run.
      if (wire.done === null) sentDone = false;
      const urgent = wire.done !== null && !sentDone;
      if (!urgent && now - lastSent < SEND_EVERY_MS) return;
      sentDone = wire.done !== null;
      lastSent = now;
      send(wire);
    },
  };

  // Dynamically imported so a failure to even load the transport is contained
  // here rather than taking the game's bundle down with it.
  void (async () => {
    try {
      const { joinRoom } = await import("trystero");
      const room = joinRoom(
        {
          appId: APP_ID,
          password: ROOM_PASSWORD,
          relayConfig: { urls: RELAYS, redundancy: 4 },
        },
        code,
        // Reached when the two peers find each other but no candidate pair
        // connects -- a symmetric NAT on either side with no TURN to relay
        // through. Drop back to the pacer rather than leaving a dead rival.
        {
          onJoinError: () => {
            peers = 0;
            trails = new Map();
            finishes.clear();
            onChange();
          },
        },
      );

      const pose = room.makeAction<Wire>("pose");
      send = (wire) => void pose.send(wire);

      // The context carries the sender. Dropping it is what turns three boats
      // into one phantom: their snapshots interleave by arrival time and get
      // interpolated across, which fails silently because it still works.
      pose.onMessage = (wire, { peerId }) => {
        trails = recordSnapshot(trails, peerId, {
          t: performance.now(),
          x: wire.x,
          y: wire.y,
          lean: wire.lean,
          capsizing: wire.capsizing,
        });
        if (wire.done !== null && finishes.get(peerId) !== wire.done) {
          finishes.set(peerId, wire.done);
          onChange();
        }
      };

      room.onPeerJoin = (peerId) => {
        peers += 1;
        // Only this peer is reset: their old trail is a previous race, and
        // interpolating across the swap would drag their boat in from wherever
        // it stopped. Everyone else is mid-run and must not be touched.
        trails = forgetPeer(trails, peerId);
        finishes.delete(peerId);
        onChange();
      };

      room.onPeerLeave = (peerId) => {
        peers = Math.max(0, peers - 1);
        trails = forgetPeer(trails, peerId);
        finishes.delete(peerId);
        onChange();
      };
    } catch {
      // Nothing to say: from the player's side this is identical to an empty
      // room, and an empty room is the ordinary case.
    }
  })();

  return net;
}
