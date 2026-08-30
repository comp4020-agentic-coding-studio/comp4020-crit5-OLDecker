import { describe, expect, it } from "vitest";
import { BOAT_RADIUS, touchesLog, touchesRock } from "../regatta.ts";
import {
  COURSE_LENGTH,
  OPENING_CALM,
  buildRiver,
  centreAt,
  halfWidthAt,
  mulberry32,
  seedFromCode,
} from "../river.ts";

// The whole peer-to-peer model rests on one property: two browsers that only
// agree on a six-character room code must derive byte-identical water. If these
// go red, the boats are racing different rivers and nothing downstream matters.

describe("the river is a pure function of its seed", () => {
  it("builds the same course twice", () => {
    expect(buildRiver(12345)).toEqual(buildRiver(12345));
  });

  it("builds a different course from a different seed", () => {
    expect(buildRiver(12345).rocks).not.toEqual(buildRiver(12346).rocks);
  });

  it("derives a stable seed from a room code", () => {
    expect(seedFromCode("qw3rty")).toBe(seedFromCode("qw3rty"));
    expect(seedFromCode("qw3rty")).not.toBe(seedFromCode("qw3rtz"));
  });

  it("draws numbers in [0, 1)", () => {
    const rand = mulberry32(7);
    for (let i = 0; i < 500; i += 1) {
      const value = rand();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});

// A handful of seeds rather than one, so a passing course isn't a lucky one.
const SEEDS = [1, 2, 99, 4242, seedFromCode("lantern")];

describe("every generated course is fair", () => {
  for (const seed of SEEDS) {
    const river = buildRiver(seed);

    describe(`seed ${seed}`, () => {
      it("puts nothing in the opening stretch", () => {
        // Somewhere to find the paddle before the river asks for anything.
        for (const rock of river.rocks) {
          expect(rock.y).toBeGreaterThanOrEqual(OPENING_CALM);
        }
        for (const log of river.logs) {
          expect(log.y).toBeGreaterThanOrEqual(OPENING_CALM);
        }
      });

      it("keeps every rock inside the banks", () => {
        for (const rock of river.rocks) {
          const offset = Math.abs(rock.x - centreAt(rock.y));
          expect(offset + rock.r).toBeLessThanOrEqual(halfWidthAt(rock.y));
        }
      });

      it("keeps every log inside the banks", () => {
        for (const log of river.logs) {
          const nearEdge = Math.abs(log.x - centreAt(log.y)) + log.half;
          expect(nearEdge).toBeLessThanOrEqual(halfWidthAt(log.y));
        }
      });

      it("gives the course something to dodge", () => {
        expect(river.rocks.length).toBeGreaterThan(8);
      });

      it("always leaves a line the boat fits through", () => {
        // Checked against the same predicate the race collides with, at every
        // half-unit of the course. Lateral reach isn't in question: stations sit
        // at least 11 units apart, which is ~2s of travel, and the boat can
        // cross the whole 2-unit-wide river in well under that.
        for (let y = 0; y <= COURSE_LENGTH; y += 0.5) {
          const centre = centreAt(y);
          const reach = halfWidthAt(y) - BOAT_RADIUS;
          let clear = false;
          for (let i = 0; i <= 400 && !clear; i += 1) {
            const x = centre - reach + (2 * reach * i) / 400;
            if (!touchesRock(river, x, y) && !touchesLog(river, x, y)) clear = true;
          }
          expect(clear, `no passable line at y=${y}`).toBe(true);
        }
      });
    });
  }
});
