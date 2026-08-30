import { describe, expect, it } from "vitest";
import {
  connectLatencyMs,
  initialState,
  makeRoomCode,
  normaliseRoomCode,
  reduce,
  roomFromHash,
  type RoomEvent,
  type RoomState,
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
