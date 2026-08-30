import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";

// Sensors: standards held to whatever the brief is, so these travel forward.
// `invariants.test.ts` is the template's; this file is mine.
const DIST = resolve("dist");

function files(dir: string = DIST): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  });
}

const shipped = new Set(
  files().map((path) => relative(DIST, path).split(sep).join("/")),
);

const pages = [...shipped]
  .filter((name) => name.endsWith(".html"))
  .map((name) => ({
    name,
    doc: new JSDOM(readFileSync(join(DIST, name), "utf8")).window.document,
  }));

/** Resolves a page-relative URL the way a browser does, or null if it isn't
 *  ours to check (absolute, protocol-relative, data:, #, mailto:). */
function localTarget(page: string, url: string): string | null {
  const href = url.trim();
  if (href === "" || /^([a-z][a-z0-9+.-]*:|\/\/|#)/i.test(href)) return null;
  const base = href.startsWith("/") ? "" : dirname(page);
  return join(base === "." ? "" : base, href.replace(/^\//, ""))
    .split(sep)
    .join("/");
}

// The trap this exists for: `invariants.test.ts` checks the card is *named*,
// and a name that doesn't resolve looks perfectly fine in the markup. The
// card URL resolves against the page naming it, so `./card.png` is correct at
// the root and wrong one directory down -- and the only place the mistake
// shows up is the course gallery, as a broken preview, after the deadline.
describe("sensor: local asset references resolve in the build", () => {
  it("checked at least one page", () => {
    expect(pages.length).toBeGreaterThan(0);
  });

  for (const { name, doc } of pages) {
    const refs: { what: string; url: string }[] = [
      ...[...doc.querySelectorAll("meta[property^='og:image']")].map((el) => ({
        what: `<meta ${el.getAttribute("property")}>`,
        url: el.getAttribute("content") ?? "",
      })),
      ...[...doc.querySelectorAll("meta[name^='twitter:image']")].map((el) => ({
        what: `<meta ${el.getAttribute("name")}>`,
        url: el.getAttribute("content") ?? "",
      })),
      ...[...doc.querySelectorAll("img[src], script[src]")].map((el) => ({
        what: `<${el.tagName.toLowerCase()} src>`,
        url: el.getAttribute("src") ?? "",
      })),
      ...[...doc.querySelectorAll("link[href]")].map((el) => ({
        what: `<link rel="${el.getAttribute("rel")}">`,
        url: el.getAttribute("href") ?? "",
      })),
    ];

    for (const { what, url } of refs) {
      const target = localTarget(name, url);
      if (target === null) continue;
      it(`${name}: ${what} → ${url}`, () => {
        expect(
          shipped.has(target) || existsSync(join(DIST, target)),
          `${name} points at "${url}", which resolves to dist/${target} — nothing was built there, so it 404s on the deployed site`,
        ).toBe(true);
      });
    }
  }
});
