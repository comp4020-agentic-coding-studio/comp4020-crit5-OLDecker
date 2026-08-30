# Process overview

## What I built

**Lantern Regatta** --- a paper boat racing down a meandering river at dusk,
drawn in Canvas 2D with a fake-perspective projection. You hold a side to
paddle that side: one gesture that propels and steers at once, so there is no
second control to discover and nothing to explain. Rocks and banks capsize you,
which costs about 1.4 s and whatever line you were holding; the loss the brief
asks for is arriving at the bend second. It teaches itself with no words at
all, and every run ends in a win or a loss inside about a minute. If you share
your URL, the rival boat stops being a script and becomes whoever opened it.

## The moments that mattered

### 1. Asking whether a static site can do peer-to-peer, and building so the answer didn't matter

The brief says *"no multiplayer/networking implied or required"*, so the honest
risk was building a two-player game that fails cold in front of a pod. I spiked
the transport first ([`da848c2`](https://github.com/comp4020-agentic-coding-studio/comp4020-crit5-OLDecker/commit/da848c2)) and then designed so the
network could never be load-bearing: the river is seeded from the room code so
no terrain crosses the wire, each client owns only its own boat, and I dropped
the start handshake my own plan called for --- a countdown gate would have been
the one piece of network on the critical path. `connectRoom` returns before a
packet moves ([`07c9530`](https://github.com/comp4020-agentic-coding-studio/comp4020-crit5-OLDecker/commit/07c9530)).

Getting there cost a full debugging session, and the write-up
([docs/spike-multiplayer.md](docs/spike-multiplayer.md)) is the most useful
thing in this repo. trystero picks relays by hashing the `appId`; mine landed
on two, one of which refused every announce with `blocked: not authorized` ---
as a `console.warn`, not a rejected promise, so both peers sat in a room they
thought they had joined. Then two headless tabs exchanged SDP and failed to
connect with an error naming TURN, which reads as a real coverage gap. It
wasn't: headless Chromium hides local IPs behind mDNS candidates it can't
resolve. With `--disable-features=WebRtcHideLocalIpsWithMdns` both peers
connected in ~6 s and each rendered the other's boat correctly. Both findings
went into `CLAUDE.md`, along with the one that embarrassed me most: my own test
used the room code `duotst`, and `o` isn't in the lookalike-free alphabet, so
each tab silently made up its own room.

### 2. Measuring whether the game was fair instead of guessing

I could not tell by playing whether the rocks were dodgeable or just unfair.
Because the rules are a pure DOM-free reducer, I ran them headless with
`node --experimental-strip-types` and a scripted pilot. The first pilot lost
badly --- and splitting its capsizes by cause showed almost all of them were
*banks*, not rocks: it was swerving around rocks into the shore. A pilot that
can see the bank finishes 50--53 s against the 52 s pacer across three seeds.
That is the difficulty I wanted, confirmed in seconds rather than asserted.
Keeping the rules pure is what bought this, and it is now a note in
`CLAUDE.md`.

### 3. Playing to the end, which is the only way I'd have found this

The brief asks for one change that comes from actually playing the finished
game. Mine came from the first run I ever played all the way to an ending
([`552964a`](https://github.com/comp4020-agentic-coding-studio/comp4020-crit5-OLDecker/commit/552964a)). The finish glow is the game's entire progress
indicator --- it swells as you close on the bend, and during the race that is
exactly right. But it is driven by *distance remaining*, which stops changing
when you arrive, so it froze at full strength: a 0.36x height disc at 0.66
alpha parked over the middle of the ending screen, with the verdict and the
restart button read through it.

![The ending before and after: washed-out on the left, dusk contrast restored
on the right](docs/finish-glow.png)

Every frame *of the race* looked right. Only the frames after it were wrong, so
no test and no gameplay screenshot would ever have shown it. Generalised in
`CLAUDE.md`: when a quantity feeds a visual and that quantity has a terminal
value, look at what the visual does once it gets there.

### 4. Turning a known trap into a check instead of remembering it

`CLAUDE.md` already warned that a card image path resolves against the page
naming it and that nothing in CI checks it --- a warning is only as good as my
memory of it. The supplied invariant asserts the card is *named*, and a name
that 404s looks perfectly fine in the markup; it surfaces in the course gallery
as a broken preview, after the deadline. So I wired it into `check`
([`f3cf82e`](https://github.com/comp4020-agentic-coding-studio/comp4020-crit5-OLDecker/commit/f3cf82e)): every local asset reference in every built
page, resolved the way a browser resolves it, asserted against what the build
actually emitted. I verified it bites by pointing the card at
`./img/card.png` and watching it go red before restoring it. This one is a
sensor, not a contract for this week, so it comes forward.
