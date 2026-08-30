// The river surface, built once as a custom-shaded mesh -- the course is
// finite and fully determined by `river` at scene-init time, so there is no
// reason to rebuild geometry per frame. Motion comes entirely from the
// shaders' `uTime` uniform.

import * as THREE from "three";
import type { River } from "./river.ts";
import { COURSE_LENGTH, centreAt, flowAt, halfWidthAt } from "./river.ts";

const ROW_STEP = 1.0;
const COLUMNS = 13;

export type WaterUniforms = {
  uTime: { value: number };
  /** The player's hull in world XZ, for the wake. */
  uBoat: { value: THREE.Vector2 };
};

/**
 * The vertex shader's bob, evaluated on the CPU. Anything that has to float --
 * a hull, a lantern -- takes its height from here so it rides the surface the
 * shader actually draws instead of a flat plane through the middle of it.
 *
 * This duplicates one line of GLSL, and the duplicate is load-bearing: if you
 * change the bob in VERTEX_SHADER, change it here in the same commit or the
 * boat will float above or sink into its own wake.
 */
export function waterHeightAt(x: number, z: number, timeSeconds: number): number {
  return Math.sin(x * 3.1 + z * 2.3 + timeSeconds * 1.1) * 0.018;
}

const VERTEX_SHADER = /* glsl */ `
  #include <fog_pars_vertex>

  attribute float aFlow;
  attribute float aEdge;
  varying float vFlow;
  varying float vEdge;
  varying vec3 vWorldPos;
  uniform float uTime;

  void main() {
    vFlow = aFlow;
    vEdge = aEdge;
    vec3 pos = position;
    pos.y += sin(position.x * 3.1 + position.z * 2.3 + uTime * 1.1) * 0.018;
    vec4 world = modelMatrix * vec4(pos, 1.0);
    vWorldPos = world.xyz;
    // Named mvPosition because three's fog_vertex chunk reads that exact name.
    vec4 mvPosition = viewMatrix * world;
    gl_Position = projectionMatrix * mvPosition;

    #include <fog_vertex>
  }
`;

// Cel-shaded, in the toon/Ghibli register the brief asked for: the surface is
// quantised into three flat blues by a slow swell, and a caustic net is laid
// over the top in near-white. Notes on what is deliberate here:
//
//   - The quantisation uses a very narrow `smoothstep` rather than `step`. A
//     hard `step` is what gives the look, but on a surface running 300 units
//     to the horizon it aliases into crawling speckle at grazing angles; a
//     0.02-wide ramp is visually a hard edge and resolves cleanly.
//   - Three octaves at deliberately non-harmonic frequencies, so the sum never
//     lines up into a repeating front the eye can lock onto. This is what the
//     original "white stripes" complaint was actually about: the old canvas
//     renderer scrolled one global phase, so every streak reset in lockstep.
//   - Frequency is high ACROSS the river (x) and lower ALONG it (z), so detail
//     stretches downstream like real surface streaks. An early attempt had
//     this backwards -- ~0.9 rad/unit across a river barely 2 units wide is
//     nearly constant laterally, which turned the foam into a few huge washes
//     rather than fixing the stripes.
//   - Scroll speed is scaled per-fragment by flowAt(), so the fast channel and
//     the slack water at the banks never move as one sheet.
const FRAGMENT_SHADER = /* glsl */ `
  #include <fog_pars_fragment>

  varying float vFlow;
  varying float vEdge;
  varying vec3 vWorldPos;
  uniform float uTime;
  uniform vec2 uBoat;

  const vec3 DEEP  = vec3(0.055, 0.400, 0.639);
  const vec3 MID   = vec3(0.106, 0.561, 0.847);
  const vec3 SHOAL = vec3(0.310, 0.702, 0.925);
  const vec3 FOAM  = vec3(0.918, 0.976, 1.000);

  /** A hard cel edge that still antialiases. */
  float band(float v, float edge) {
    return smoothstep(edge - 0.02, edge + 0.02, v);
  }

  void main() {
    vec2 p = vWorldPos.xz;
    float flow = clamp(vFlow, 0.0, 1.0);
    float t = uTime;
    float dist = length(vWorldPos - cameraPosition);

    // A pattern fixed in world space is drawn at wildly different screen scales
    // down a 300-unit river, and it fails at both ends: right under the camera a
    // caustic cell is over a metre wide and smears across a third of the frame,
    // while downstream it undersamples into crawling white confetti. Neither is
    // a shader bug -- the maths is identical everywhere, it is the sampling that
    // changes -- so the fix is to only draw the detail across the band of
    // distances where it is actually legible, which is also the band the eye is
    // in. Everything outside it relaxes to flat cel blue, and the fog takes it
    // from there.
    float detail = smoothstep(1.7, 4.6, dist) * (1.0 - smoothstep(17.0, 42.0, dist));

    float scroll = t * (0.55 + flow * 0.85);
    float s1 = sin(p.x * 1.9 + p.y * 0.7 + scroll * 1.10);
    float s2 = sin(p.x * 3.1 - p.y * 1.3 - scroll * 0.83 + 2.1);
    float s3 = sin(p.x * 0.9 + p.y * 2.2 + scroll * 0.61 + 4.7);
    float swell = (s1 * 0.44 + s2 * 0.33 + s3 * 0.23) * 0.5 + 0.5;

    vec3 col = DEEP;
    col = mix(col, MID,   band(swell, 0.36));
    col = mix(col, SHOAL, band(swell, 0.68));

    // Two crossed ridged waves. (1 - |sin|) peaks along a line rather than at a
    // point, so their product is a net of bright cells -- the caustic web in
    // the reference, without a texture or a noise table.
    float cs = t * (0.8 + flow * 1.4);
    float c1 = sin(p.x * 5.3 + p.y * 2.3 + cs * 1.3);
    float c2 = sin(p.x * 2.9 - p.y * 4.6 - cs * 0.97 + 1.7);
    float net = (1.0 - abs(c1)) * (1.0 - abs(c2));
    col = mix(col, FOAM, smoothstep(0.58, 0.78, net) * (0.20 + flow * 0.28) * detail);

    // Lace along the banks, where the water is slack and shallow.
    float lace = smoothstep(0.87, 1.0, vEdge) *
                 (0.55 + 0.45 * sin(p.y * 5.0 - t * 1.6));
    col = mix(col, FOAM, lace * 0.42 * detail);

    // Far water settles toward one flat blue. Cel bands read as bands only
    // while a band is several pixels wide; at the vanishing point they collapse
    // into a shimmering moire that no amount of smoothstep width fixes.
    col = mix(col, MID, smoothstep(22.0, 60.0, dist) * 0.8);

    // The player's wake. d.y > 0 is upstream of the hull -- downstream is -Z,
    // so water the boat has already passed sits at a greater z than the boat.
    vec2 d = p - uBoat;
    float behind = d.y;
    float arm = abs(abs(d.x) - 0.055 - behind * 0.34);
    float trail = smoothstep(2.6, 0.1, behind) * step(-0.05, behind);
    float wakeV = smoothstep(0.07, 0.012, arm) * trail;
    wakeV *= 0.75 + 0.25 * sin(behind * 9.0 - t * 5.0);
    // Kept deliberately low. The wake sits closer to the camera than anything
    // else in the frame, so a strength that looks right in world units reads as
    // two white searchlights on screen -- the first pass ran it at 0.9 and it
    // was the loudest thing in the picture, louder than the boat making it.
    float hull = smoothstep(0.24, 0.09, length(d));
    col = mix(col, FOAM, clamp(wakeV * 0.5 + hull * 0.45, 0.0, 1.0));

    gl_FragColor = vec4(col, 1.0);

    #include <fog_fragment>
  }
`;

export function buildWaterMesh(_river: River): {
  mesh: THREE.Mesh;
  uniforms: WaterUniforms;
} {
  // The grid shape comes entirely from river.ts's pure centreAt/halfWidthAt/
  // flowAt functions, keyed by y alone -- river.rocks/river.logs aren't needed
  // here. The parameter is kept (and still typed River) to match the required
  // signature and in case a future pass wants seed-specific water variation.
  const rows: number[] = [];
  for (let y = -2; y <= COURSE_LENGTH + 2; y += ROW_STEP) rows.push(y);

  const positions: number[] = [];
  const flows: number[] = [];
  const edges: number[] = [];
  const indices: number[] = [];

  for (let ri = 0; ri < rows.length; ri += 1) {
    const y = rows[ri];
    const centre = centreAt(y);
    const hw = halfWidthAt(y);
    const left = centre - hw;
    const right = centre + hw;
    for (let ci = 0; ci < COLUMNS; ci += 1) {
      const t = ci / (COLUMNS - 1);
      const x = left + (right - left) * t;
      positions.push(x, 0, -y);
      flows.push(flowAt(x, y));
      edges.push(Math.abs(t * 2 - 1));
    }
    if (ri > 0) {
      const prevBase = (ri - 1) * COLUMNS;
      const base = ri * COLUMNS;
      for (let ci = 0; ci < COLUMNS - 1; ci += 1) {
        const a = prevBase + ci;
        const b = prevBase + ci + 1;
        const c = base + ci;
        const d = base + ci + 1;
        indices.push(a, c, b, b, c, d);
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("aFlow", new THREE.Float32BufferAttribute(flows, 1));
  geometry.setAttribute("aEdge", new THREE.Float32BufferAttribute(edges, 1));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();

  // Merged with UniformsLib.fog so the scene's fog reaches this custom shader
  // -- a ShaderMaterial opts out of fog unless both the uniforms and the chunks
  // are wired in by hand, and without it the river stays its flat base colour
  // out to the horizon while the fogged ground around it fades, which reads as
  // a bright band hanging in the haze.
  //
  // merge() deep-clones what it is given, so uBoat.value is NOT the Vector2
  // passed in here -- the caller has to mutate the one on the returned object.
  const uniforms = THREE.UniformsUtils.merge([
    THREE.UniformsLib.fog,
    { uTime: { value: 0 }, uBoat: { value: new THREE.Vector2(0, 0) } },
  ]) as WaterUniforms;

  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    transparent: false,
    fog: true,
    // CLAUDE.md gotcha: a hand-rolled BufferGeometry's triangle winding isn't
    // guaranteed to face the camera (confirmed here -- the grid's index order
    // produces normals pointing -Y, so a camera looking down from above saw
    // nothing at all with the default FrontSide culling). DoubleSide
    // sidesteps reasoning about the exact winding, and costs nothing for a
    // thin water sheet.
    side: THREE.DoubleSide,
  });

  const mesh = new THREE.Mesh(geometry, material);
  return { mesh, uniforms };
}
