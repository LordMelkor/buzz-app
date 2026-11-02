# Inspect a live agent session

From a buzz-app checkout:

```sh
bin/node scripts/session-debug.mjs '<thread-id or buzz://message link>'
```

The command opens a private loopback URL in your browser and follows Codex or
Claude JSONL records once a second. Leave the command running. Ctrl+C stops it.
It does not resume an agent, execute transcript content, or send data to a relay.
For a known file use `--file /absolute/session.jsonl`. `--no-open` prints the URL
without opening it. A partial last JSONL line is retried on the next refresh;
malformed complete records produce a visible error, not silent omission.

The left rail is one vertical wall-time chart for the whole session, with time
running downward. Active time is proportional: inference, tools, inference
overlapping a tool, and **unattributed** gaps (a run is active but no model or
tool activity is recorded). **Idle** time between runs, when the agent waits for
the next prompt, collapses to a labeled break. The legend totals each category;
overlap is counted once, never added to wall time. Tool time is call-to-result
elapsed time, not subprocess CPU time. Beside each inference, a thin mark shows
its new (uncached) tokens; hover it for the full context window and cache share.
Hover or focus a bar segment for its timing and tool names; click either to jump
the conversation to that record.

Native transcripts do not expose exact provider request start times. Inference
bars are explicitly estimated from the preceding logged input/result through
observed model output, and can include queue, prefill and dispatch overhead. With
no usable output boundary, the chart shows an untimed inference and leaves that
time unattributed. An explicit running turn extends to now; legacy sessions with
no completion record end at their last recorded message. Claude's zero-usage
`<synthetic>` replies and queue bookkeeping are not counted as activity. The chart
uses UTC to match the transcript timestamps.

Each inference shows new-input, cache-read, cache-write (when nonzero), and output
tokens. Token counts are the default cost view. Optional dollar estimates appear
only when rates are supplied; missing prices do not produce placeholder warnings.
For Codex, cached tokens are part of input and are subtracted to find new input.
Claude already reports new input separately. Neither provider's cache usage is
counted twice.

The conversation stays on the right, under one line naming the harness, model
and reasoning effort (when the transcript records it). Messages the agent posted
to Buzz are highlighted; plain assistant text was never sent. Search filters the
conversation. The view follows new records while it is scrolled to the bottom
and leaves your position alone otherwise; expanded disclosures survive updates.
These are recorded transcript views, not exact reconstructed HTTP inference
requests. When multiple sessions match a thread, such as two agents answering
in it, a picker names each by agent (from the identity line in its recorded
prompt) and harness. A start time tells two sessions of one agent apart. The
most recently active opens first and stays on screen until you pick another.
Thread discovery checks user delivery envelopes, rather than matches in tool
outputs that merely quoted a thread. Channel-scoped
sessions and DMs may require `--file`, and can contain multiple Buzz threads.

## Recorded fields and cost

**Prompt** opens what the model received before its first response. Instructions
are tagged with the role they were sent as (System, Developer, User, or Settings
for run configuration) and render as Markdown: the system prompt first, then
the rest in recorded order. Tools show one row per tool, opening to its
description and JSON schema. Context injected later, such as Claude's
reminders, stays in the conversation as faint rows.

Codex supplies `session_meta.base_instructions`, `dynamic_tools`, developer/user
messages, response items, lifecycle events, and token usage when supported by its
CLI version. Run settings (approval, sandbox, collaboration mode, effort) come from
`turn_context` and show again when they change. Codex does not record its native
tool schemas, such as shell and apply_patch. The viewer prefers per-response `token_usage_record`, deduplicates
response IDs, and falls back to changes in cumulative token counts. It does not
add those two sources together. The chart uses timestamp intervals to account for
wall time; recorded `duration_ms` remains available in raw records.

Claude's native transcript supplies messages and usage. Claude also writes a
`prompt_snapshot` with the system prompt and tool schemas, shown once per change,
and the rendered text and role of each reminder it injects (environment, skills,
CLAUDE.md, hook context). Request framing, such as billing and SDK system blocks,
beta headers and deferred tool schemas, is not recorded. Content blocks can repeat
the same message ID and usage; the viewer counts each response once. Legacy turn
boundaries are inferred from user messages; tool results do not start turns.
Without a completion event the viewer does not pretend that the last token's
arrival proves completion. Inferred boundaries are labeled.

Dollar costs are unavailable unless reported or a rate file is supplied. They are
never represented as zero merely because the account uses a subscription. Claude
result totals are process-cumulative; the viewer derives differences within each
captured launch and labels the result. Exact billing can differ from API estimates.

To estimate costs, create a JSON object keyed by exact model ID with USD per
million token rates, then pass `--rates /path/to/rates.json`:

```json
{"your-model-id":{"input":2,"output":10,"cached":0.2,"written":2.5}}
```

These are illustrative rates, not current pricing. Supply all four rates. No
models or prices are guessed. The UI labels estimates. For Claude, input excludes
cache reads and writes; for Codex those are subtracted from inclusive input before
pricing. Models with tiered context, service tiers, or cache TTL pricing need rates
appropriate to the inspected usage; the simple estimator does not infer tiers.

## Storage and older exports

Discovery reads `sessions` and `archived_sessions` in Buzz's Codex home and in
`$CODEX_HOME` (default `~/.codex`), which holds threads from older Buzz builds, and `$CLAUDE_CONFIG_DIR/projects` (default `~/.claude`). Compressed
`.jsonl.zst` rollouts must be decompressed to a local file first and opened with
`--file`. The server is bound to 127.0.0.1, uses an unguessable path, rejects foreign
Host/Origin requests, and serves only its three assets and selected transcript.

For standalone snapshots, the existing
[Codex](view-codex-session.md) and [Claude](view-claude-session.md) exporters remain
available. A snapshot does not update.
