---
name: code-intel
description: >-
  Two-layer code intelligence for this repo, combining codegraph (AST /
  structural facts) and graphify (AST + LLM semantic concept↔code map). Use
  this whenever you need to understand the codebase: "how does X work",
  architecture / data-flow questions, who calls or is affected by a symbol,
  where something lives, which code implements a concept, why a design choice
  was made, refactor impact analysis, or onboarding to an unfamiliar area.
  Reach for it even when the user doesn't name codegraph or graphify — it tells
  you which of the two layers answers the question and how to chain them. Skip
  only for edits that need no codebase understanding (typos, formatting,
  one-line tweaks in a file already open).
---

# code-intel — codegraph + graphify, combined

This repo has **two** code-intelligence layers. They answer different kinds of
questions, and their real power is using them *together*. Pick the layer by the
shape of the question; escalate from one to the other when the first only gets
you halfway.

| Layer | What it knows | Built from | Freshness | How you call it |
|---|---|---|---|---|
| **codegraph** | structural truth — symbols, call edges, imports, impact, exact source | pure AST | live (~1s after a save) | `mcp__codegraph__*` MCP tools |
| **graphify** | semantic meaning — concept↔code mapping, plain-language explanations, cross-cutting "surprising" links, the *why* | AST **+** LLM | snapshot in `graphify-out/graph.json`; rebuild after changes | `graphify` CLI on `graphify-out/graph.json` |

**One-line rule:** *structural / "who-calls-what / exact code"* → **codegraph**.
*conceptual / "what-means-what / explain / why / which-code-is-about-X"* →
**graphify**. Deep understanding usually wants **both**.

---

## 1. Route the question

Reach for **codegraph** (instant, deterministic, always fresh) when the answer
is a structural fact:

- "How does X work / where is X / what is X?" → `codegraph_explore` (PRIMARY — one
  call returns the verbatim source of the relevant symbols).
- "What calls X / what does X call?" → `codegraph_callers` / `codegraph_callees`.
- "What breaks if I change X?" → `codegraph_impact`.
- "Show me X's full body / the exact overload" → `codegraph_node` (`includeCode:true`).
- "What's the project layout?" → `codegraph_files`.

Reach for **graphify** when the answer is about *meaning* rather than structure,
or spans files in ways AST edges don't capture:

- "Which code implements <concept>?" / "where does the app handle <domain idea>?"
  → `graphify query "<question>"`.
- "Explain <module/symbol> and what it connects to, in plain language." →
  `graphify explain "<node>"`.
- "How is concept A related to concept B?" / "what bridges them?" →
  `graphify path "A" "B"`.
- "What are the surprising / cross-cutting connections here?" → read
  `graphify-out/GRAPH_REPORT.md` (God Nodes, Surprising Connections).
- Anything about **rationale / design intent / why** — graphify stores `why`
  as node attributes; AST can't.

When unsure, start with `codegraph_explore` — it's free and instant. If it
returns the *code* but the user really wanted the *concept* (why it exists, what
domain idea it serves, how it ties to distant code), escalate to graphify.

---

## 2. The combined workflows (the actual value)

Neither layer alone is as strong as the handoff between them.

**Concept → code (top-down).** User asks a fuzzy conceptual question
("where does round-trip fidelity get enforced?"). graphify locates the
conceptual region and names the key nodes; codegraph then gives you the exact
source, callers, and blast radius.

```
graphify query "where is round-trip fidelity enforced?"   # → names nodes/concepts
mcp__codegraph__codegraph_explore  "<the nodes graphify named>"   # → verbatim source
mcp__codegraph__codegraph_impact   "<symbol>"                     # → what a change touches
```

**Code → concept (bottom-up).** You found a symbol structurally but don't grasp
*why* it exists or how it relates to the rest of the system.

```
mcp__codegraph__codegraph_node "<symbol>"   # exact definition
graphify explain "<symbol>"                 # plain-language role + cross-cutting links + rationale
```

**Refactor planning.** `codegraph_impact` gives the hard structural blast radius;
`graphify path "<symbol>" "<distant concept>"` surfaces the *non-obvious*
couplings (shared data, latent dependencies) that AST edges miss. Use both
before a risky change.

Always cite `source_location` from graphify output, and treat **codegraph as the
source of truth for structure** — if graphify (a snapshot) and codegraph (live)
disagree about a call edge or a symbol's existence, codegraph wins; the graph is
probably stale (see §4).

---

## 3. Make sure the graphify graph exists (auto-build)

graphify answers require `graphify-out/graph.json`. Before the first graphify
command in a session, check for it:

```bash
ls graphify-out/graph.json 2>/dev/null && echo "ready" || echo "needs build"
```

If it's missing, **build it**. There are two tiers — pick by what's available;
no API key is needed for the default tier.

**Default (no API key — this machine):** AST-derived graph. Fast, free, no key.
You still get real nodes, structural edges, community clustering, the
`query`/`explain`/`path` traversal, and `GRAPH_REPORT.md`.

```bash
graphify update .          # builds graphify-out/graph.json from AST alone, no LLM
```

**Full semantic tier (needs an LLM):** adds concept nodes from docs, the *why*
behind code, and cross-modal "surprising" links AST can't see. Only take this
path when a key is set or the user wants the richer graph:

- `GEMINI_API_KEY` / `GOOGLE_API_KEY` set → `graphify extract .` (auto Gemini, fastest).
- `ANTHROPIC_API_KEY` set → `graphify extract . --backend claude`.
- `OPENAI_API_KEY` / `DEEPSEEK_API_KEY` set → `graphify extract . --backend openai|deepseek`.
- No key but you want semantics anyway → run the interactive `/graphify` pipeline
  (it uses Claude Code subagents as the LLM, so it needs no key). `graphify extract`
  is headless and **cannot** do this — it errors without a key.

> Don't claim graphify gives you LLM-semantic concept↔code links unless the graph
> was built with the full tier. The default AST graph's edges are structural —
> its added value over codegraph is clustering, the report, and graph traversal,
> not semantic meaning.

The full tier runs an LLM over the source — minutes and tokens. Tell the user
it's building and why; don't do it silently on a throwaway question. A purely
structural question can always be answered with codegraph alone, no build needed.

---

## 4. Keep the graph fresh after code changes

codegraph self-updates within ~1s. graphify is a snapshot and goes stale.

- **Code changed** (most cases here — this is a TS project): refresh AST edges
  with no LLM call:
  ```bash
  graphify update .          # AST-only re-extract of changed code, no LLM, fast
  ```
- **Docs/comments/design intent changed**: only matters if the graph was built
  with the full semantic tier (§3). If so, re-run the full build to pick up the
  new meaning; `graphify update .` will flag that a semantic rebuild is pending.
  On an AST-only graph, doc changes don't affect the graph at all.
- **Check before trusting an answer**: `graphify check-update .` reports whether
  a semantic rebuild is pending.

If a graphify answer contradicts the current code, assume staleness: confirm the
structural fact with codegraph and run `graphify update .`.

---

## 5. Command quick-reference

**codegraph** (MCP tools — call directly, no shell):
`codegraph_explore` (primary; verbatim source for a question or symbol bag) ·
`codegraph_search` (locate a name) · `codegraph_callers` / `codegraph_callees` ·
`codegraph_impact` · `codegraph_node` (one symbol's full body) · `codegraph_files`.

**graphify** (shell CLI; default graph path is `graphify-out/graph.json`):

```bash
graphify query "<question>"            # BFS over the semantic graph — broad context
graphify query "<question>" --dfs      # DFS — trace one specific chain A→…→B
graphify query "<question>" --budget 3000   # cap answer size (default 2000 tokens)
graphify explain "<node>"              # plain-language explanation of one node + neighbors
graphify path "<A>" "<B>"              # shortest semantic path between two concepts
graphify update .                      # build / refresh AST graph (no LLM, no key)
graphify extract .                     # full AST+LLM (re)build — needs an API key (§3)
graphify check-update .                # is a semantic rebuild pending?
```

Answer from what the graph output actually contains — quote `source_location`
when citing a fact, and never invent an edge. If the graph lacks the
information, say so and fall back to codegraph or a direct read.
