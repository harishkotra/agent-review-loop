# agent-review-loop

A review-loop harness that measures whether an AI agent actually fixed what a human reviewer asked it to fix in a [slashdocs](https://github.com/razorpay/slashdocs) document.

slashdocs gives agents a place to publish reviewable self-contained HTML, and gives humans anchored comments on the exact words. What nobody had measured is the thing that matters: when the agent pushes the next version, **did it change the text each comment was anchored to, or did it rewrite the whole document and hope nobody noticed?**

agent-review-loop runs that loop end to end and scores it with real numbers computed
from the run. It is a measurement instrument, not a doc generator. The human comments
are the ground truth; the agent's own claims are not.

<img width="2022" height="1047" alt="Screenshot at Oct 14 23-56-34" src="https://github.com/user-attachments/assets/445ea4c2-d35a-4ccd-a4ae-88cb89db155d" />
<img width="2115" height="1130" alt="image" src="https://github.com/user-attachments/assets/eb130e0c-9214-44ce-8853-76b5d481fc63" />
<img width="2119" height="1026" alt="image" src="https://github.com/user-attachments/assets/3d3e3be1-9877-456b-97ed-d4b7e4bbd120" />
<img width="2115" height="1018" alt="image" src="https://github.com/user-attachments/assets/64aa7ae8-0949-49c2-897a-17f1fa117d6b" />
<img width="2108" height="1028" alt="image" src="https://github.com/user-attachments/assets/79674166-c19e-4687-b871-791321794077" />


## What it measures

| Metric | Definition |
|---|---|
| **Attribution rate** | `edited / actionable comments`. A comment is actionable when it is open and carries an anchor quote. `stale_anchor` comments are excluded from the denominator and never counted as addressed. |
| **Collateral churn** | characters changed **outside** every comment anchor ÷ total characters changed, from the character-level v1→v2 diff (`diff-match-patch`). A high attribution rate with high churn means the agent rewrote the document instead of editing it. |
| **Claim accuracy** | agent claims that match the computed verdict ÷ comments. Every mismatch is shown explicitly. |
| **Cost per attributed fix** | total usage tokens for the run (prompt + completion, read from the API response) ÷ edited count. Shown in tokens; no currency figure is invented. |
| **Rounds to converge** | number of pushes until no unresolved actionable comments remain (cap: 3). |

If a metric cannot be computed for a run, it prints `N/A` with the reason. It never prints a zero or a placeholder where a real measurement was impossible.

Verdicts per comment, computed from the text, never from the model:

- **edited** — v2 text at the re-anchored region differs from the v1 quote after whitespace normalization.
- **untouched** — identical.
- **deleted** — the quote cannot be found in v2 and no fuzzy match clears the threshold.
- **stale_anchor** — the comment's `created_on_version_id` predates the version the agent was given, and its quote is absent from that version. Excluded from the denominator, never counted as addressed, surfaced verbatim: `ATTRIBUTION: STALE ANCHOR - quote not found in current version; comment left unresolved`

When the model claims a fix the diff does not show, the UI prints verbatim: `VERIFICATION: MODEL CLAIMED ADDRESSED - ANCHORED TEXT UNCHANGED`

## The anchor contract

A slashdocs comment carries an anchor in the W3C Web Annotation shape (`frontend/bridge/anchoring/types.ts`):

```
{ quote, prefix, suffix, dom_path, start_offset, end_offset }
```

`quote/prefix/suffix` are a TextQuoteSelector. `start_offset`/`end_offset` are character offsets into the **document body's raw `textContent`**, and `dom_path` is always `"body"`. The comment object also carries `id`, `document_id`, `version_id`, `created_on_version_id`, `author`, `body`, `status`, `created_at`, `resolved_at`, `replies` — all confirmed against live `slashdocs docs comments list --json` output.

### Extractor verification (real numbers)

We authored a tiny document, published it, selected a known sentence **in the real browser viewer**, left a comment, and compared slashdocs' stored offsets against the offsets our jsdom extractor computes for the same sentence:

| | start_offset | end_offset |
|---|---|---|
| slashdocs viewer (stored anchor) | **10** | **73** |
| agent-review-loop jsdom extraction | **10** | **73** |

The stored prefix (`"\nTiny Doc\n"`) also matched our extraction exactly. The two numbers compared: **10/73 vs 10/73 — agreement**.

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

## Quickstart

**Prerequisites**

| What | Why | Get it |
|---|---|---|
| Node ≥ 20 | runtime | https://nodejs.org |
| `slashdocs` CLI on PATH | all document/comment access | https://github.com/razorpay/slashdocs — `git clone … && make build-cli && cp bin/slashdocs ~/.local/bin/` (or a release archive from the releases page) |
| An OpenAI-compatible endpoint + key | authoring + the revision agent | Particle, LM Studio (`http://localhost:1234/v1`, no key), Ollama (`http://localhost:11434/v1`), Gemini — anything that speaks `/chat/completions` with tool calling |

```bash
npm install
npm run doctor      # checks node, CLI, local server + folder, model reachability — with fixes
npm run dev         # client http://localhost:5173, server :3001
```

Open **http://localhost:5173**. The Setup panel shows your **Environment** status (✓/✗ per check, re-runnable) and a **real recorded example run** you can browse — verdicts, metrics, trace, evidence — with no API key and no tokens spent.

![Setup with environment checks and example](docs/screenshots/setup.png)

Then: **settings** → pick a preset (or type your base URL + key + model) → **Test connection** → back to Setup → click a **sample brief** (release readiness, incident postmortem, ADR, product spec, churn analysis, QA findings) → **create run** → **author v1** → open the viewer URL, select words, leave comments (the Run panel lights a "N new" badge within 5 s) → **run revision agent + score** → Verdicts and Scorecard.

![Verdicts: quote, claim vs computed verdict, before/after at anchor](docs/screenshots/verdicts.png)
![Scorecard: the five metrics from the real diff](docs/screenshots/scorecard.png)

**Production mode** (single port, built client):

```bash
npm run build && npm start    # serves client + API on :3001
```

**Headless**: `cp .env.example .env`, put `PARTICLE_API_KEY=` in it, then `npm run smoke`. Model selection for the two-model test comes from `MODEL_A`/`MODEL_B` in `.env`.

### slashdocs access modes (selectable in the UI)

- **local (default, zero infra):** `slashdocs --local …`. A local document's id is its path in the documents folder (default `~/slashdocs`), e.g. `report.html`. Viewer: `http://slashdocs.localhost` (port 80, or 7070 if 80 is taken). Local mode has comments but no version history, labels, folders, grants, or search — the harness snapshots every version into `runs/<runId>/`.
- **server:** `SLASHDOCS_SERVER` + `SLASHDOCS_TOKEN` (a service-account key, `slashdocs_sa_…`) for headless runs. Adds immutable versions; runs mirror them.

On server mode, `docs push` can fail with **exit code 5 = version conflict**. The harness re-pulls the document, tells the agent to re-apply its changes, and retries **once**. If it conflicts again it records `VERSION CONFLICT - another writer pushed first; run aborted without clobbering` and stops. Never a blind-retry loop.

### Flow

1. **Setup** — mode, model config, brief or existing document id.
2. **Author v1** — the LLM writes one self-contained HTML file following `slashdocs guidelines all`; published; viewer URL shown.
3. **Human review** — manual and explicit: open the doc, select words, comment. The Run panel polls the CLI every 5 s and lights a "N new" badge when you post; "Re-check comments" pulls `comments.before.json`.
4. **Revision run** — the agent gets the document and only the unresolved actionable comments, with five thin CLI tools: `list_comments()`, `pull_document()`, `resolve_comment(comment_id)`, `reply_comment(comment_id, body)` (every comment the agent does *not* fix must get a visible reply in slashdocs explaining why), `push_version(html_path, summary)` (summary: one line per comment, `<comment id>: <what changed>`).
5. **Verify and score** — verdicts and metrics computed from the actual v1/v2 text.
6. **Report** — scorecard in the UI, plus a self-contained HTML scorecard published back to slashdocs as its own document.

The agent must return a structured report after the tool loop, enforced with a separate `response_format: json_object` call (validated against a zod schema):

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
npm run doctor                    # environment preflight with actionable fixes
npm run smoke                     # clean case end-to-end against a locally served slashdocs doc
npx tsx scripts/score-test.ts    # synthetic scoring-engine checks (no LLM)
npx tsx scripts/stale-test.ts    # stale-anchor failure path
npx tsx scripts/two-model-test.ts # identical doc+comments, two models
```

### Test case results (real numbers)

All three cases were run end to end against a locally served slashdocs document with Particle `deepseek-v4.1-flash` (and `glm5.3flash` for case 3). Output below is pasted from the actual runs; every number traces to `runs/<runId>/`.

**1. Clean run** (`npm run smoke`, run `b0ead130`) — v1 authored from brief, four anchored comments on different sentences, agent revised:

```
Attribution rate         75.0%          3 edited / 4 actionable (stale anchors excluded)
Collateral churn         0.2%           1 of 652 changed chars outside anchors
Claim accuracy           75.0%          3/4 claims match computed verdicts
Cost per attributed fix  18552 tokens   55655 tokens total (37114 prompt + 18541 completion) / 3 edited
Rounds to converge       1              1 push(es) until no unresolved actionable comments remained

verdicts: W5Z2RT=untouched, Q2QNHA=edited, E73BWM=edited, LF4HDU=edited
claim mismatches:
  W5Z2RTFJFCGMEHZTBYBY3DBU4W: VERIFICATION: MODEL CLAIMED ADDRESSED - ANCHORED TEXT UNCHANGED
```

Attribution ≥ 3/4 ✓ and churn < 35% ✓ — and the instrument caught the model claiming a fix on a span it left byte-identical.

A second, later `npm run smoke` (run `07e4a1d4`) shows the run-to-run variance the instrument exists to expose — same pipeline, different numbers:

```
[smoke] run 07e4a1d4 created
[smoke] v1 published: doc=07e4a1d4.html url=http://slashdocs.localhost/app/d/07e4a1d4.html
===== SMOKE METRICS (computed from the v1/v2 diff) =====
Attribution rate         75.0%          3 edited / 4 actionable (stale anchors excluded)
Collateral churn         37.1%          170 of 458 changed chars outside anchors
Claim accuracy           N/A            N/A — agent returned no structured claims
Cost per attributed fix  15022 tokens   45066 tokens total (30343 prompt + 14723 completion) / 3 edited
Rounds to converge       1              1 push(es) until no unresolved actionable comments remained
verdicts: GLMUXU=edited, EO3QWK=deleted, NZAD23=edited, 7PEDUC=edited
[smoke] scorecard published: http://slashdocs.localhost/app/d/07e4a1d4-scorecard.html
[smoke] evidence bundle: runs/07e4a1d4/
```

Here the agent deleted one anchored sentence outright (`deleted`, not counted as addressed) and reflowed 170 characters outside any anchor — churn 37.1%, above the 35% clean-run bar. Reported as measured, not as hoped.

**2. Stale anchor** (`scripts/stale-test.ts`, run `804627c0`) — comment on a v1 sentence, human pushes a version deleting it, then the agent runs:

```
[stale] version at comment time: 0d52ddb20a1d9bdd
[stale] human push rotated version to 0e711c5c21294719; doomed sentence removed
doomed comment verdict: stale_anchor
on-screen string: ATTRIBUTION: STALE ANCHOR - quote not found in current version; comment left unresolved
other comment verdict: untouched
attribution: 0.0% (0 edited / 1 actionable (stale anchors excluded))
doomed comment status in slashdocs after run: open
STALE TEST PASS
```

Exact string printed ✓, comment excluded from the denominator ✓, still unresolved in slashdocs ✓, no silent re-anchor ✓.

**3. Two models** (`scripts/two-model-test.ts`) — byte-identical document (`runs/b0ead130/v1.html`) with the same four comments on each copy:

```
deepseek-v4.1-flash  (run d18dab6c)
  Attribution rate         0.0%           0 edited / 4 actionable (stale anchors excluded)
  Collateral churn         N/A            N/A — v1 and v2 text are identical; nothing changed
  Claim accuracy           100.0%         4/4 claims match computed verdicts
  Cost per attributed fix  N/A            N/A — zero attributed fixes; division undefined
  Rounds to converge       0+             N/A — did not converge

glm5.3flash  (run ff2e62d3)
  Attribution rate         50.0%          2 edited / 4 actionable (stale anchors excluded)
  Collateral churn         46.9%          202 of 431 changed chars outside anchors
  Claim accuracy           N/A            N/A — agent returned no structured claims
  Cost per attributed fix  14794 tokens   29587 tokens total (24341 prompt + 5246 completion) / 2 edited
  Rounds to converge       1              1 push(es) until no unresolved actionable comments remained

OK: different measurements — 18036 vs 29587 tokens, 0.0% vs 50.0%
```

Two different attribution rates and two different token totals on identical input — the harness is measuring the models, not itself. Note glm5.3flash's 46.9% churn: it fixed two anchors while rewriting large unanchored stretches — exactly the failure mode attribution rate alone would miss.

## Architecture

```mermaid
flowchart LR
  subgraph client["client — Vite + React :5173"]
    UI["Setup · Run · Verdicts · Scorecard · Publish<br/>settings panel (localStorage)"]
  end
  subgraph server["server — Hono :3001"]
    API["REST /api/*"]
    AG["revision agent<br/>OpenAI Agents SDK TS<br/>5 tools · trace processor"]
    SC["scoring engine<br/>anchoring.ts + diffing.ts"]
    RS[("runs/&lt;id&gt;/ evidence store")]
  end
  CLI["slashdocs CLI<br/>execFile array + --json, 60s"]
  SD["slashdocs<br/>local (documents folder)<br/>or server (SA token)"]
  LLM["OpenAI-compatible API<br/>Particle · Ollama · LM Studio · Gemini"]

  UI -- "/api proxy" --> API
  API --> AG -- chat/completions + tools --> LLM
  AG -- "list/pull/resolve/reply/push" --> CLI
  API --> CLI --> SD
  API -- "v1/v2 text" --> SC
  SC -- "verdicts.json · metrics.json" --> RS
  API <--> RS
```

Request lifecycle of one run:

1. `POST /api/runs` — snapshot model + slashdocs config (key kept in memory only), write `brief.md`.
2. `POST /api/runs/:id/author` — one plain `fetch` to `/chat/completions` writes v1 (single self-contained HTML following `slashdocs guidelines all`) → `docs create` → viewer URL.
3. Human comments in the slashdocs viewer; the Run tab polls `GET /api/runs/:id/comments/count` every 5 s (the "N new" badge).
4. `POST /api/runs/:id/revise` — pull the current version as the base snapshot (`v1.html`), run the agent loop (up to 3 rounds), then `docs pull` → `v2.html`.
5. The scoring engine diffs `v1.html`→`v2.html` in **body-textContent space** (the same space slashdocs anchors into), producing `verdicts.json` + `metrics.json`.
6. `POST /api/runs/:id/scorecard` renders the measured results as its own slashdocs document.

Integrity control inside the loop: after every agent round the harness re-diffs and **reopens any comment the agent resolved while its anchored text stayed untouched** — resolution without an edit is never convergence.

## Key code

**Every slashdocs call is an argv array, never a shell string** (`server/src/slashdocs.ts`):

```ts
const full = [...(cfg.mode === 'local' ? ['--local'] : []), ...args, '--json']
const { stdout } = await execFileP(cfg.cliPath || 'slashdocs', full, {
  timeout: 60_000, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, /* SLASHDOCS_SERVER / SLASHDOCS_TOKEN in server mode */ },
})
```

**Verdicts come from the text, never the model** (`server/src/scoring.ts`):

```ts
const v1loc = locateInOriginal(v1, anchor)          // offsets first, confirmed against quote
const v2loc = reanchor(v2, anchor)                  // exact → prefix/suffix → fuzzy (±200 chars, 0.5)
if (!v2loc) verdict = 'deleted'
else verdict = normWs(v2.slice(v2loc.start, v2loc.end)) === normWs(v1.slice(v1loc.start, v1loc.end))
  ? 'untouched' : 'edited'
```

**The agent's tools are thin CLI wrappers** (`server/src/agent.ts`) — `list_comments`,
`pull_document`, `resolve_comment`, `reply_comment`, `push_version`. `push_version`
accepts the full revised HTML (or a path), snapshots `v2.html` after a successful
push, and on exit code 5 re-pulls and lets the agent retry **once** before recording
`VERSION CONFLICT - another writer pushed first; run aborted without clobbering`.

**Collateral churn** (`server/src/diffing.ts`) runs `diff-match-patch` at character
level over the two body texts; every changed run is inside an anchor if it overlaps
any comment's v1 span or re-anchored v2 span — everything else is collateral.

## Contributing

Fork → clone → `npm install` → `npm run doctor` → `npm run dev`. The scoring engine
has a no-LLM test suite (`npx tsx scripts/score-test.ts`) that runs in seconds — extend
it with any change to `anchoring.ts`, `diffing.ts`, or `scoring.ts`.

Good first issues / roadmap ideas:

- **Server-mode e2e** — spin up slashdocs via docker compose and exercise immutable versions + a real exit-5 conflict between two concurrent writers.
- **SSE instead of the 5 s poll** — push comment counts to the Run tab the moment the CLI sees them.
- **Per-section churn** — attribute collateral edits to document sections, not just inside/outside.
- **Batch harness** — N documents × M models → one aggregate scorecard (the sample-size limitation above is the motivation).
- **Mastra swap** — implement `server/src/agent.ts` against `@mastra/core` keeping the five tools and the run record identical; the run bundle is the contract.
- **Trace replay UI** — render `trace.json` as a timeline of generations/tool calls.

Please don't: add LLM-as-judge scoring into the verdict path (the human comment is the
ground truth), or synthesise any number that could come from a real run.

## Framework swap note

The revision agent is swappable to [Mastra](https://mastra.ai) (`@mastra/core`): keep the same four tools (they are thin CLI wrappers) and the same run record on disk — only `server/src/agent.ts` changes. This repo ships the OpenAI Agents SDK implementation; Mastra is documented, not built.

## Honest limitations

- **Fuzzy re-anchor threshold.** In-place rewrites are matched by sentence scoring at 0.5 similarity within ±200 chars. A rewrite that shares almost no words with the quote reads as `deleted`, even if a human would call it "fixed". Every fuzzy verdict carries its similarity score.
- **Local mode has no versions.** Version ids rotate with content but there is no history; the harness's own snapshots in `runs/<runId>/` are the record.
- **Single-run sample sizes.** One run is one observation. Attribution rate on 4 comments is a ratio of small integers — treat differences of one comment as noise.
- **CLI-created comments carry only `quote`** (no offsets); browser comments carry full anchors. Offset-based v1 location only applies to browser-made comments.
- Token totals are what the provider's usage fields report; some local runtimes under-report.

## License

MIT — see [LICENSE](LICENSE).
