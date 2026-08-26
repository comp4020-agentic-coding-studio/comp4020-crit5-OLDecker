import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";

// crit 5 — "A game": https://comp.anu.edu.au/courses/comp4020-agentic-coding-studio/crits/05-game/
//
// Most of this week's spec is judged live, cold, by a pod: whether the opening
// screen makes the first move obvious with zero on-screen instructions,
// whether a stranger reaches an ending inside five minutes, whether one rule
// feels fair rather than just being enforced. None of that is testable
// statically — these two lines have a real structural contract, so they're
// asserted here.
//
// Still to add once the mechanic exists: a focused test on the one rule the
// spec asks for (e.g. "a collision ends the round") — that one can't be
// written until there's a rule to point it at.

const doc = new JSDOM(readFileSync(resolve("dist/index.html"), "utf8")).window
  .document;

describe("crit 5: a game", () => {
  it("gives the player something to act on immediately, not just a page of text", () => {
    const controls = doc.querySelectorAll(
      'main button, main input, main canvas, main [role="button"], main [tabindex]',
    );
    expect(
      controls.length,
      "no interactive/focusable surface found in <main> — a game with no tutorial still needs an obvious first move to make, for a mouse, keyboard or touch player alike",
    ).toBeGreaterThan(0);
  });

  it("teaches itself: no on-screen instructions, help text or how-to-play copy", () => {
    const text = doc.body.textContent?.toLowerCase() ?? "";
    const bannedPhrases = [
      "how to play",
      "instructions",
      "controls:",
      "use the arrow keys",
      "click to start",
      "press space",
    ];
    const found = bannedPhrases.filter((phrase) => text.includes(phrase));
    expect(
      found,
      `found instructional copy on the page: ${found.join(", ")} — the opening screen has to teach the first move through affordance, not words`,
    ).toEqual([]);
  });
});
