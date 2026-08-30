# COMP4020 prototype

Your starter repo for a COMP4020 prototype: a static site in HTML/CSS/TypeScript
that builds to plain HTML/CSS/JS and deploys to GitHub Pages. The deployed site
is what gets marked, not this repo.

The
[course website](https://comp.anu.edu.au/courses/comp4020-agentic-coding-studio/)
publishes this deliverable's brief and spec, and this repo's name tells you
which deliverable applies. Read both before you plan or build.

## How to work in here

- Keep the dev server running (`pnpm dev`) so you see changes as you make them.
- Run `pnpm check` before you push.
- Open the page in a browser and look at it. The rendered page is the truth;
  your mental model of it isn't.
- When a check fails, read its output before you change anything.
- Never commit a red state.

## The link-preview card

`public/card.png` (1200x630) is the image a shared link shows; `index.html`'s
head points at it. Replace it and the `description` meta, and copy the head
block into any new page. The card URL resolves against the page that names it,
like any link --- `./card.png` is wrong one directory down, and nothing in CI
checks it, so look at the deployed head when you add pages.

## The checks

`pnpm check` runs them (`pnpm check:evidence` is the extra gate before you
ship); CI runs the same plus links, secrets and the deploy. Read the failure.

`spec/README.md`, `PROCESS.md` and `reflections/README.md` are in this repo and
say what they are for.

## This file is yours

A starting point, not a rulebook: what you add to it is the harness, and the
harness is assessed. This file and the sensors you wire into `check` carry
across the course --- both come with you into next week's repo. The prototype
doesn't: source, and the tests answering this week's published spec, stay
behind. `spec/README.md` draws the line.

## Stack gotchas found so far

- **Vite only rewrites asset paths in recognized HTML attributes** (`<img
  src>`, `<link href>`, etc). A path used elsewhere — a custom `data-*`
  attribute, a plain string in a `.ts` array/object — is invisible to Vite's
  bundler and 404s in `dist/` even though it works in `pnpm dev`. Use
  `new URL("./relative/path.ext", import.meta.url).href`; Vite's bundler
  statically detects that pattern, copies the file into `dist/assets/`
  (hashed), or inlines it as a `data:` URI if it's under the default 4KB
  threshold. Confirm with `find dist -iname "*.<ext>"` after a build, not
  just by trusting a green `pnpm build`.
- **Three.js: `camera.lookAt()` does not update `camera.matrixWorld` /
  `matrixWorldInverse`.** Those only refresh on the next `renderer.render()`
  call (or an explicit `camera.updateMatrixWorld()`). Any `Vector3.project()`
  or `Raycaster.setFromCamera()` call made *before* the first render uses a
  stale identity matrix and silently produces wrong (but plausible-looking,
  not NaN) coordinates. If a scene has an interactive layer synced to
  world-space positions, call `camera.updateMatrixWorld(true)` right after
  positioning the camera, not just after the first render.
- **oxlint 1.75.0's `--ignore-path` breaks on a relative path** (e.g.
  `.gitignore`), reporting "No files found to lint" — pass an absolute path
  (`"$PWD/.gitignore"`) instead. Reproduces on a clean checkout; unrelated to
  any change made here.
- No headless-browser CLI (`chromium-cli`) is installed in this environment;
  `/private/tmp/node_modules/playwright` has a cached Playwright install that
  works as a fallback for live-verifying pages with a Node driver script.
- **TypeScript's `if (x)` null-narrowing on an outer `const` does not survive
  into a hoisted `function` declaration defined later in the same block** —
  only into inline arrow-function closures. `tsc --noEmit` throws `TS18047`
  only for the function-declaration case. Bind a separate non-null alias
  (`const el = x;`) right after the narrowing `if` and use that alias inside
  any function declarations.
- **A DOM overlay and a WebGL `<canvas>` in the same container, both left at
  default `z-index: auto`, stack by DOM order, not paint order you'd guess
  from CSS alone.** If the overlay has to render on top (e.g. a ripple ring
  that needs to be visible over the canvas), its normal alpha blending will
  read as *the object beneath it fading/going transparent* at the moment they
  cross — especially damning if that crossing is timed to coincide with an
  animation on the object underneath, since the two get mistaken for one
  bug. `mix-blend-mode: screen` (light-only compositing) fixes the visual
  read without touching the underlying z-order or timing.
- **A custom pointer-event drag (`pointerdown`/`pointermove`/`pointerup`) can
  be silently hijacked by the browser's own native text-selection or
  drag-and-drop gesture on a real click-drag over text/emoji content** —
  swallowing the `pointermove` stream before the custom drag threshold ever
  fires. Playwright's synthetic `page.mouse` input does not reliably
  reproduce this, so an automated drag test can pass while the feature is
  broken for a real user. Fix: `event.preventDefault()` in `pointerdown`,
  plus `user-select: none` and `-webkit-user-drag: none` on the draggable
  element and its content.
- **Mobile Safari does not reliably treat a `pointerdown` listener as a "real"
  user gesture for unlocking `AudioContext.resume()`**, even though it fires
  normally and works for every other purpose (drag start, focus). A page that
  only calls `ctx.resume()` from `pointerdown` can render and animate
  correctly on a phone while staying permanently silent, with no error
  thrown — `resume()` just never resolves to `"running"`. `click` is the one
  event every browser (including old WebKit) honours for this, and a tap
  synthesises one after `touchend`, so register `start()` on both
  `pointerdown` (instant feedback on desktop) and `click` (the one mobile
  actually accepts), and make the resume attempt idempotent so retrying it on
  every gesture is cheap. Chromium's touch emulation (Playwright's
  `page.touchscreen`) does not reproduce this gap — it accepts `pointerdown`
  fine — so this class of bug is invisible to automated testing entirely and
  has to be reasoned about from platform behaviour, not caught by a test.
- **Two independent freely-draggable circular hit-targets at the same
  `z-index` will silently steal each other's clicks once one is dragged on
  top of the other** — whichever happens to paint last in DOM order wins
  `elementFromPoint`, and there's no error, just a dead spot. Caught this
  after `pnpm check` was fully green: an automated drag-then-click regression
  script (dragging the windmill onto a pad, then clicking the pad) silently
  failed because the click landed on the windmill instead. A screenshot alone
  wouldn't have shown it either — both hit-targets are invisible, only the 3D
  models are drawn. Fix was giving the two element classes distinct
  `z-index` values so the more important one (here, the pads — the actual
  instrument) always wins regardless of drag order or DOM insertion order.
  Worth a real interaction test (drag A onto B, then try to click B), not
  just a visual screenshot, whenever a page has more than one draggable
  overlay sharing the same space.
- **Custom hand-rolled `BufferGeometry` triangle strips (e.g. a ribbon built
  from manually-pushed positions/indices) are not guaranteed to wind toward
  the camera** — the same back-face-culling pitfall as loaded GLTF models
  with inconsistent winding (see the `loadModel` gotcha in `scene.ts`), just
  self-inflicted instead of inherited from an asset. Getting the winding
  exactly right requires reasoning about cross products per segment against
  the actual camera direction; `side: THREE.DoubleSide` on the material
  sidesteps that entirely and costs nothing for a thin ribbon.
- **An object placed "behind" a small occluding shape (e.g. a sphere hub) is
  not made more visible by moving it further behind** — from a fixed,
  steeply-angled-downward camera, more negative offset just moves it deeper
  into the same shadow. Confirmed by two failed placements at increasing
  offsets, both invisible in a close-up screenshot. If a camera angle makes
  one side of a small object a dead zone, add new geometry on the
  camera-facing side of that object instead of trying to tune the placement
  behind it.
- **A loaded GLTF mesh can contain literal duplicate triangles** — same three
  vertex positions, opposite winding — as an export artifact, not anything
  this project's code did. Combined with `material.side = THREE.DoubleSide`
  (needed elsewhere for real inconsistent winding, see the `loadModel`
  comment in `scene.ts`), both copies of a duplicate triangle render at once
  and GPU z-fighting between them is frame-to-frame *unstable*, especially
  once anything changes the mesh's transform every frame (this project's pad
  bob/pulse scale animation) — read by a user as the model "sometimes" going
  transparent/hollow, not a fixed visual bug, because the flicker is
  literally non-deterministic. Confirmed via `Raycaster.intersectObjects`
  returning two hits at the *same* 3D point with opposite face normals, then
  a full geometry dump (per-mesh triangle count vs. exact-duplicate count)
  showing ~30% of the affected meshes' triangles were duplicates while
  unaffected meshes in the same scene had zero. Swapping `DoubleSide` for
  `BackSide` does not fix this (tried; broke legitimately one-sided meshes
  elsewhere and left the z-fighting site just as flickery) — the fix is
  deduplicating the geometry's index at load time (drop the second copy of
  any triangle whose 3 vertex positions, rounded and order-independently
  sorted, already appeared), which is a no-op for meshes with no duplicates.
- **Reading a WebGL canvas's actual output for verification must use
  `page.screenshot()` (compositor output), not `ctx2d.drawImage(webglCanvas,
  ...)` + `getImageData`.** With the default `preserveDrawingBuffer: false`,
  the browser is free to clear/repurpose the WebGL drawing buffer as soon as
  the frame is presented; a 2D-context readback performed on a later tick
  (e.g. inside a separate `page.evaluate` call) can silently return stale or
  blank `(0,0,0,0)` pixel data with no error, even though the page visibly
  renders correctly. Cost real time here chasing a "transparent" bug that was
  actually just a broken readback, before switching to inspecting real
  `page.screenshot()` PNG bytes (e.g. via Pillow), which is reliable.
- **An author CSS rule with the same specificity as the browser's built-in
  `[hidden] { display: none }` can silently cancel it.** A plain class
  selector (`.foo { display: flex }`) has the same specificity as an
  attribute selector, so if that class also matches an element that has the
  `hidden` attribute, source order decides, and an author stylesheet always
  loads after the UA stylesheet — so the element stays visible even with
  `hidden` set, no error, nothing in the cascade looks wrong at a glance.
  Caught this shipping a toggleable toast (`hidden` + a "show" JS call):
  Playwright's `isVisible()` returned `true` on the branch that should have
  stayed hidden, before any JS had run to un-hide it. Fix: add an explicit
  `.foo[hidden] { display: none }` rule (or scope the `display` declaration
  to `.foo:not([hidden])`) whenever a class sets `display` on an element
  that can also carry `hidden`. Worth a real before/after visibility
  assertion in a browser, not just a green build, whenever a `hidden`
  attribute is toggled by script rather than left static in markup.
- **There is no web API to read an iPhone's hardware silent/mute switch.**
  iOS Safari (and every other iOS browser, since they all wrap WebKit)
  mutes `AudioContext` output when the switch is on, but `ctx.state` still
  reports `"running"` and every node still fires — nothing in the Web Audio
  API reflects the actual silence. The only honest approach is inferring
  the *platform* (iOS is the only place this failure mode exists) via
  `navigator.userAgent` / `maxTouchPoints` (iPadOS 13+ reports as a plain
  Mac in the UA, but exposes multiple touch points unlike a real Mac) and
  showing a one-time hint after playback starts — not pretending to detect
  the switch itself. See `isIOS()` in `main.ts`.
- **trystero picks its relays deterministically from `appId`, and a bad pick
  fails silently.** The library hashes the `appId` to choose which Nostr relays
  to announce on; a given app id can land entirely on relays that refuse to
  write (`blocked: not authorized`), demand proof of work (`pow: insufficient
  leading-zero bits`) or rate-limit (`rate-limited: you are noting too much`).
  None of that rejects a promise — an announce failure is a `console.warn` and
  nothing else. `joinRoom` resolves, the room object looks healthy, and
  `onPeerJoin` just never fires, which is indistinguishable from *nobody else
  has joined yet*, the ordinary case. Cost most of a debugging session before
  the pattern was visible. Name the relays explicitly (`relayConfig: { urls,
  redundancy }`) rather than trusting the default pick, and when peers cannot
  find each other, check `getRelaySockets()` for how many are actually open
  before suspecting anything in your own code.
- **A WebRTC connection failure in headless Chromium is not evidence of a
  WebRTC problem.** Headless Chromium hides local IPs behind mDNS `.local`
  candidates it then cannot resolve, so two contexts in the same browser
  exchange SDP successfully and then never connect. The error text points
  exactly the wrong way — trystero surfaces it as *"could not connect to peer
  … after exchanging SDP; configure TURN servers"*, which reads as a NAT
  traversal gap in the product. Launch with
  `--disable-features=WebRtcHideLocalIpsWithMdns` before believing it: with
  that flag the same two peers connected in ~6 s. Anything peer-to-peer is
  worth testing in a real browser before it is written up as a coverage hole.
- **trystero reaches for `crypto.subtle` unconditionally**, and it is
  `undefined` on an insecure origin. On `http://<LAN-IP>:5173` — the obvious
  way to test a second device — it throws inside a floating promise: nothing is
  logged, the join never settles, and the page sits in "connecting" forever.
  `localhost` *is* a secure context, so this never reproduces in local testing.
  Guard on `globalThis.isSecureContext` before joining, and use HTTPS (a
  tunnel, or the deployed Pages URL) for any second-device test.
- **A normaliser that returns `null` on bad input, paired with a "generate a
  fresh one" fallback, turns a typo into a silent private room.** Room codes
  here come from an alphabet with the lookalikes dropped
  (`abcdefghjkmnpqrstuvwxyz23456789` — no `o`, `i`, `l`, `0`, `1`), so a
  plausible-looking `#r=duotst` normalises to `null` and each page quietly
  makes up its own room. Both ends then work perfectly and never meet. Burned a
  full debugging cycle on a *test* whose room code contained an `o`. Whenever an
  invalid identifier degrades to a working-but-different state rather than an
  error, that path needs to be loud somewhere a developer will see it.
- **`node --experimental-strip-types` runs the repo's own `.ts` modules
  directly** (Node 24 here; no build step, no vitest wrapper), which makes a
  pure game reducer measurable instead of guessable. Driving `step()` in a loop
  with a scripted pilot answered *"is this course beatable, and are the
  collisions avoidable or just unfair?"* in seconds — a competent line finishes
  50–53 s against a 52 s pacer — where playing it by hand would have taken an
  afternoon and produced an anecdote. Keeping the rules pure and DOM-free is
  what buys this; it is worth the discipline for that reason alone.
- **An animation parameter that is correct while it is changing can be wrong
  once it stops.** A finish glow driven by *distance remaining* swelled
  correctly all the way down the river, then froze at full strength the instant
  the boat arrived — parking a 0.36×height disc at 0.66 alpha over the middle
  of the frame for the whole ending screen, exactly where the result text and
  the restart button are. Every frame of the race looked right; only the frames
  *after* the race were wrong. No test catches this and no screenshot of
  gameplay shows it: it only appears if you play a run to the end and keep
  looking after the outcome is decided. When a quantity feeds a visual and that
  quantity has a terminal value, look at what the visual does once it gets
  there.
