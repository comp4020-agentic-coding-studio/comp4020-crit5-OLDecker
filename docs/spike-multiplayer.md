# Spike: can a GitHub Pages site do peer-to-peer?

Crit 5 says *"No multiplayer/networking implied or required."* This is the
write-up of asking anyway, because the answer decides whether Lantern Regatta's
rival can ever be a person instead of a script.

**Short answer: yes, with no backend, no account, no API key and no change to
the deploy** — and with one class of network it will never reach.

## What was tried

[`da848c2`](../../commit/da848c2) probed [trystero](https://github.com/dmotz/trystero)
`0.25.3` over public Nostr relays: peers announce themselves on a relay, swap
SDP through it, then talk directly over WebRTC. The relay only introduces them.
It ships as an ordinary Vite dependency — 58.86 kB gzipped to 21.53 kB, and
because it is behind a dynamic `import()` it is a separate chunk that never
touches the game's initial parse.

## What broke, and what it cost to find

### Relay choice is deterministic from `appId`, and the default pick was dead

This one cost the most. trystero hashes `appId` to choose which relays to use.
`comp4020-oldecker-regatta` happened to land on exactly two, and one of them
answered every announce with `blocked: not authorized`.

The failure is silent by construction: an announce failure is a `console.warn`,
not a rejected promise. `joinRoom` resolves, the room object looks healthy,
`onPeerJoin` simply never fires. Both peers sit in a room they believe they
joined. Nothing in the app can tell that apart from *nobody else is here yet* —
which is also the ordinary case.

Fixed by naming the relays explicitly (`relayConfig.urls`, `redundancy: 4`).
Two more were rejected on the way: `relay.nostr.place` demands proof of work
(`pow: insufficient leading-zero bits`), and `relay.damus.io` rate-limits at
this send rate (`rate-limited: you are noting too much`).

### `crypto.subtle` is undefined on an insecure origin

trystero reaches for it unconditionally. On `http://<LAN-IP>:5173` — the obvious
way to test a second device — it throws inside a floating promise and the page
hangs in "connecting" forever, with no error surfaced. `localhost` is a secure
context, so this never shows up in local testing. `net.ts` now checks
`isSecureContext` up front and drops straight to solo.

### The TURN hole is real, but a headless browser lies about it

After discovery started working, both peers reported:

> could not connect to peer … after exchanging SDP; configure TURN servers with
> `turnConfig` or `rtcConfig.iceServers`

That is the genuine coverage gap this design accepts — but it was **not** what
was happening here. Headless Chromium hides local IPs behind mDNS `.local`
candidates it then cannot resolve, so two tabs on one machine never connect.
Launching with `--disable-features=WebRtcHideLocalIpsWithMdns` connects both
peers in about 6 s, and each renders the other's boat in the right place.

Worth writing down twice: **a WebRTC failure in headless Chromium is not
evidence of a WebRTC failure.** The error text names TURN, which is exactly the
wrong place to go looking.

## What is still true

There is no TURN server, so a symmetric NAT on either side will never connect
peer-to-peer. That is a deliberate limit, not an oversight: TURN means a
credential, a credential in a static site is plain text in `dist/`, and a
relay someone else pays for is not something a coursework page should be
holding the keys to.

So the game is built so that the hole costs nothing. `connectRoom` returns
before a packet moves. Insecure origin, dead relay, hostile NAT, empty room —
every one of them lands in the same place: no rival snapshot, so the pacer
keeps the race, and the player is never told that anything failed, because
from where they are sitting nothing did.
