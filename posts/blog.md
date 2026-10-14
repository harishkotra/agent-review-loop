# Your agent says it addressed the review comments. Here's how you find out if it actually did.

Agents are getting good at writing documents. They're also getting good at *claiming*
they fixed your feedback. I built **agent-review-loop**, a measurement instrument that
runs the review loop end to end and scores it with numbers computed from the diff —
never from the model's own word.

## The setup

[slashdocs](https://github.com/razorpay/slashdocs) gives agents a place to publish
reviewable self-contained HTML, and gives humans anchored comments — each comment is
pinned to the exact words via a W3C Web Annotation selector (`quote`, `prefix`,
`suffix`, character offsets into the document body's text).

So the ground truth exists. When the agent pushes the next version, did it change the
text each comment was anchored to? Or did it rewrite the whole document and hope nobody
noticed?

agent-review-loop answers with five numbers:

- **Attribution rate** — comments whose anchored text actually changed ÷ actionable comments.
- **Collateral churn** — characters changed *outside* every anchor ÷ total characters changed. High attribution with high churn = the agent rewrote your doc instead of editing it.
- **Claim accuracy** — how often the agent's own report matches the diff.
- **Cost per attributed fix** — real tokens from the API usage fields.
- **Rounds to converge** — pushes until no actionable comments remain.

## What the measurements caught

The plumbing catches lies by design. In a plumbing run with a small local model, the
agent claimed all four comments addressed — and pushed nothing. The harness printed,
verbatim, four times:

> VERIFICATION: MODEL CLAIMED ADDRESSED - ANCHORED TEXT UNCHANGED

Claim accuracy: 0%. Attribution: 0%. The instrument works: it measured the gap between
what the model said and what the model did.

In the deliberate stale-anchor test — a human deletes a commented sentence between
versions — the harness refuses to silently re-anchor to a similar-looking span. It
prints `ATTRIBUTION: STALE ANCHOR - quote not found in current version; comment left
unresolved`, excludes the comment from the denominator, and leaves it open.

Two different models on byte-identical documents with identical comments produce two
different scorecards — different attribution rates, different token totals. That's the
point: the numbers are measurements, not decorations.

## How it works

The revision agent (OpenAI Agents SDK for TypeScript, pointed at any OpenAI-compatible
endpoint) gets exactly four tools: `list_comments`, `pull_document`, `resolve_comment`,
`push_version`. Its system prompt forbids touching text no comment points at. Its
structured report is *compared* to the diff, never trusted.

Every run leaves a portable evidence bundle on disk: v1, v2, comments before and after,
the agent's claims, the trace, the verdicts, the metrics. The scorecard itself is
published back to slashdocs as its own document.

The anchor extractor was verified against the real viewer before building the scoring
engine: for the same sentence, slashdocs stored offsets 10/73, our jsdom extraction
computed 10/73.

Repo: https://github.com/harishkotra/agent-review-loop
