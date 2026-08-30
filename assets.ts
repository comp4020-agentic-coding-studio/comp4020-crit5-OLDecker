// Procedural Three.js geometry/material builders. No GLTF, no external asset
// fetching -- this project has zero external binary asset dependencies except
// public/card.png, and building procedurally matches that ethos and avoids
// unverifiable download pipelines.

import * as THREE from "three";

/**
 * Boat palettes. Warm hulls on purpose: the water is now a saturated daylight
 * blue, and the old paper-white/pale-blue pair (carried over from the 2D
 * renderer, where the water was near-black) sat close enough to the new water
 * in both hue and value to lose its silhouette at distance.
 */
export const PLAYER_HULL = "#ffc94f";
export const PLAYER_FOLD = "#e0743a";
export const RIVAL_HULL = "#ff8f6b";
export const RIVAL_FOLD = "#b8462c";

/** Where the hull meets the water, in the kayak group's local space. The group
 *  is placed at y=0 (the water plane), so everything below this is submerged
 *  and hidden by the opaque river -- which is what makes the boat read as
 *  sitting *in* the water rather than parked on a sheet of it. */
const WATERLINE = 0;

/** Top of the deck, local. Everything a paddler touches is placed off this. */
const DECK_Y = 0.062;

/** Deterministic scatter from an integer -- rocks must not jitter between builds. */
function noise(n: number): number {
  let t = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  t ^= t >>> 13;
  t = Math.imul(t, 0xc2b2ae35);
  return ((t ^ (t >>> 16)) >>> 0) / 4294967296;
}

/**
 * The same hash keyed by a *position* on a coarse grid rather than by a vertex
 * index. See buildRock for why the distinction is the whole bug.
 */
function noiseAt(x: number, y: number, z: number): number {
  const q = (v: number): number => Math.round(v * 1024);
  let h = 0x811c9dc5;
  for (const v of [q(x), q(y), q(z)]) {
    h ^= v & 0xffff;
    h = Math.imul(h, 0x01000193);
    h ^= (v >>> 16) & 0xffff;
    h = Math.imul(h, 0x01000193);
  }
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

/** A small seated paddler, so the boat reads as crewed rather than empty. */
function buildPaddler(shirtColor: string): THREE.Group {
  const paddler = new THREE.Group();

  const shirt = new THREE.MeshLambertMaterial({
    color: shirtColor,
    transparent: true,
  });
  const torso = new THREE.Mesh(
    new THREE.CylinderGeometry(0.052, 0.062, 0.13, 10),
    shirt,
  );
  torso.position.y = DECK_Y + 0.055;
  paddler.add(torso);

  const skin = new THREE.MeshLambertMaterial({
    color: "#e8b489",
    transparent: true,
  });
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.048, 12, 10), skin);
  head.position.y = DECK_Y + 0.155;
  paddler.add(head);

  // A wide brim reads as a hat from behind at any distance; a crown alone just
  // looks like a second, smaller head.
  const hatMat = new THREE.MeshLambertMaterial({
    color: "#f2e3bd",
    side: THREE.DoubleSide,
    transparent: true,
  });
  const brim = new THREE.Mesh(
    new THREE.CylinderGeometry(0.088, 0.088, 0.008, 14),
    hatMat,
  );
  brim.position.y = DECK_Y + 0.187;
  paddler.add(brim);
  const crown = new THREE.Mesh(
    new THREE.CylinderGeometry(0.042, 0.05, 0.045, 12),
    hatMat,
  );
  crown.position.y = DECK_Y + 0.208;
  paddler.add(crown);

  return paddler;
}

/**
 * A kayak hull (tapered pointed both ends, nose toward -Z), a seated paddler,
 * and a double-bladed paddle parented under `paddlePivot`. `paddlePivot` is
 * added as a child of the returned group here (at the grip point in front of
 * the paddler's chest), so the caller only needs to add `group` to the scene
 * and can animate the pivot directly via the returned reference.
 */
export function buildKayak(
  hullColor: string,
  foldColor: string,
): { group: THREE.Group; paddlePivot: THREE.Group } {
  const group = new THREE.Group();

  // Lens-shaped hull: a thin pointed oval, extruded and beveled, laid flat so
  // its length runs along local Z. THREE.Shape lives in an XY plane; rotate
  // the resulting mesh -90deg about X so that plane becomes XZ (length along Z).
  const length = 1.0;
  const beam = 0.23;
  const shape = new THREE.Shape();
  shape.moveTo(0, length / 2);
  shape.quadraticCurveTo(beam / 2, length * 0.32, beam / 2, 0);
  shape.quadraticCurveTo(beam / 2, -length * 0.32, 0, -length / 2);
  shape.quadraticCurveTo(-beam / 2, -length * 0.32, -beam / 2, 0);
  shape.quadraticCurveTo(-beam / 2, length * 0.32, 0, length / 2);

  const depth = 0.12;
  const hullGeo = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: true,
    bevelThickness: 0.03,
    bevelSize: 0.025,
    bevelSegments: 2,
    curveSegments: 12,
  });
  hullGeo.rotateX(-Math.PI / 2);
  const hullMat = new THREE.MeshLambertMaterial({
    color: hullColor,
    transparent: true,
  });
  const hull = new THREE.Mesh(hullGeo, hullMat);
  // Sits the hull so roughly its lower third is under WATERLINE. The river is
  // opaque, so that part is simply never drawn and the boat gains a waterline
  // for free -- no clipping plane, no transparency sorting.
  hull.position.y = WATERLINE - 0.058;
  group.add(hull);

  // A fold/rim accent around the cockpit -- a slim torus sitting on the deck.
  const rimGeo = new THREE.TorusGeometry(0.082, 0.014, 6, 16);
  rimGeo.rotateX(Math.PI / 2);
  const foldMat = new THREE.MeshLambertMaterial({
    color: foldColor,
    side: THREE.DoubleSide,
    transparent: true,
  });
  const rim = new THREE.Mesh(rimGeo, foldMat);
  rim.position.set(0, DECK_Y, 0.03);
  group.add(rim);

  // A fold-colour stripe running the length of the deck, echoing the old
  // paper-boat's centre crease.
  const stripe = new THREE.Mesh(
    new THREE.BoxGeometry(0.022, 0.008, length * 0.66),
    foldMat,
  );
  stripe.position.set(0, DECK_Y, -0.16);
  group.add(stripe);

  group.add(buildPaddler(foldColor));

  // The paddle: a thin shaft with a flattened blade at each end, parented
  // under a pivot at the grip point in front of the paddler's chest.
  const paddlePivot = new THREE.Group();
  paddlePivot.position.set(0, DECK_Y + 0.115, 0.045);

  const shaftLength = 0.66;
  const shaftGeo = new THREE.CylinderGeometry(0.013, 0.013, shaftLength, 8);
  shaftGeo.rotateZ(Math.PI / 2);
  const shaft = new THREE.Mesh(
    shaftGeo,
    new THREE.MeshLambertMaterial({ color: "#8a6a44", transparent: true }),
  );
  paddlePivot.add(shaft);

  const bladeGeo = new THREE.BoxGeometry(0.17, 0.012, 0.075);
  const bladeMat = new THREE.MeshLambertMaterial({
    color: foldColor,
    side: THREE.DoubleSide,
    transparent: true,
  });
  for (const side of [-1, 1]) {
    const blade = new THREE.Mesh(bladeGeo, bladeMat);
    blade.position.set(side * (shaftLength / 2), 0, 0);
    paddlePivot.add(blade);
  }

  group.add(paddlePivot);

  return { group, paddlePivot };
}

/**
 * A displaced icosahedron for a rough rock look.
 *
 * The displacement is keyed by the vertex's *position*, not its index, and
 * that is load-bearing: IcosahedronGeometry derives from PolyhedronGeometry,
 * which emits **non-indexed** geometry -- every triangle carries its own three
 * corners, so a corner shared by five faces exists as five separate vertices
 * at the same coordinates. Displacing by index gave those five copies five
 * different radii and tore the surface open, which is exactly the "stones have
 * holes" the rocks shipped with. Hashing a rounded position instead gives
 * every copy of a shared corner the same displacement, so the surface stays
 * closed. Rounding to a 1/1024 grid absorbs the float drift between copies;
 * the vertices themselves are ~0.3 apart, nowhere near that.
 *
 * Leaving the geometry non-indexed is deliberate -- computeVertexNormals on
 * non-indexed geometry produces flat per-face normals, which is the faceted
 * low-poly look this scene wants.
 */
export function buildRock(radius: number): THREE.Group {
  const group = new THREE.Group();
  const geo = new THREE.IcosahedronGeometry(1, 1);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i += 1) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const scale = 0.82 + noiseAt(x, y, z) * 0.36;
    pos.setXYZ(i, x * scale, y * scale, z * scale);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  // Squashed a little: a boulder in a river sits wider than it is tall, and it
  // keeps the rock from hiding the water behind it on this low camera.
  geo.scale(radius * 1.1, radius * 0.82, radius * 1.1);

  // Pale on purpose. A mid-grey albedo is a dark charcoal lump once the only
  // light reaching the camera-facing side is hemisphere fill, and a dark lump
  // in a bright blue-and-green scene reads as a hole in the water.
  const mat = new THREE.MeshLambertMaterial({ color: "#cbc6b6" });
  group.add(new THREE.Mesh(geo, mat));

  // A moss cap on the sunlit top. Cheap, but it is what stops a grey rock from
  // reading as a grey hole in a bright green-and-blue scene.
  const mossGeo = new THREE.SphereGeometry(
    radius * 0.86,
    10,
    6,
    0,
    Math.PI * 2,
    0,
    Math.PI * 0.42,
  );
  const moss = new THREE.Mesh(
    mossGeo,
    new THREE.MeshLambertMaterial({
      color: "#6f9c4a",
      side: THREE.DoubleSide,
    }),
  );
  moss.position.y = radius * 0.2;
  moss.scale.set(1, 0.6, 1);
  group.add(moss);

  return group;
}

/**
 * A horizontal tapered log spanning laterally. Built with its long axis along
 * local X (geometry rotated at construction time), so the caller can position
 * it directly with no further rotation.
 */
export function buildLog(half: number, r: number): THREE.Group {
  const group = new THREE.Group();
  const length = half * 2;

  const trunkGeo = new THREE.CylinderGeometry(r * 0.9, r, length, 10);
  // CylinderGeometry defaults to height along Y; rotate so height runs along X.
  trunkGeo.rotateZ(Math.PI / 2);
  const trunk = new THREE.Mesh(
    trunkGeo,
    new THREE.MeshLambertMaterial({ color: "#8a6244" }),
  );
  group.add(trunk);

  // A darker ring at each cut end for a log-end texture.
  const ringMat = new THREE.MeshLambertMaterial({
    color: "#5c3f28",
    side: THREE.DoubleSide,
  });
  for (const side of [-1, 1]) {
    const ringGeo = new THREE.CylinderGeometry(r * 0.72, r * 0.72, 0.02, 10);
    ringGeo.rotateZ(Math.PI / 2);
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.position.set(side * (length / 2), 0, 0);
    group.add(ring);
  }

  // Moss along the upstream face and a couple of stubs, so a log is not just a
  // brown cylinder. Deterministic placement: same log, same stubs, every load.
  const mossMat = new THREE.MeshLambertMaterial({ color: "#6f9c4a" });
  for (let i = 0; i < 3; i += 1) {
    const patch = new THREE.Mesh(new THREE.SphereGeometry(r * 0.55, 8, 6), mossMat);
    patch.position.set((noise(i * 7 + 1) * 2 - 1) * half * 0.8, r * 0.55, 0);
    patch.scale.set(1.6, 0.45, 0.9);
    group.add(patch);
  }
  const stub = new THREE.Mesh(
    new THREE.CylinderGeometry(r * 0.22, r * 0.3, r * 2.4, 6),
    new THREE.MeshLambertMaterial({ color: "#7a5537" }),
  );
  stub.position.set(half * 0.35, r * 0.9, 0);
  stub.rotation.z = 0.5;
  group.add(stub);

  return group;
}
