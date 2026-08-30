// The banks: shore strips, vegetation, kangaroos and two ridgelines of hills.
//
// Everything here is built once at scene-init time from the river's own seed,
// so the same room code grows the same landscape on every machine -- the same
// property `river.ts` guarantees for the course itself.
//
// The vegetation is drawn as flat quads carrying a canvas-painted cutout
// texture: 2.5D, not 3D. Two consequences worth knowing:
//
//   - They face +Z (upstream, toward the camera) and are never re-oriented.
//     A real billboard tracks the camera every frame, which means one draw
//     call per plant; a fixed quad can be merged with every other quad sharing
//     its texture into a single BufferGeometry, so the whole treeline is three
//     draw calls instead of ~200. The camera only ever pans a couple of units
//     laterally across a 300-unit course, so the parallax error this trades
//     away is not visible.
//   - They are cut out with `alphaTest`, not blended with `transparent`. A
//     cutout writes depth normally, so hundreds of overlapping quads need no
//     back-to-front sorting and cannot draw over each other in the wrong
//     order.

import * as THREE from "three";
import type { River } from "./river.ts";
import { COURSE_LENGTH, centreAt, halfWidthAt, mulberry32 } from "./river.ts";

/** The ground plane's height. Everything on the bank stands on this. */
export const GROUND_Y = -0.05;

type Quad = { x: number; y: number; width: number; height: number };

function makeCanvas(w: number, h: number): CanvasRenderingContext2D {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d context for a scenery texture");
  return ctx;
}

function textureFrom(ctx: CanvasRenderingContext2D): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(ctx.canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

function blob(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  rot = 0,
): void {
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, ry, rot, 0, Math.PI * 2);
  ctx.fill();
}

/** A gum tree: pale leaning trunk, a few overlapping canopy blobs, sun on top. */
function treeTexture(): THREE.CanvasTexture {
  const w = 128;
  const h = 192;
  const ctx = makeCanvas(w, h);

  ctx.fillStyle = "#b9a184";
  ctx.beginPath();
  ctx.moveTo(w * 0.44, h);
  ctx.lineTo(w * 0.56, h);
  ctx.lineTo(w * 0.535, h * 0.46);
  ctx.lineTo(w * 0.465, h * 0.46);
  ctx.closePath();
  ctx.fill();
  // Two limbs, so the canopy looks carried rather than balanced.
  ctx.strokeStyle = "#b9a184";
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.moveTo(w * 0.5, h * 0.56);
  ctx.lineTo(w * 0.33, h * 0.42);
  ctx.moveTo(w * 0.5, h * 0.6);
  ctx.lineTo(w * 0.68, h * 0.44);
  ctx.stroke();

  const canopy: [number, number, number, number][] = [
    [0.5, 0.28, 0.33, 0.2],
    [0.29, 0.4, 0.22, 0.15],
    [0.71, 0.39, 0.23, 0.15],
    [0.44, 0.15, 0.22, 0.12],
    [0.62, 0.19, 0.2, 0.11],
  ];
  ctx.fillStyle = "#3f7a3a";
  for (const [cx, cy, rx, ry] of canopy) {
    blob(ctx, cx * w, cy * h, rx * w, ry * h);
  }
  ctx.fillStyle = "#66ab4f";
  for (const [cx, cy, rx, ry] of canopy) {
    blob(ctx, (cx - 0.03) * w, (cy - 0.035) * h, rx * w * 0.74, ry * h * 0.7);
  }
  ctx.fillStyle = "#8ecb68";
  blob(ctx, 0.42 * w, 0.2 * h, 0.15 * w, 0.08 * h);

  return textureFrom(ctx);
}

/** A low shrub. Three blobs and a highlight is enough at this distance. */
function bushTexture(): THREE.CanvasTexture {
  const w = 128;
  const h = 96;
  const ctx = makeCanvas(w, h);

  const lumps: [number, number, number, number][] = [
    [0.5, 0.62, 0.42, 0.36],
    [0.26, 0.74, 0.24, 0.24],
    [0.75, 0.72, 0.25, 0.26],
  ];
  ctx.fillStyle = "#3c7538";
  for (const [cx, cy, rx, ry] of lumps) blob(ctx, cx * w, cy * h, rx * w, ry * h);
  ctx.fillStyle = "#5da24a";
  for (const [cx, cy, rx, ry] of lumps) {
    blob(ctx, (cx - 0.02) * w, (cy - 0.06) * h, rx * w * 0.76, ry * h * 0.72);
  }
  ctx.fillStyle = "#f0e07a";
  for (const i of [0, 1, 2, 3]) {
    blob(ctx, (0.3 + i * 0.15) * w, (0.5 + (i % 2) * 0.12) * h, 3, 3);
  }

  return textureFrom(ctx);
}

/**
 * A kangaroo, side-on and facing downstream. Built from overlapping filled
 * ellipses rather than one outline path: at the size these actually render
 * (roughly a centimetre of screen, on the far bank, behind fog) the silhouette
 * is the entire read, and overlapping ellipses give a reliable silhouette
 * without hand-tuning bezier control points that nobody will ever see.
 */
function kangarooTexture(): THREE.CanvasTexture {
  const s = 128;
  const ctx = makeCanvas(s, s);

  const body = "#a9663c";
  const shade = "#8a4f2c";
  const belly = "#cf9a6b";

  ctx.fillStyle = shade;
  // Tail: thick at the root, tapering to the ground behind.
  ctx.beginPath();
  ctx.moveTo(6, 112);
  ctx.quadraticCurveTo(30, 118, 52, 104);
  ctx.lineTo(60, 88);
  ctx.quadraticCurveTo(32, 102, 10, 102);
  ctx.closePath();
  ctx.fill();
  blob(ctx, 50, 104, 28, 9); // the long flat foot

  ctx.fillStyle = body;
  blob(ctx, 56, 80, 21, 23); // haunch
  blob(ctx, 74, 60, 18, 24, -0.35); // barrel
  blob(ctx, 88, 40, 10, 14, -0.3); // neck
  blob(ctx, 98, 27, 13, 9, -0.15); // head
  blob(ctx, 109, 29, 6, 5); // muzzle
  blob(ctx, 93, 13, 4, 10, 0.18); // ears
  blob(ctx, 101, 14, 4, 10, 0.36);
  blob(ctx, 86, 60, 4, 10, 0.6); // forearm

  ctx.fillStyle = belly;
  blob(ctx, 78, 73, 9, 13, -0.3);

  ctx.fillStyle = "#2b1a10";
  blob(ctx, 100, 24, 2.2, 2.2);

  return textureFrom(ctx);
}

/**
 * Merges a list of upright quads into one geometry. All of them face +Z, which
 * is where the chase camera always is.
 */
function billboardField(quads: Quad[], texture: THREE.Texture): THREE.Mesh {
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  for (const q of quads) {
    const base = positions.length / 3;
    const hw = q.width / 2;
    const z = -q.y;
    positions.push(
      q.x - hw, GROUND_Y, z,
      q.x + hw, GROUND_Y, z,
      q.x + hw, GROUND_Y + q.height, z,
      q.x - hw, GROUND_Y + q.height, z,
    );
    uvs.push(0, 0, 1, 0, 1, 1, 0, 1);
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();

  const material = new THREE.MeshBasicMaterial({
    map: texture,
    // Cutout, not blend: writes depth, needs no sorting. See the file header.
    alphaTest: 0.5,
    side: THREE.DoubleSide,
    fog: true,
  });

  return new THREE.Mesh(geometry, material);
}

/**
 * A sand strip hugging each bank, so the water ends somewhere instead of
 * meeting an unbroken green plane at a hard line.
 */
function shoreStrips(): THREE.Mesh {
  const positions: number[] = [];
  const indices: number[] = [];
  const width = 0.55;

  for (const side of [-1, 1]) {
    const first = positions.length / 3;
    let row = 0;
    for (let y = -4; y <= COURSE_LENGTH + 6; y += 2) {
      const edge = centreAt(y) + side * halfWidthAt(y);
      const outer = edge + side * width;
      positions.push(edge, GROUND_Y + 0.004, -y, outer, GROUND_Y + 0.02, -y);
      if (row > 0) {
        const a = first + (row - 1) * 2;
        indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
      row += 1;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();

  return new THREE.Mesh(
    geometry,
    new THREE.MeshBasicMaterial({
      color: "#ddc79a",
      side: THREE.DoubleSide,
      fog: true,
    }),
  );
}

/**
 * A ridgeline running the length of the course on each side. Real geometry
 * rather than something painted on the sky dome, because the dome rides with
 * the camera and would give the hills no parallax at all -- which is precisely
 * the cue that sells distance.
 */
function ridge(
  distance: number,
  low: number,
  high: number,
  color: string,
  phase: number,
): THREE.Mesh {
  const positions: number[] = [];
  const indices: number[] = [];

  for (const side of [-1, 1]) {
    const first = positions.length / 3;
    let row = 0;
    for (let y = -40; y <= COURSE_LENGTH + 80; y += 8) {
      const t = y * 0.021 + phase + (side < 0 ? 3.1 : 0);
      const crest =
        low +
        (high - low) *
          (0.5 + 0.32 * Math.sin(t) + 0.18 * Math.sin(t * 2.37 + 1.1));
      const x = side * distance;
      positions.push(x, GROUND_Y, -y, x, GROUND_Y + crest, -y);
      if (row > 0) {
        const a = first + (row - 1) * 2;
        indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
      row += 1;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();

  return new THREE.Mesh(
    geometry,
    new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, fog: true }),
  );
}

/** Everything that lives outside the water. One group, added to the scene once. */
export function buildScenery(river: River): THREE.Group {
  const group = new THREE.Group();
  const rand = mulberry32(river.seed ^ 0x5eed1eaf);

  group.add(ridge(78, 5, 15, "#7fa2b4", 0));
  group.add(ridge(34, 2.2, 6.5, "#4f8552", 2.4));
  group.add(shoreStrips());

  const trees: Quad[] = [];
  const bushes: Quad[] = [];
  const roos: Quad[] = [];

  // One pass, one PRNG stream, in a fixed order -- the whole bank is a pure
  // function of the seed, exactly like the course.
  for (let y = -6; y <= COURSE_LENGTH + 10; y += 1.5) {
    for (const side of [-1, 1]) {
      const edge = centreAt(y) + side * halfWidthAt(y);
      const roll = rand();
      const away = 0.9 + rand() * 8.5;
      const x = edge + side * away;

      if (roll < 0.24) {
        // Set back from the water, unlike the bushes. A 3.5-unit tree standing
        // one unit off a bank the camera passes within two of fills a quarter
        // of the frame with flat dark canopy on the way past -- close parallax
        // is worth having, an unreadable green corner is not. Bushes are short
        // enough to sit right on the shore and never do this.
        const height = 1.9 + rand() * 1.6;
        trees.push({
          x: edge + side * (2.6 + away * 0.9),
          y,
          width: height * (128 / 192),
          height,
        });
      } else if (roll < 0.62) {
        const height = 0.34 + rand() * 0.34;
        bushes.push({ x, y, width: height * (128 / 96), height });
      } else if (roll < 0.645) {
        // Kangaroos keep out of the treeline and off the waterline both.
        const height = 0.95 + rand() * 0.35;
        roos.push({ x: edge + side * (2.2 + rand() * 5), y, width: height, height });
      }
    }
  }

  group.add(billboardField(trees, treeTexture()));
  group.add(billboardField(bushes, bushTexture()));
  group.add(billboardField(roos, kangarooTexture()));

  return group;
}
