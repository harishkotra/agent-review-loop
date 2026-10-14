# agent-review-loop

**Your agent says it addressed the review comments. Here is how you find out if it actually did.**

slashdocs gives humans anchored comments — pinned to the exact words of a document an
agent published. agent-review-loop closes the loop and scores it with real numbers
computed from the v1→v2 diff, never from the model's own claims:

- **Attribution rate** — anchored text actually changed ÷ actionable comments
- **Collateral churn** — characters edited outside every anchor (the "rewrote the whole doc and hoped nobody noticed" detector)
- **Claim accuracy** — the agent's report vs the diff, mismatches printed verbatim
- **Cost per attributed fix** — real API token usage
- **Rounds to converge** — pushes until the review is clean

Built with TypeScript, Vite + React, Hono, the OpenAI Agents SDK (any OpenAI-compatible
endpoint — Particle, LM Studio, Ollama, Gemini), jsdom + diff-match-patch, and the
slashdocs CLI. Every run leaves a portable evidence bundle: both versions, comments
before/after, the agent's claims, the trace, the verdicts. The scorecard publishes back
to slashdocs as its own document.

The harness caught a model claiming four fixes it never made — and the deliberate
stale-anchor case fails loudly instead of silently re-anchoring.

github.com/harishkotra/agent-review-loop

Built By Harish Kotra · Checkout my other builds at dailybuild.xyz
