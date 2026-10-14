# X thread — 2 tweets

**1/**
Your agent says it addressed the review comments. Here's how you find out if it actually did.

I built agent-review-loop on top of slashdocs: humans comment on the exact words (W3C-anchored), the agent pushes v2 — and a harness re-derives every verdict from the character-level diff, never from the model's word.

It immediately caught an agent resolving a comment after changing 2 characters in the whole doc. The comment got auto-reopened with a reply explaining why.

**2/**
Five numbers, no vibes: attribution rate (did the anchored text actually change), collateral churn (the "rewrote everything and hoped nobody noticed" detector), claim accuracy, tokens per attributed fix, rounds to converge.

Same doc + same comments, two models → 0% vs 50% attribution, 18k vs 29k tokens. The human comments are the ground truth. The agent's claims are data.

github.com/harishkotra/agent-review-loop
