import { describe, expect, it } from "vitest";
import {
  connectLatencyMs,
  initialState,
  makeRoomCode,
  normaliseRoomCode,
  reduce,
  forgetPeer,
  posesFrom,
  recordSnapshot,
  roomFromHash,
  sampleTrail,
  trimTrail,
  type RoomEvent,
  type RoomState,
  type Snapshot,
  type Trails,
} from "../room.ts";

// Covers the pure connection logic only. Whether two browsers on two different
// networks actually reach each other is not assertable from Node -- that lives
// in docs/spike-multiplayer.md as measured findings from real devices.

const run = (events: RoomEvent[], from: RoomState = initialState()): RoomState =>
  events.reduce(reduce, from);

const joined = (at = 1_000): RoomEvent => ({ type: "join", selfId: "me", at });

describe("connection phases", () => {
  it("starts idle with nothing connected", () => {
    const state = initialState();
    expect(state.phase).toBe("idle");
    expect(state.peers).toEqual([]);
    expect(connectLatencyMs(state)).toBeNull();
  });

  it("goes joining -> waiting once the grace period settles with no peer", () => {
    expect(run([joined()]).phase).toBe("joining");
    expect(run([joined(), { type: "settled" }]).phase).toBe("waiting");
  });

  it("treats being alone in a room as waiting, never as a failure", () => {
    const state = run([joined(), { type: "settled" }, { type: "lonely" }]);
    // The distinction the UI depends on: suspicious, but not proven broken.
    expect(state.phase).toBe("waiting");
    expect(state.lonely).toBe(true);
    expect(state.failure).toBeNull();
  });

  it("connects when a peer arrives", () => {
    const state = run([
      joined(),
      { type: "settled" },
      { type: "peer-join", peerId: "them", at: 2_400 },
    ]);
    expect(state.phase).toBe("connected");
    expect(state.peers).toEqual(["them"]);
  });

  it("does not let a late lonely timer overwrite a live connection", () => {
    // The timer fires on a delay, so it can land after a peer already joined.
    const state = run([
      joined(),
      { type: "peer-join", peerId: "them", at: 2_000 },
      { type: "lonely" },
    ]);
    expect(state.phase).toBe("connected");
    expect(state.lonely).toBe(false);
  });
});

describe("peer registry", () => {
  it("ignores a duplicate peer-join instead of listing a peer twice", () => {
    const state = run([
      joined(),
      { type: "peer-join", peerId: "them", at: 2_000 },
      { type: "peer-join", peerId: "them", at: 2_500 },
    ]);
    expect(state.peers).toEqual(["them"]);
  });

  it("falls back to waiting when the last peer leaves", () => {
    const state = run([
      joined(),
      { type: "peer-join", peerId: "them", at: 2_000 },
      { type: "peer-leave", peerId: "them" },
    ]);
    expect(state.peers).toEqual([]);
    expect(state.phase).toBe("waiting");
  });

  it("stays connected while any peer remains", () => {
    const state = run([
      joined(),
      { type: "peer-join", peerId: "a", at: 2_000 },
      { type: "peer-join", peerId: "b", at: 2_100 },
      { type: "peer-leave", peerId: "a" },
    ]);
    expect(state.peers).toEqual(["b"]);
    expect(state.phase).toBe("connected");
  });
});

describe("connect latency", () => {
  it("measures from join to the first peer", () => {
    const state = run([
      joined(1_000),
      { type: "peer-join", peerId: "them", at: 2_400 },
    ]);
    expect(connectLatencyMs(state)).toBe(1_400);
  });

  it("keeps the first connection's timing when a second peer joins later", () => {
    const state = run([
      joined(1_000),
      { type: "peer-join", peerId: "a", at: 2_400 },
      { type: "peer-join", peerId: "b", at: 9_000 },
    ]);
    expect(connectLatencyMs(state)).toBe(1_400);
  });
});

describe("failure is recorded with a reason", () => {
  it("keeps the reason and detail so the UI can say what broke", () => {
    const state = run([
      joined(),
      { type: "fail", reason: "relay-unreachable", detail: "no relay answered" },
    ]);
    expect(state.phase).toBe("failed");
    expect(state.failure).toEqual({
      reason: "relay-unreachable",
      detail: "no relay answered",
    });
  });

  it("resets completely on leave", () => {
    const state = run([
      joined(),
      { type: "peer-join", peerId: "them", at: 2_000 },
      { type: "leave" },
    ]);
    expect(state).toEqual(initialState());
  });
});

describe("room codes", () => {
  // Injected RNG: the reason makeRoomCode takes `rand` instead of calling
  // Math.random itself is so this assertion can exist at all.
  it("builds a fixed-length code from the injected RNG", () => {
    expect(makeRoomCode(() => 0)).toBe("aaaaaa");
    const code = makeRoomCode(() => 0.5);
    expect(code).toHaveLength(6);
  });

  it("survives an RNG that returns exactly 1 without running off the alphabet", () => {
    expect(makeRoomCode(() => 1)).toBe("999999");
  });

  it("omits lookalike glyphs so a code survives being read aloud", () => {
    const code = makeRoomCode(() => 0.999999);
    expect(code).not.toMatch(/[01lio]/);
  });

  it("round-trips a generated code through a hash link", () => {
    const code = makeRoomCode(() => 0.42);
    expect(roomFromHash(`#r=${code}`)).toBe(code);
  });

  it("accepts a code typed with stray case, spaces or punctuation", () => {
    expect(normaliseRoomCode("  AB-CD 23 ")).toBe("abcd23");
  });

  it("rejects a code of the wrong length or with excluded glyphs", () => {
    expect(normaliseRoomCode("abc")).toBeNull();
    expect(normaliseRoomCode("abcdefg")).toBeNull();
    expect(normaliseRoomCode("abcd01")).toBeNull();
  });

  it("returns null for a hash with no usable room code", () => {
    expect(roomFromHash("")).toBeNull();
    expect(roomFromHash("#")).toBeNull();
    expect(roomFromHash("#r=")).toBeNull();
    expect(roomFromHash("#other=abcd23")).toBeNull();
  });

  it("finds the code when the hash carries other parameters too", () => {
    expect(roomFromHash("#debug=1&r=abcd23")).toBe("abcd23");
  });
});

// ---------------------------------------------------------------------------
// The rival's trail. What is drawn is never the newest snapshot: it is where
// the peer was BUFFER_MS ago, interpolated. These are the rules that turn 10 Hz
// of packets into a boat, and every one of them is a decision that could
// plausibly have gone the other way.
// ---------------------------------------------------------------------------

function snap(t: number, x: number, y: number, capsizing = false): Snapshot {
  return { t, x, y, lean: 0, capsizing };
}

describe("the rival's trail", () => {
  it("has nothing to draw before the first snapshot arrives", () => {
    expect(sampleTrail([], 1000)).toBeNull();
  });

  it("interpolates between the two snapshots straddling the moment asked for", () => {
    const trail = [snap(1000, 0, 10), snap(1100, 2, 14)];
    const at = sampleTrail(trail, 1050);
    expect(at?.x).toBeCloseTo(1);
    expect(at?.y).toBeCloseTo(12);
  });

  it("interpolates lean too, so a leaning peer doesn't snap upright between packets", () => {
    const trail = [
      { t: 0, x: 0, y: 0, lean: -1, capsizing: false },
      { t: 100, x: 0, y: 0, lean: 1, capsizing: false },
    ];
    expect(sampleTrail(trail, 50)?.lean).toBeCloseTo(0);
  });

  it("never extrapolates past the newest snapshot", () => {
    // The point of the whole render delay. A peer whose packets stop must hold
    // position: "the link dropped" and "they are still paddling" have to look
    // different, and a boat sailing on forever is the wrong one to show.
    const trail = [snap(1000, 0, 10), snap(1100, 2, 20)];
    const late = sampleTrail(trail, 9999);
    expect(late?.y).toBe(20);
    expect(late?.x).toBe(2);
  });

  it("holds at the oldest snapshot when asked for a moment before the trail starts", () => {
    const trail = [snap(1000, 5, 10), snap(1100, 6, 12)];
    expect(sampleTrail(trail, 0)?.y).toBe(10);
  });

  it("switches capsize state outright rather than crossfading it", () => {
    // A boat is either rolled over or it isn't; there is no half-capsized pose
    // to render, so this is the one field that must not be averaged.
    const trail = [snap(0, 0, 0, false), snap(100, 0, 0, true)];
    expect(sampleTrail(trail, 30)?.capsizing).toBe(false);
    expect(sampleTrail(trail, 70)?.capsizing).toBe(true);
  });

  it("survives two snapshots landing in the same millisecond", () => {
    const trail = [snap(500, 1, 1), snap(500, 3, 3)];
    expect(sampleTrail(trail, 500)?.x).toBe(3);
  });

  it("keeps the snapshot before the render time when trimming, not just the ones after", () => {
    // Dropping it would leave the render delay pointing past the front of the
    // trail every trim, and the rival would snap forward once a second.
    const trail = [snap(0, 0, 0), snap(100, 1, 1), snap(200, 2, 2), snap(300, 3, 3)];
    const kept = trimTrail(trail, 250);
    expect(kept[0].t).toBe(200);
    expect(kept.at(-1)?.t).toBe(300);
  });

  it("trims nothing when every snapshot is still needed", () => {
    const trail = [snap(100, 1, 1), snap(200, 2, 2)];
    expect(trimTrail(trail, 150)).toBe(trail);
  });

  it("interpolates identically before and after a trim", () => {
    // The property that makes trimming safe to do every frame.
    const trail = [snap(0, 0, 0), snap(100, 1, 1), snap(200, 2, 2), snap(300, 3, 3)];
    expect(sampleTrail(trimTrail(trail, 250), 250)?.x).toBeCloseTo(
      sampleTrail(trail, 250)?.x ?? Number.NaN,
    );
  });
});

// ---------------------------------------------------------------------------
// More than one rival. Every peer's snapshots arrive on the same callback, so
// the only thing that keeps three boats apart is the sender id. Get this wrong
// and nothing throws -- `sampleTrail` interpolates happily between two
// different people and draws one boat swinging across the river.
// ---------------------------------------------------------------------------

function record(entries: [string, Snapshot][]): Trails {
  return entries.reduce<Trails>(
    (trails, [peerId, s]) => recordSnapshot(trails, peerId, s),
    new Map(),
  );
}

describe("a river with more than one rival on it", () => {
  it("keeps each peer's snapshots on their own trail", () => {
    // Interleaved by arrival time, exactly as the transport delivers them.
    const trails = record([
      ["a", snap(0, -2, 0)],
      ["b", snap(0, 2, 0)],
      ["a", snap(100, -2, 10)],
      ["b", snap(100, 2, 10)],
    ]);
    const { poses } = posesFrom(trails, 50);
    expect(poses).toHaveLength(2);
    // Two boats holding their own sides of the river. Folded into one trail
    // this samples to a single boat somewhere near the middle instead.
    expect(poses.map((p) => p.x).sort((m, n) => m - n)).toEqual([-2, 2]);
    for (const pose of poses) expect(pose.y).toBeCloseTo(5);
    // A standings row is only as trustworthy as the id riding along with the
    // pose it's sorted by -- each one has to name the peer it actually came
    // from, not just land in the right place on the river.
    expect(poses.find((p) => p.x === -2)?.id).toBe("a");
    expect(poses.find((p) => p.x === 2)?.id).toBe("b");
  });

  it("skips a peer with nothing drawable yet rather than leaving a hole", () => {
    const trails = recordSnapshot(record([["a", snap(0, 1, 1)]]), "b", snap(0, 0, 0));
    expect(posesFrom(trails, 0).poses).toHaveLength(2);
    expect(posesFrom(new Map([["a", []]]), 0).poses).toEqual([]);
  });

  it("trims each peer's trail independently and samples the same either way", () => {
    const trails = record([
      ["a", snap(0, 0, 0)],
      ["a", snap(100, 1, 1)],
      ["a", snap(200, 2, 2)],
      ["b", snap(150, 9, 9)],
    ]);
    const once = posesFrom(trails, 150);
    const twice = posesFrom(once.trails, 150);
    expect(twice.poses).toEqual(once.poses);
    expect(once.trails.get("a")?.[0].t).toBe(100);
    expect(once.trails.get("b")).toHaveLength(1);
  });

  it("forgets one peer without disturbing anybody else's race", () => {
    // The bug this exists to stop: a third player joining used to wipe the
    // trail and the finish time of everyone already on the water.
    const trails = record([
      ["a", snap(0, 1, 1)],
      ["b", snap(0, 2, 2)],
    ]);
    const left = forgetPeer(trails, "b");
    expect(left.has("b")).toBe(false);
    expect(left.get("a")).toEqual(trails.get("a"));
  });

  it("leaves the map alone when asked to forget somebody who was never there", () => {
    const trails = record([["a", snap(0, 1, 1)]]);
    expect(forgetPeer(trails, "ghost")).toBe(trails);
  });

  it("does not mutate the trails it is given", () => {
    // Every caller holds the previous map for the length of a frame.
    const before = record([["a", snap(0, 1, 1)]]);
    recordSnapshot(before, "a", snap(100, 5, 5));
    recordSnapshot(before, "b", snap(100, 5, 5));
    forgetPeer(before, "a");
    expect(before.size).toBe(1);
    expect(before.get("a")).toHaveLength(1);
  });
});
