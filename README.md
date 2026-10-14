# agent-review-loop

**Built By [Harish Kotra](https://harishkotra.me)** · [Checkout my other builds](https://dailybuild.xyz)

A review-loop harness that measures whether an AI agent actually fixed what a
human reviewer asked it to fix in a [slashdocs](https://github.com/razorpay/slashdocs) document.

slashdocs gives agents a place to publish reviewable self-contained HTML, and gives
humans anchored comments on the exact words. What nobody had measured is the thing
that matters: when the agent pushes the next version, **did it change the text each
comment was anchored to, or did it rewrite the whole document and hope nobody
noticed?**

agent-review-loop runs that loop end to end and scores it with real numbers computed
from the run. It is a measurement instrument, not a doc generator. The human comments
are the ground truth; the agent's own claims are not.

## What it measures

| Metric | Definition |
|---|---|
| **Attribution rate** | `edited / actionable comments`. A comment is actionable when it is open and carries an anchor quote. `stale_anchor` comments are excluded from the denominator and never counted as addressed. |
| **Collateral churn** | characters changed **outside** every comment anchor ÷ total characters changed, from the character-level v1→v2 diff (`diff-match-patch`). A high attribution rate with high churn means the agent rewrote the document instead of editing it. |
| **Claim accuracy** | agent claims that match the computed verdict ÷ comments. Every mismatch is shown explicitly. |
| **Cost per attributed fix** | total usage tokens for the run (prompt + completion, read from the API response) ÷ edited count. Shown in tokens; no currency figure is invented. |
| **Rounds to converge** | number of pushes until no unresolved actionable comments remain (cap: 3). |

If a metric cannot be computed for a run, it prints `N/A` with the reason. It never
prints a zero or a placeholder where a real measurement was impossible.

Verdicts per comment, computed from the text, never from the model:

- **edited** — v2 text at the re-anchored region differs from the v1 quote after whitespace normalization.
- **untouched** — identical.
- **deleted** — the quote cannot be found in v2 and no fuzzy match clears the threshold.
- **stale_anchor** — the comment's `created_on_version_id` predates the version the agent was given, and its quote is absent from that version. Excluded from the denominator, never counted as addressed, surfaced verbatim: `ATTRIBUTION: STALE ANCHOR - quote not found in current version; comment left unresolved`

When the model claims a fix the diff does not show, the UI prints verbatim:
`VERIFICATION: MODEL CLAIMED ADDRESSED - ANCHORED TEXT UNCHANGED`

## The anchor contract

A slashdocs comment carries an anchor in the W3C Web Annotation shape
(`frontend/bridge/anchoring/types.ts`):

```
{ quote, prefix, suffix, dom_path, start_offset, end_offset }
```

`quote/prefix/suffix` are a TextQuoteSelector. `start_offset`/`end_offset` are
character offsets into the **document body's raw `textContent`**, and `dom_path` is
always `"body"`. The comment object also carries `id`, `document_id`, `version_id`,
`created_on_version_id`, `author`, `body`, `status`, `created_at`, `resolved_at`,
`replies` — all confirmed against live `slashdocs docs comments list --json` output.

### Extractor verification (real numbers)

We authored a tiny document, published it, selected a known sentence **in the real
browser viewer**, left a comment, and compared slashdocs' stored offsets against the
offsets our jsdom extractor computes for the same sentence:

| | start_offset | end_offset |
|---|---|---|
| slashdocs viewer (stored anchor) | **10** | **73** |
| agent-review-loop jsdom extraction | **10** | **73** |

The stored prefix (`"\nTiny Doc\n"`) also matched our extraction exactly. The two
numbers compared: **10/73 vs 10/73 — agreement**.

## Which metrics are exact, which are fuzzy

- **Exact:** locating the anchored region in v1 via `start_offset/end_offset` (browser-made comments carry offsets; CLI-made comments carry only the quote, which is matched exactly). The `edited`/`untouched` decision for any comment whose quote survives verbatim or whitespace-reflowed in v2 is exact. Token totals are the API's own usage fields.
- **Fuzzy:** re-anchoring a quote whose text was *rewritten in place*. We try exact search (disambiguated by `prefix`/`suffix`), then fall back to sentence-boundary scoring within 200 characters of the original offset, threshold 0.5 on max(word-Dice, Levenshtein similarity). Every fuzzy verdict is labeled with its similarity in `verdicts.json`. Collateral churn inherits this fuzziness for edited-in-place spans.
- **Local mode has no version history** (a local document has one version — its current content, whose id rotates with content), so agent-review-loop snapshots every version it cares about into `runs/<runId>/` itself.

## Stack

- Node 20+, TypeScript throughout.
- Client: Vite + React on **:5173**, dark, dense, measurement-forward.
- Server: Hono on **:3001** — owns all CLI calls (`child_process.execFile`, never a shell string, always `--json`, 60 s timeout), parsing, diffing, scoring.
- Agent: [OpenAI Agents SDK for TypeScript](https://openai.github.io/openai-agents-js/) (`@openai/agents`) pointed at any OpenAI-compatible endpoint via `setDefaultOpenAIClient(new OpenAI({ baseURL, apiKey }))` + `setOpenAIAPI('chat_completions')`. Tracing enabled; a file-backed trace processor writes one `trace.json` per run — nothing leaves the machine.
- `jsdom` for body-text extraction, `diff-match-patch` for character-level diffing.

## Run it

```bash
npm install
cp .env.example .env        # optional: server-side fallback key for headless runs
npm run dev                 # client :5173, server :3001
```

Requires the `slashdocs` CLI on PATH (or set its path in Settings).

### slashdocs access modes (selectable in the UI)

- **local (default, zero infra):** `slashdocs --local …`. A local document's id is its
  path in the documents folder (default `~/slashdocs`), e.g. `report.html`. Viewer:
  `http://slashdocs.localhost` (port 80, or 7070 if 80 is taken). Local mode has
  comments but no version history, labels, folders, grants, or search — the harness
  snapshots every version into `runs/<runId>/`.
- **server:** `SLASHDOCS_SERVER` + `SLASHDOCS_TOKEN` (a service-account key,
  `slashdocs_sa_…`) for headless runs. Adds immutable versions; runs mirror them.

On server mode, `docs push` can fail with **exit code 5 = version conflict**. The
harness re-pulls the document, tells the agent to re-apply its changes, and retries
**once**. If it conflicts again it records `VERSION CONFLICT - another writer pushed
first; run aborted without clobbering` and stops. Never a blind-retry loop.

### Flow

1. **Setup** — mode, model config, brief or existing document id.
2. **Author v1** — the LLM writes one self-contained HTML file following `slashdocs guidelines all`; published; viewer URL shown.
3. **Human review** — manual and explicit: open the doc, select words, comment. "Re-check comments" pulls `comments.before.json`.
4. **Revision run** — the agent gets the document and only the unresolved actionable comments, with exactly four tools: `list_comments()`, `pull_document()`, `resolve_comment(comment_id)`, `push_version(html_path, summary)` (summary: one line per comment, `<comment id>: <what changed>`).
5. **Verify and score** — verdicts and metrics computed from the actual v1/v2 text.
6. **Report** — scorecard in the UI, plus a self-contained HTML scorecard published back to slashdocs as its own document.

The agent must return a structured report (`response_format: json_object`, enforced
with a zod `outputType`):

```json
{
  "comments": [
    { "comment_id": "string", "claim": "addressed|not_addressed|stale_anchor",
      "change_summary": "string", "rationale": "string" }
  ],
  "notes": "string"
}
```

The harness re-derives every verdict from the diff. Claims are only compared against measurements.

## Evidence bundle

`runs/<runId>/` — self-contained and portable: `brief.md`, `v1.html`, `v2.html`,
`comments.before.json`, `comments.after.json`, `verdicts.json`, `metrics.json`,
`trace.json`, `agent-claims.json` (+ `run.json`, `author-usage.json`,
`comments.all.json`, `scorecard.html`). Nothing in it is synthesised.

## Tests

```bash
npm run smoke               # clean case end-to-end against a locally served slashdocs doc
npx tsx scripts/score-test.ts    # synthetic scoring-engine checks (no LLM)
npx tsx scripts/stale-test.ts    # stale-anchor failure path
npx tsx scripts/two-model-test.ts # identical doc+comments, two models
```

### Test case results (real numbers)

_Populated by live runs — see below._

## Framework swap note

The revision agent is swappable to [Mastra](https://mastra.ai) (`@mastra/core`): keep
the same four tools (they are thin CLI wrappers) and the same run record on disk —
only `server/src/agent.ts` changes. This repo ships the OpenAI Agents SDK
implementation; Mastra is documented, not built.

## Honest limitations

- **Fuzzy re-anchor threshold.** In-place rewrites are matched by sentence scoring at 0.5 similarity within ±200 chars. A rewrite that shares almost no words with the quote reads as `deleted`, even if a human would call it "fixed". Every fuzzy verdict carries its similarity score.
- **Local mode has no versions.** Version ids rotate with content but there is no history; the harness's own snapshots in `runs/<runId>/` are the record.
- **Single-run sample sizes.** One run is one observation. Attribution rate on 4 comments is a ratio of small integers — treat differences of one comment as noise.
- **CLI-created comments carry only `quote`** (no offsets); browser comments carry full anchors. Offset-based v1 location only applies to browser-made comments.
- Token totals are what the provider's usage fields report; some local runtimes under-report.

## License

MIT
