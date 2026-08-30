// The Three.js scene: setup once, then a per-frame render function.
//
// Coordinate mapping (fixed): x -> Three.js X unchanged; y (downstream
// progress) -> Three.js Z as -y, so travelling downstream is -Z, "into the
// screen"; elevation -> Three.js Y (up). A boat facing downstream points
// toward -Z.

import * as THREE from "three";
import type { Race } from "./regatta.ts";
import { CAPSIZE_MS } from "./regatta.ts";
import type { River } from "./river.ts";
import {
  PLAYER_FOLD,
  PLAYER_HULL,
  RIVAL_FOLD,
  RIVAL_HULL,
  buildKayak,
  buildLog,
  buildRock,
} from "./assets.ts";
import { buildWaterMesh, waterHeightAt } from "./water.ts";
import { GROUND_Y, buildScenery } from "./scenery.ts";
import { newPaddleState, stepPaddle } from "./paddle.ts";

export type Rival = { x: number; y: number; lean: number; ghost: boolean };

export type Ending = {
  outcome: "won" | "lost" | "tied";
  /** Milliseconds since the finish, for the lantern rise. */
  ageMs: number;
};

/**
 * What the paddle is doing. `side` is which side is being favoured, not which
 * blade is currently down -- the alternation itself lives in paddle.ts, driven
 * by elapsed time, so that steering biases a running stroke instead of
 * replacing it with a held pose.
 */
export type Stroke = { active: boolean; side: -1 | 0 | 1 };

export type Scene = {
  river: River;
  race: Race;
  rival: Rival | null;
  /** Smoothed camera, so the frame doesn't twitch with every stroke. */
  cameraX: number;
  /** Wall clock, for water motion that runs whether or not the race does. */
  timeMs: number;
  /** 0..1 strength of the paddle hint. Falls to 0 for good on first input. */
  hint: number;
  stroke: Stroke;
  ending: Ending | null;
};

// A bright, saturated daylight palette. The scene used to run at dusk; the
// water is the reason it doesn't any more -- cel-shaded caustics are a
// full-sun effect, and there is no version of them that reads correctly
// against an orange sky and near-black water.
const SKY_TOP = 0x2f86d4;
const SKY_MID = 0x7ec8f0;
const SKY_LOW = 0xd6eef8;
const MEADOW_COLOR = 0x5aa64a;

/**
 * The haze the far course dissolves into. A pale sky blue, so the water, the
 * banks, the hills and the sky all converge on one colour at the horizon
 * rather than each fading somewhere different.
 */
const HAZE = 0xc3e4f2;

/** Where the sun sits *in the sky*: ahead and to the left, so its glow sits
 *  over the far bend and pulls the eye downstream. */
const SUN_DIR = new THREE.Vector3(-0.4, 0.5, -0.76).normalize();

/**
 * Where the key light comes *from*, which is not the same place. Lighting the
 * scene from SUN_DIR is physically the consistent choice and it looked wrong:
 * every camera-facing surface -- the hull, every rock -- is then a back-lit
 * silhouette, and #ffc94f under hemisphere fill alone is a dull olive rather
 * than the yellow it was picked to be. Splitting the two is what an illustrator
 * would do without thinking: glow down the river, key light over the paddler's
 * shoulder. Nothing in frame casts a shadow, so nothing gives the split away.
 */
const KEY_DIR = new THREE.Vector3(-0.34, 0.6, 0.72).normalize();

/** Sky gradient, sun and clouds, on a dome that rides with the camera. */
const SKY_VERTEX = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const SKY_FRAGMENT = /* glsl */ `
  varying vec3 vDir;
  uniform vec3 uTop;
  uniform vec3 uMid;
  uniform vec3 uLow;
  uniform vec3 uSun;
  uniform float uTime;

  void main() {
    vec3 d = normalize(vDir);
    float h = clamp(d.y * 0.5 + 0.5, 0.0, 1.0);
    vec3 col = mix(uLow, uMid, smoothstep(0.50, 0.66, h));
    col = mix(col, uTop, smoothstep(0.62, 0.95, h));

    // Clouds, projected onto a notional flat ceiling: dividing the view
    // direction by its own height is what makes them bunch toward the horizon
    // the way a real overcast does, instead of ringing the dome evenly.
    if (d.y > 0.05) {
      vec2 q = d.xz / d.y + vec2(uTime * 0.06, 0.0);
      float n = sin(q.x * 0.55) * 0.5
              + sin(q.y * 0.41 - 1.3) * 0.5
              + sin(q.x * 0.29 + q.y * 0.24 + 2.1) * 0.6;
      float cloud = smoothstep(0.62, 0.98, n * 0.5 + 0.5)
                  * smoothstep(0.05, 0.30, d.y);
      col = mix(col, vec3(1.0), cloud * 0.9);
    }

    float toSun = max(0.0, dot(d, uSun));
    col += vec3(1.0, 0.96, 0.84) * (pow(toSun, 240.0) * 1.3 + pow(toSun, 8.0) * 0.16);

    gl_FragColor = vec4(col, 1.0);
  }
`;

/** Sets opacity on every material found under a group -- used to fade a whole
 *  kayak (hull, rim, stripe, paddler, paddle) as one unit during capsize or
 *  ghosting. */
function setGroupOpacity(group: THREE.Object3D, opacity: number): void {
  group.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mat = mesh.material as THREE.Material | THREE.Material[];
    if (Array.isArray(mat)) {
      for (const m of mat) (m as THREE.MeshLambertMaterial).opacity = opacity;
    } else {
      (mat as THREE.MeshLambertMaterial).opacity = opacity;
    }
  });
}

export function createRenderer(
  canvas: HTMLCanvasElement,
  river: River,
): {
  renderer: THREE.WebGLRenderer;
  resize(width: number, height: number): void;
  renderScene(scene: Scene): void;
} {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));

  const scene3js = new THREE.Scene();
  scene3js.background = new THREE.Color(HAZE);
  // Further out than the dusk scene's 16..60: daylight air is clear, and the
  // landscape on the banks is worth being able to see. Still well inside the
  // ~34 units of look-ahead the course difficulty was tuned against.
  scene3js.fog = new THREE.Fog(HAZE, 26, 120);

  const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 400);

  // Radius is comfortably inside the camera's far plane because the dome is
  // re-centred on the camera every frame -- the course runs 300 units, so a
  // world-anchored sky would be left behind within seconds.
  const skyUniforms = {
    uTop: { value: new THREE.Color(SKY_TOP) },
    uMid: { value: new THREE.Color(SKY_MID) },
    uLow: { value: new THREE.Color(SKY_LOW) },
    uSun: { value: SUN_DIR.clone() },
    uTime: { value: 0 },
  };
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(180, 32, 20),
    new THREE.ShaderMaterial({
      uniforms: skyUniforms,
      vertexShader: SKY_VERTEX,
      fragmentShader: SKY_FRAGMENT,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    }),
  );
  sky.renderOrder = -1;
  scene3js.add(sky);

  const { mesh: waterMesh, uniforms: waterUniforms } = buildWaterMesh(river);
  scene3js.add(waterMesh);

  // Deviation from the plan's literal y=0.02: the water mesh bobs by up to
  // 0.018 in either direction (see water.ts's vertex shader), so a ground
  // plane at 0.02 sits above the water surface most of the time and, being a
  // full sheet, completely occludes the narrower river band -- not a
  // z-fighting flicker but a total, silent hide (confirmed via a Playwright
  // screenshot showing no river at all). Sitting the ground below the water's
  // lowest point fixes that while keeping the "banks slightly above the
  // water" read outside the channel.
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(600, 800),
    new THREE.MeshBasicMaterial({ color: MEADOW_COLOR }),
  );
  ground.rotateX(-Math.PI / 2);
  ground.position.set(0, GROUND_Y, -140);
  scene3js.add(ground);

  scene3js.add(buildScenery(river));

  for (const rock of river.rocks) {
    const mesh = buildRock(rock.r);
    mesh.position.set(rock.x, rock.r * 0.4, -rock.y);
    scene3js.add(mesh);
  }

  for (const log of river.logs) {
    const mesh = buildLog(log.half, log.r);
    // Below the waterline, not on it. A cylinder centred above y=0 shows its
    // whole round body and reads as a log resting on a blue floor; dropping it
    // until over half the trunk is under lets the opaque river cut it, which is
    // the only cue that says "floating".
    mesh.position.set(log.x, -log.r * 0.12, -log.y);
    scene3js.add(mesh);
  }

  const player = buildKayak(PLAYER_HULL, PLAYER_FOLD);
  scene3js.add(player.group);
  const playerPaddle = newPaddleState();

  const rivalBoat = buildKayak(RIVAL_HULL, RIVAL_FOLD);
  rivalBoat.group.visible = false;
  scene3js.add(rivalBoat.group);
  const rivalPaddle = newPaddleState();

  const sun = new THREE.DirectionalLight(0xfff6e0, 1.15);
  sun.position.copy(KEY_DIR).multiplyScalar(30);
  scene3js.add(sun);
  // Hemisphere rather than flat ambient: the shadowed side of a hull picks up
  // green off the banks and blue off the sky, which is most of what makes a
  // low-poly object sit in a place rather than in front of it.
  scene3js.add(new THREE.HemisphereLight(0xa9dcf6, 0x5f8f46, 0.85));

  let previousTimeMs: number | null = null;

  function resize(width: number, height: number): void {
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.setSize(width, height, false);
    camera.aspect = width / Math.max(1, height);
    camera.updateProjectionMatrix();
  }

  /** Positions/rotates a kayak group for a boat pose, with the capsize spin
   *  and fade shared between the player and the rival. */
  function poseKayak(
    group: THREE.Group,
    x: number,
    y: number,
    lean: number,
    capsizeMs: number,
    baseOpacity: number,
    timeSeconds: number,
  ): void {
    // Rides the same surface water.ts draws, so the hull rises and falls with
    // the swell under it instead of sliding along a flat plane.
    const float = waterHeightAt(x, -y, timeSeconds);
    group.position.set(x, float, -y);
    if (capsizeMs > 0) {
      const done = 1 - capsizeMs / CAPSIZE_MS;
      const settle = Math.max(0, 1 - done * 1.4);
      group.rotation.set(0, 0, 0);
      group.rotateZ(Math.sin(done * Math.PI * 2.4) * 1.5 * settle);
      const scale = 1 - 0.25 * settle;
      group.scale.set(scale, 1 - 0.35 * settle, scale);
      setGroupOpacity(group, baseOpacity * (0.45 + 0.55 * done));
    } else {
      group.scale.set(1, 1, 1);
      // A little pitch off the swell ahead of the bow, on top of the heel from
      // steering -- a hull that only ever rolls reads as being on rails.
      const pitch = (waterHeightAt(x, -y - 0.5, timeSeconds) - float) * 1.6;
      group.rotation.set(pitch, -lean * 0.25, lean * 0.3);
      setGroupOpacity(group, baseOpacity);
    }
  }

  function renderScene(scene: Scene): void {
    const seconds = scene.timeMs / 1000;
    const dtSeconds =
      previousTimeMs === null ? 0 : Math.max(0, (scene.timeMs - previousTimeMs) / 1000);
    previousTimeMs = scene.timeMs;

    waterUniforms.uTime.value = seconds;
    skyUniforms.uTime.value = seconds;

    const { boat } = scene.race;
    waterUniforms.uBoat.value.set(boat.x, -boat.y);
    poseKayak(player.group, boat.x, boat.y, boat.lean, boat.capsizeMs, 1, seconds);

    stepPaddle(
      player.paddlePivot,
      playerPaddle,
      scene.stroke.side,
      scene.stroke.active && boat.capsizeMs <= 0,
      dtSeconds,
    );

    if (scene.rival) {
      rivalBoat.group.visible = true;
      const opacity = scene.rival.ghost ? 0.55 : 1;
      poseKayak(
        rivalBoat.group,
        scene.rival.x,
        scene.rival.y,
        scene.rival.lean,
        0,
        opacity,
        seconds,
      );
      // A rival is always under way, and their input isn't ours to know.
      stepPaddle(rivalBoat.paddlePivot, rivalPaddle, 0, true, dtSeconds);
    } else {
      rivalBoat.group.visible = false;
    }

    const camX = scene.cameraX;
    // Height and set-back are a pair, and what they buy is the *deck*. At the
    // first pass's 1.15 / 3.6 the sightline over the boat was 18 degrees, and a
    // kayak seen from 18 degrees behind is a foreshortened lump -- the hull, the
    // rim and the deck stripe all hid behind the paddler. Higher and closer
    // opens that to 24 degrees, which is enough to read a pointed hull sitting
    // in water without tipping into a top-down view.
    const camY = 1.42;
    const camZ = -boat.y + 3.15;
    camera.position.set(camX, camY, camZ);
    const lookX = scene.cameraX;
    const lookZ = -boat.y - 10;
    // Aimed low and far: a flatter angle puts the horizon in frame, which is
    // where the sky gradient, the hills and the fog do their work.
    camera.lookAt(lookX, 0.22, lookZ);
    // CLAUDE.md gotcha: lookAt() alone doesn't refresh matrixWorld before the
    // next render.
    camera.updateMatrixWorld(true);

    // The dome is scenery at infinity, not an object in the world.
    sky.position.copy(camera.position);

    renderer.render(scene3js, camera);
  }

  return { renderer, resize, renderScene };
}
