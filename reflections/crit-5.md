# crit 5 — Lantern Regatta

## The breakthrough

Realising I could *measure* the game instead of arguing with myself about it.
I had no idea whether the rocks were dodgeable or merely unfair, and playing it
by hand would only ever have produced an anecdote. Because the rules are a pure
reducer with no DOM and no clock in them, I ran them headless with a scripted
pilot and got an answer in seconds: a competent line finishes 50–53 s against a
52 s pacer. The part I did not expect was splitting the capsizes by cause. My
first pilot was mostly hitting *banks*, not rocks — dodging rocks straight into
the shore. I had been about to soften the rocks. The rocks were fine; my pilot
was blind.

Then I rebuilt the thing in Three.js. The prototype had never used it, and I
wanted a real 2.5D feel, so the whole layer underneath the game had to be
reproduced before any of it could look the way I meant it to.

## What it changed

That rebuild taught me the limit of the tool I had just fallen for. Every
visual bug in the port survived a fully green check: rocks with holes torn in
them, caustics that undersampled into crawling confetti, a hull lit from behind
so a yellow boat rendered olive. A hundred-odd tests, all passing, all still
correct — they simply had nothing to say about whether the scene *looked*
right. I found every one of those by screenshotting the running page and
looking at it.

So purity is not tidiness, it is what makes a system interrogable — and knowing
which questions it cannot answer is the other half of the same skill. I want to
be the developer who reaches for the instrument and then still goes and looks.
