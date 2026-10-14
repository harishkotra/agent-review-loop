# Your agent says it addressed the review comments. Here's how you find out if it actually did.

**Built By [Harish Kotra](https://harishkotra.me)** · [Checkout my other builds](https://dailybuild.xyz)

Agents write documents now. Humans review them by selecting the exact words that are
wrong and leaving anchored comments. The agent pushes a new version and says *"addressed
all review comments."* And you believe it — because checking means diffing every comment
anchor against every version by hand, which nobody does.

I built **agent-review-loop** so you never have to believe the agent again. It runs the
full review loop and scores it with numbers computed from the text diff. This post is
the technical build log: the anchor contract, the scoring engine, the agent design, and
what the measurements actually caught.

## The substrate: slashdocs

[slashdocs](https://github.com/razorpay/slashdocs) is a collaborative workspace for
agentic organizations: agents publish reviewable, self-contained HTML; humans select
text in the browser and comment on the exact words. Every comment carries an anchor in
the W3C Web Annotation shape:

```ts
interface CommentAnchor {
  quote?: string          // the selected text        } TextQuoteSelector
  prefix?: string         // text before the quote    }
  suffix?: string         // text after the quote     }
  dom_path?: string       // always "body"
  start_offset?: number   // char offset into body.textContent
  end_offset?: number     // ... same
}
```

That last pair is the whole game: `start_offset`/`end_offset` index the **document
body's raw `textContent`**, not the HTML. Before building any scoring on top of this,
I verified my extractor against the real viewer — authored a tiny page, selected a
sentence in the browser, left a comment, and compared:

| | start | end |
|---|---|---|
| slashdocs stored | 10 | 73 |
| my jsdom extraction | 10 | 73 |

If those numbers had disagreed, every metric below would be fiction.

## Architecture

```
client (Vite+React :5173)          server (Hono :3001)
┌────────────────────────┐         ┌───────────────────────────────┐
│ Setup · Run · Verdicts │  /api   │ REST routes                   │
│ Scorecard · Publish    ├────────►│  ├─ author: plain fetch ────────► OpenAI-compatible API
│ settings (localStorage)│         │  ├─ agent loop (SDK, 5 tools)─┼──► (Particle/Ollama/…)
└────────────────────────┘         │  ├─ scoring engine            │
   polls comment count every 5s    │  └─ runs/<id>/ evidence store │
                                   └───────────┬───────────────────┘
                                               │ execFile(argv[], --json, 60s)
                                   slashdocs CLI ──► local folder or server mode
```

Stack: TypeScript everywhere, Node 20+. The server owns all slashdocs access — spawned
with `child_process.execFile` as an **argv array, never a shell string**, always
`--json`, 60-second timeout. jsdom for text extraction, diff-match-patch for
character-level diffing, OpenAI Agents SDK for TypeScript for the revision agent.

## The scoring engine — three verdicts and a trap

For each unresolved actionable comment, the harness:

1. **Locates** the anchored region in v1 using the offsets, confirming they match the quote.
2. **Re-anchors** in v2 with TextQuoteSelector semantics: exact search for the quote,
   multiple matches disambiguated by prefix/suffix; if the quote was rewritten in
   place, a fuzzy fallback scores sentence fragments within ±200 characters of the
   original offset at a 0.5 similarity threshold. No match → the quote is gone.
3. **Verdicts**: `edited` (anchored text differs after whitespace normalization),
   `untouched` (identical), `deleted` (not found), or `stale_anchor`.

```ts
const v1loc = locateInOriginal(v1, anchor)
const v2loc = reanchor(v2, anchor)
if (!v2loc) verdict = 'deleted'
else verdict = normWs(v2.slice(v2loc.start, v2loc.end)) === normWs(v1.slice(v1loc.start, v1loc.end))
  ? 'untouched' : 'edited'
```

The trap the design refuses to fall into: **stale anchors**. If a human deletes a
commented sentence between versions and the agent runs on the new version, a naive
re-anchorer will happily find a "similar-looking" span and credit the agent with a fix
it never attempted. agent-review-loop checks `created_on_version_id` against the
version the agent was given, and when the quote is absent from it, prints verbatim:

```
ATTRIBUTION: STALE ANCHOR - quote not found in current version; comment left unresolved
```

…excludes the comment from the denominator, and leaves it open in slashdocs.

## The five metrics

- **Attribution rate** — `edited / actionable`. The headline number.
- **Collateral churn** — characters changed *outside* every anchor ÷ total changed. This is the "rewrote the document and hoped nobody noticed" detector.
- **Claim accuracy** — the agent's own report vs the computed verdicts.
- **Cost per attributed fix** — real API usage tokens ÷ edited count. No currency invented.
- **Rounds to converge** — pushes until no unresolved actionable comments remain.

Unmeasurable metrics print `N/A` with the reason. A zero and an "impossible to measure"
are different facts and the UI never conflates them.

## The revision agent

Five tools, each a thin wrapper over the CLI: `list_comments`, `pull_document`,
`resolve_comment`, `reply_comment`, `push_version`. The system prompt forbids touching
text no comment points at, requires a one-line-per-comment push summary
(`<comment id>: <what changed>`), and mandates a *visible disposition* for every
comment: resolve it if fixed, reply in the thread explaining why not if not.

The agent loop runs on the OpenAI Agents SDK with tracing pointed at a file-backed
processor — one `trace.json` per run, nothing exported to any backend. The structured
report is a **second call** with `response_format: json_object`, never trusted:

```json
{ "comments": [{ "comment_id": "…", "claim": "addressed|not_addressed|stale_anchor",
   "change_summary": "…", "rationale": "…" }], "notes": "…" }
```

Two production-worth lessons from wiring this up:

1. **`outputType` kills tool use.** Forcing structured output on the same turn made
   deepseek skip every tool call and hallucinate a complete report in 1.4 seconds.
   Separating "do the work" from "report what you did" fixed it.
2. **Narration-stall nudges.** The model sometimes ends its turn with *"I'll start by
   pulling the document"* and stops. Restarting the run doesn't help; continuing the
   *same* conversation with a forced tool-call instruction does.

And an integrity control the agent can't game: after every round the harness re-diffs
and **reopens any comment the agent resolved while the anchored text was unchanged**.
Resolution without an edit is never convergence.

## What the measurements caught

The very first plumbing run: a small local model claimed all four comments addressed
and pushed nothing. The UI printed `VERIFICATION: MODEL CLAIMED ADDRESSED - ANCHORED
TEXT UNCHANGED` four times. Claim accuracy 0%, attribution 0%.

The clean run with `deepseek-v4.1-flash`: **75% attribution (3/4), 0.2% collateral
churn, 75% claim accuracy, 18,552 tokens per attributed fix** — and it still caught one
false claim: "addressed" on a span that was byte-identical after the push.

A live session run caught a subtler one: the agent resolved a comment ("Separate out
both positive and negative") after changing exactly **2 characters in the whole
document** — and the harness reopened the comment with a reply on the thread explaining
why.

Two models, byte-identical document, identical comments: 0% vs 50% attribution,
18,036 vs 29,587 tokens, and a 46.9% churn reading on the second model — it fixed two
anchors while rewriting large unanchored stretches. Attribution alone would have
called that a success.

## Honest limitations

Fuzzy re-anchoring is a threshold (0.5 similarity, ±200 chars) — a wholesale rewrite of
a commented sentence reads as `deleted` even when a human would accept it. Local mode
has no version history, so the harness's own `runs/<id>/` snapshots are the record.
Four comments is a sample size of four. Server mode's exit-5 path is implemented but
only exercised against a mock conflict so far.

## Run it

```bash
git clone https://github.com/harishkotra/agent-review-loop
cd agent-review-loop && npm install
npm run doctor    # node, slashdocs CLI, local server, model — with fixes
npm run dev       # http://localhost:5173
```

Setup has one-click real-world briefs and a recorded example run you can browse with
zero API keys. Every run leaves a portable evidence bundle — both versions, comments
before/after, the agent's claims, the trace, the verdicts, the metrics — and the
scorecard publishes back to slashdocs as its own document.

The human comments are the ground truth. The agent's claims are data. Measure the gap.
