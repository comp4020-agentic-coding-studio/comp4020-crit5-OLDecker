import { describe, expect, it } from "vitest";
import type { Input, Race } from "../regatta.ts";
import {
  BOAT_RADIUS,
  CAPSIZE_MS,
  IDLE,
  channelLine,
  initialRace,
  outcome,
  pacerPose,
  pacerTargetMs,
  step,
} from "../regatta.ts";
import type { River } from "../river.ts";
import { COURSE_LENGTH, ROCK_RADIUS, centreAt, halfWidthAt } from "../river.ts";

// The rule this week's spec asks to be covered by a focused test is the one the
// whole race turns on: hitting a rock capsizes you, and a capsize costs you the
// race rather than the run. Everything below exists to hold that rule honest --
// that it fires, that it takes control away, that it gives control back on
// schedule, and that it actually loses you ground.

const STEP_MS = 20;
const PADDLE_ON: Input = { paddling: true, steer: 0 };

const EMPTY: River = { seed: 0, rocks: [] };

/**
 * A single rock on the exact line a boat holds when it paddles straight from
 * the start. Placing it at `centreAt(y)` instead would make the test depend on
 * how far the meander has wandered by `y`, which is a fact about the scenery,
 * not about the rule being tested.
 */
function riverWithRockAt(y: number): River {
  return { seed: 0, rocks: [{ x: centreAt(0), y, r: ROCK_RADIUS }] };
}

function run(river: River, race: Race, ms: number, input: Input): Race {
  let next = race;
  for (let t = 0; t < ms; t += STEP_MS) next = step(river, next, input, STEP_MS);
  return next;
}

describe("the rule: a rock capsizes the boat", () => {
  it("capsizes a boat that paddles into a rock", () => {
    const river = riverWithRockAt(12);
    const after = run(river, initialRace(), 3000, PADDLE_ON);

    expect(after.boat.capsizes).toBe(1);
  });

  it("leaves the same boat upright on open water", () => {
    // Same input, same distance, no rock: proves the capsize came from the rock
    // and not from the physics drifting the boat into a bank.
    const after = run(EMPTY, initialRace(), 3000, PADDLE_ON);

    expect(after.boat.capsizes).toBe(0);
    expect(after.boat.capsizeMs).toBe(0);
  });

  it("costs the player ground", () => {
    const clean = run(EMPTY, initialRace(), 3000, PADDLE_ON);
    const hit = run(riverWithRockAt(12), initialRace(), 3000, PADDLE_ON);

    expect(hit.boat.y).toBeLessThan(clean.boat.y);
  });
});

describe("a capsize takes control away, then gives it back", () => {
  const capsized = run(riverWithRockAt(12), initialRace(), 3000, PADDLE_ON);

  it("actually is capsized, so the assertions below mean something", () => {
    expect(capsized.boat.capsizeMs).toBeGreaterThan(0);
  });

  it("ignores steering entirely while upside down", () => {
    const left = step(EMPTY, capsized, { paddling: true, steer: -1 }, STEP_MS);
    const right = step(EMPTY, capsized, { paddling: true, steer: 1 }, STEP_MS);

    // Identical outcomes from opposite inputs is the strongest possible
    // statement that the input was not read.
    expect(left.boat).toEqual(right.boat);
  });

  it("rights itself once the capsize window has elapsed, and not before", () => {
    const justBefore = run(EMPTY, capsized, capsized.boat.capsizeMs - STEP_MS, IDLE);
    expect(justBefore.boat.capsizeMs).toBeGreaterThan(0);

    const justAfter = step(EMPTY, justBefore, IDLE, STEP_MS * 2);
    expect(justAfter.boat.capsizeMs).toBe(0);
  });

  it("steers again after recovering", () => {
    const upright = run(EMPTY, capsized, CAPSIZE_MS + STEP_MS, IDLE);
    const turned = step(EMPTY, upright, { paddling: true, steer: 1 }, STEP_MS);

    expect(turned.boat.x).toBeGreaterThan(upright.boat.x);
  });
});

describe("the banks", () => {
  it("capsize a boat that runs aground, and keep it in the water", () => {
    const after = run(EMPTY, initialRace(), 4000, { paddling: true, steer: 1 });

    expect(after.boat.capsizes).toBeGreaterThan(0);
    const offset = Math.abs(after.boat.x - centreAt(after.boat.y));
    expect(offset).toBeLessThanOrEqual(halfWidthAt(after.boat.y) - BOAT_RADIUS + 1e-9);
  });

  it("never let the boat outside the river, however hard it is steered", () => {
    let race = initialRace();
    for (let t = 0; t < 20_000; t += STEP_MS) {
      race = step(EMPTY, race, { paddling: true, steer: t % 2000 < 1000 ? 1 : -1 }, STEP_MS);
      const offset = Math.abs(race.boat.x - centreAt(race.boat.y));
      expect(offset).toBeLessThanOrEqual(halfWidthAt(race.boat.y) - BOAT_RADIUS + 1e-9);
    }
  });
});

describe("the fast channel is worth finding", () => {
  it("carries a boat further than the slack water does", () => {
    const y = 120;
    const base = initialRace();
    const inChannel: Race = { ...base, started: true, boat: { ...base.boat, x: channelLine(y), y } };
    const inSlack: Race = {
      ...base,
      started: true,
      // The far side of the river from the channel, just short of the bank.
      boat: { ...base.boat, x: centreAt(y) - Math.sign(channelLine(y) - centreAt(y)) * (halfWidthAt(y) - BOAT_RADIUS), y },
    };

    const fast = step(EMPTY, inChannel, PADDLE_ON, 1000);
    const slow = step(EMPTY, inSlack, PADDLE_ON, 1000);

    expect(fast.boat.y - y).toBeGreaterThan(slow.boat.y - y);
  });
});

describe("the clock", () => {
  it("does not start until the player does something", () => {
    const drifting = run(EMPTY, initialRace(), 5000, IDLE);

    expect(drifting.elapsedMs).toBe(0);
    expect(drifting.started).toBe(false);
    // The boat still moves, so the opening screen is alive rather than paused.
    expect(drifting.boat.y).toBeGreaterThan(0);
  });

  it("shortens the pacer's deadline by however far you drifted first", () => {
    const drifting = run(EMPTY, initialRace(), 5000, IDLE);
    const started = step(EMPTY, drifting, PADDLE_ON, STEP_MS);

    expect(started.startY).toBeCloseTo(drifting.boat.y, 6);
    expect(pacerTargetMs(started.startY)).toBeLessThan(pacerTargetMs(0));
  });
});

describe("the finish", () => {
  const finished = run(EMPTY, initialRace(), 120_000, PADDLE_ON);

  it("is reached, and records when", () => {
    expect(finished.finishedMs).not.toBeNull();
    expect(finished.boat.y).toBe(COURSE_LENGTH);
  });

  it("freezes the race, so a finished boat cannot drift past the bend", () => {
    expect(step(EMPTY, finished, PADDLE_ON, 1000)).toBe(finished);
  });
});

describe("the pacer", () => {
  it("only ever moves downstream", () => {
    let previous = -1;
    for (let t = 0; t <= pacerTargetMs(0); t += 250) {
      const { y } = pacerPose(t, 0);
      expect(y).toBeGreaterThanOrEqual(previous);
      previous = y;
    }
  });

  it("arrives exactly on its deadline", () => {
    expect(pacerPose(pacerTargetMs(0), 0).y).toBeCloseTo(COURSE_LENGTH, 6);
  });

  it("rides the fast channel, which is the only hint anyone gets about it", () => {
    const { x, y } = pacerPose(20_000, 0);
    expect(x).toBeCloseTo(channelLine(y), 6);
  });
});

describe("who won", () => {
  it("agrees with itself from either boat's point of view", () => {
    expect(outcome(40_000, 42_000)).toBe("won");
    expect(outcome(42_000, 40_000)).toBe("lost");
    expect(outcome(41_000, 41_000)).toBe("tied");
  });
});
