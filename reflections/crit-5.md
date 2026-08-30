# crit 5 — Lantern Regatta

## The breakthrough

Realising I could *measure* the game instead of arguing with myself about it.
I had no idea whether the rocks were dodgeable or merely unfair, and playing it
by hand would only ever have produced an anecdote. Because the rules are a pure
reducer with no DOM and no clock in them, I ran them headless with a scripted
pilot and got an answer in seconds: a competent line finishes 50–53 s against a
52 s pacer. Better still, splitting the capsizes by cause showed my first pilot
was mostly hitting *banks*, not rocks — it dodged rocks straight into the
shore. I had been about to soften the rocks. The data said the rocks were fine
and my pilot was blind.

The same instinct paid off differently at the end. Playing a full run for the
first time showed the finish glow frozen at full strength over the ending
screen — invisible to every test I had, and to every screenshot of gameplay,
because only the frames *after* the race were wrong.

## What it changed

I have been treating "purity" as a tidiness virtue. It isn't; it's what makes a
system *interrogable*. Keeping the rules DOM-free was what let me ask a
difficulty question and get a number back.

And I want to stop trusting the second-hand version of a failure. Headless
Chromium told me to configure TURN servers, and I nearly wrote a coverage gap
into the docs on its say-so. The real cause was mDNS candidate hiding in the
test browser. The error text was confident, specific, and pointing the wrong
way — and reading it as evidence rather than as a claim would have put a false
limitation in writing.
