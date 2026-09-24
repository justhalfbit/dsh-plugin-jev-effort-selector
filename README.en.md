# dsh-plugin-jev-effort-selector

[中文](README.md) | English · [Design notes](DESIGN.en.md)

Let [Jev](https://typesafe.ai) — a System One model — decide how hard your model should think about each message.

[DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) only lets you switch reasoning effort by hand: greetings burn `high`, and a gnarly refactor arrives while you are still on `low`. This plugin asks Jev once per turn, before the first model call, how much thinking the message deserves, then rewrites the effort for that call.

Jev classifies rather than generates: roughly 500–800 tokens and one to two seconds per decision.

```
hello                                          → Jev Off 100%
rewrite this function to be async               → Jev Medium 99%
design a distributed queue for 1M concurrent... → Jev High 100%
```

The decision appears as a chip beside the composer's model selector.

> For **why** each part is the way it is — what persists, why the envelope has this shape, where the one rule came from, which approaches were rejected — see the [design notes](DESIGN.en.md).

## Features

- 🎚️ **Per-model ladders**: reads the reasoning levels each model advertises and takes the lowest / `medium` / `high`; a model that cannot switch thinking off never receives `off`, and `max` / `xhigh` are never spent automatically
- 🧭 **Context envelope**: tells Jev the facts of the previous turn — the effort used, what the user said, how the assistant left off, how much work happened, whether it finished. About 500–800 tokens; never the conversation history
- 🔁 **Two questions, one call**: how much depth this message needs, and whether it continues the previous task. The second is what separates "what time is it" from "go on" — equally short, but only one inherits the depth of work in flight
- ⚓ **One hard rule**: work still in flight (the turn did not complete, or its todo list still has unfinished items) plus a continuing message keeps at least the previous effort. Everything else is Jev's call — "what time is it" after a heavy refactor drops straight to `off`
- 🎯 **One decision per turn**: every step of a turn, and every retry, runs at the same effort; Jev is asked once per turn
- ✋ **Manual picks win**: change the effort in the selector and Jev sits out that turn
- 💾 **Survives restarts**: the envelope's memory comes from the session log, not plugin memory. After a restart or a long idle, "go on" still knows what the previous turn was doing
- ⬆️ **Ties break upward**: below the confidence threshold, the stronger of the two most likely rungs wins — over-thinking costs a few tokens, under-thinking may cost the answer
- 🛡️ **Silent degradation**: a missing key, network failure, timeout, malformed reply, or unsupported level all leave the caller's effort untouched, without an error or a stall
- ⚙️ **Settings kept by DSH**: the settings UI and the file are two doors to the same values; edits apply hot and the plugin carries no storage of its own (DSH 0.1.5 keeps them in `settings.yaml`, 0.1.7+ in the profile's `cordis.patch.yml`)
- 🔁 **Works on old and new DSH**: one release supports both DSH 0.1.5 and 0.1.7
- 🏷️ **A chip that means something**: `Jev · High · 87%`, with the reason on hover. It lives only in the process — gone after a restart, back after the next decision, exactly as long as the decision it describes
- 🔘 **Per-session switch**: click the chip to turn Jev off for this session alone; other sessions are untouched, and a restart returns to the global setting
- 🔀 **Session-scoped by construction**: decisions, switch, and projections are all keyed by session id; the plugin writes nothing to the session log
- 🎛️ **Custom ladders**: tick rungs per model in the card's "per-model ladders" section (or write `levels` directly), anywhere from 2 to 5; the criteria text adapts to the count

## Install

Prerequisites: [DSH](https://github.com/deepseek-ai/deepseek-harness) installed and `pnpm` on PATH.

```sh
# Install from GitHub (no build step, so no allowBuilds entry is needed)
dsh plugin --profile web add github:justhalfbit/dsh-plugin-jev-effort-selector

# Restart dsh web to load it
```

`web` is the profile behind `dsh web` (the browser UI); substitute your own profile name (`tui`, …) if you use another.
`dsh plugin add` writes the package into the profile's dependencies and appends it to `dsh.profile.bundles` for you — no manual editing.

After the restart, open the settings page and fill in the endpoint and key. Where it lives depends on the DSH version:

- **DSH 0.1.5**: **Settings → Plugins → Plugin settings**, the first card ("Jev 推理选择"); click to expand.
- **DSH 0.1.7+**: sidebar **Plugins** → **dsh-plugin-jev-effort-selector** under Installed; the form is on its detail page.

Uninstall with `dsh plugin --profile web remove dsh-plugin-jev-effort-selector`, then restart. Your configuration stays behind (0.1.5: the `jev-effort-selector` section of `~/.dsh/settings.yaml`; 0.1.7+: the `id: jev-effort-selector` entry of `~/.dsh/profiles/web/cordis.patch.yml`) and can be deleted by hand.

For local development: clone the repository, run `pnpm install`, then `dsh plugin --profile web add link:/absolute/path/dsh-plugin-jev-effort-selector`.

### Interface support

| Runtime | Decision core (intercept / classify / rewrite effort) | Composer chip |
|---|---|---|
| `dsh web` (browser GUI) | ✅ | ✅ |
| `tui` / `headless` | ✅ fully available | ❌ decisions still apply, they are just not shown |

The host half is interface-agnostic; the client half (the chip) declares `platform: "web"` and loads only in the browser UI.

## Configuration

Every field is editable from the settings UI, or directly in the file: on DSH 0.1.5 the `jev-effort-selector` section of `~/.dsh/settings.yaml`, on 0.1.7+ the `config:` of the `id: jev-effort-selector` entry in `~/.dsh/profiles/web/cordis.patch.yml`. The fields are identical:

| Field | Default | Meaning |
|-------|---------|---------|
| `enabled` | `true` | Turn off to keep whatever effort you selected by hand |
| `apiUrl` | empty | Jev System One endpoint; you fill it in. While empty, Jev is never called and the chip says the address is not configured |
| `apiKey` | `''` | Literal-token escape hatch, declared `role('secret')` so it never leaves the Host. Normally left empty |
| `apiKeyEnv` | `JEV_API_KEY` | Credential reference the key is stored under. Not shown in the card; rename it in `settings.yaml` if you need to |
| `model` | `jev-latest` | Jev model route |
| `confidenceThreshold` | `0.6` | Below this, take the stronger of the top two levels |
| `timeoutMs` | `5000` | Give up on Jev; the call keeps the effort its caller resolved |
| `useContext` | `true` | Send a context envelope so follow-ups inherit topic depth |
| `levels` | `{}` | Per-model effort ladder, keyed by `provider/model` |

### Where the API key lives

The key never enters `settings.yaml`. It goes through the harness credentials service — the same path the stock **Settings → Models** page uses for a custom provider's key. The card's "API 密钥" box only writes (`set`) and reads status (`describe`); that status carries whether the reference resolves, which layer supplies it, and whether it is writable, and **has no slot a secret could ride in**, so the value never returns to the browser.

Resolution layers, most trusted first:

```
inherited process environment   read-only, wins
> ~/.dsh/.credentials.yaml      what the settings page writes, mode 0600
> <invocation cwd>/.env         read-only fallback
> ~/.dsh/.env                   read-only fallback
```

Any of these works:

```bash
# 1. type it into the settings card (lands in ~/.dsh/.credentials.yaml)
# 2. export it (highest precedence; the card then shows it as read-only)
export JEV_API_KEY=sk-...
# 3. put it in ~/.dsh/.env
```

When a read-only layer already supplies the reference, the card says so instead of accepting a write that resolution would ignore.

## How the ladder is chosen

Models advertise different effort levels — some cannot disable thinking, some have no `xhigh`. By default the plugin **reads what each model advertises** and takes the weakest rung, `medium`, and `high`:

```
claude-opus-4-6   off · low · medium · high · max          →  off / medium / high
claude-opus-5     off · low · medium · high · xhigh · max  →  off / medium / high
claude-fable-5    low · medium · high · xhigh · max        →  low / medium / high
```

The top rung is deliberately **not** the strongest level advertised: on a route that offers `max` or `xhigh`, making it automatic would spend the most expensive setting on every message Jev finds complex. Those rungs stay available through `levels`.

Override it in the card's **per-model ladders** section: every model offering several levels is listed, each on "auto" with the derived rungs highlighted; switch one to "custom", tick 2–5 rungs, and the card's single Save writes them to `levels`; switching back to "auto" removes that model's entry. Entries the card does not recognise (a retired model, say) are kept as they are.

You can also write `levels` in `settings.yaml` directly, with 2–5 rungs (the criteria text adapts). Each rung needs its own description, so a longer ladder is narrowed to its ends plus an even spread of five — rungs forced to share one description are ones Jev cannot tell apart:

```yaml
jev-effort-selector:
  levels:
    host-llm-gateway/claude-opus-4-6:
      - "off"
      - medium
      - high
    host-llm-gateway/claude-fable-5:
      - low
      - high
```

Models absent from `levels` keep the derived ladder. A configured ladder is intersected with what the route actually advertises: a typo or an unsupported rung is dropped, and fewer than two survivors fall back to derivation. That guard is required — the LLM seam rejects an unsupported effort before provider I/O, with no clamping and no aliasing, so one unchecked typo would fail every first step instead of being ignored.

## The context envelope

Read in isolation, "go on" is a trivial message — Jev calls it `off`, even when the previous turn was designing a distributed transaction engine. "Scan" is worse: one word whose meaning depends entirely on what the assistant just asked.

So with `useContext` on, the plugin tells Jev **the facts of the previous turn**:

```
Context: an ongoing conversation with an AI coding assistant.
Session topic: Diagnose the startup error
Previous turn:
- reasoning effort used: high
- user said: "why does dsh fail to start?"
- earlier the user said: "go ahead"
- assistant ended with: "…fixed both sessions. Want me to scan the remaining 22 for the same framing fault?"
- activity: 14 steps, 9 tool calls
- previous turn outcome: completed
- unfinished todos: 0
```

then the current message. No conversation history, no tool output, no code. User messages are cut at 300 characters, the assistant's tail at 500; the whole envelope lands around 500–800 tokens.

Every fact comes **from the harness's own session log** (`user/message`, `assistant/message`, `step/start`, `tool/call`, `todo/write`, `turn/end`, `request/header`). A host-side projection folds them; the plugin stores nothing — so the first turn after a restart sends the very same envelope it would have sent before.

## Two questions, one rule

In one call, Jev answers two questions:

1. **How much effort** (one rung of this model's ladder)
2. **How this message relates to the previous turn**: `continues` (follows up, confirms, answers a question the assistant asked) or `new` (an unrelated request)

The plugin then does exactly one thing with the answers:

> If it `continues`, **and** the previous turn's work is not finished, never go below the previous effort. Otherwise, Jev's rung stands.

"Not finished" is either of: the previous turn did not end normally (aborted, error, max tokens), or the todo list the previous turn left behind still has unfinished items (pending or in progress).

Measured:

| Previous turn | Message | Relation | Finished? | Result |
|---|---|---|---|---|
| High, heavy refactor | what time is it | new | — | **Off** |
| High, interrupted | go on | continues | no | **High** |
| High, finished | thanks | continues | yes | **Off** |
| High, assistant asked "scan the rest?" | scan | continues (effort confidence 0.16) | yes | tie breaks upward → **High** |

The rule never looks at the words. "What time is it", "what's the time", and every other phrasing go to Jev; the plugin reads three variables — Jev's two answers and the log's completion state.

## Ties break upward

Jev returns a probability distribution. When the top probability is below `confidenceThreshold`, the plugin takes the **stronger** of the two most likely rungs. An uncertain relation is read as `continues` — the anchoring it can trigger only ever keeps depth, never removes it.

Over-thinking costs a few tokens; under-thinking may cost the answer.

→ The trade-off behind each envelope line, why the current message cannot come from the projection, why the rule never reads the words: [DESIGN.en.md §3–4](DESIGN.en.md#3-the-envelope-what-jev-sees)

## When it fails

A missing key, an unreachable endpoint, a timeout, a malformed answer, a level the model rejects — each one leaves the call at the session's current effort. Nothing is thrown and nothing blocks the turn.

Failures are visible: the chip goes muted, drops the confidence, and the tooltip says whether it was a timeout, a failed call, or a missing key. Muted means this effort was not Jev's choice this turn. The next successful turn restores it. → [DESIGN.en.md §11](DESIGN.en.md#11-failure-behaviour)

## How it works

```
session log (events the harness writes itself)
   ├─ user/message · assistant/message · step/start · tool/call · turn/end · request/header
   ↓
jevContext projection (host-only, never wired)   folds the previous turn: words, tail, activity, outcome
   ↓
agent/pre-step (step 1 of each turn)   capture the current user message — it is not in the log yet at decision time
   ↓
agent/request (step 1 of each turn)
   ① you touched the selector's effort (a new model/selection), same model → manual pick, Jev sits out
   ② resolve the levels this model advertises → ladder
   ③ build the envelope → ask Jev → two answers
   ④ apply the one rule → this turn's effort
   ⑤ rewrite LlmCallConfig.reasoningEffort and cache it for the turn
agent/request (steps 2+, retries) reuse the turn's effort; Jev is not asked again
   ↓
request/header                    the harness records the config this request went out with (on change only)
user/message                      the harness commits the step's messages — after the decision
   ↓
jevTurn projection (wired)        moves exactly once per turn; a trigger only: when it moves, the chip refetches
   ↓
chip ←── connection.rpc ──→ jevEffortSelector Remote (host memory: decision + per-session switch)
```

The plugin **writes nothing to the session log**. The persistence read path refuses to load a session containing an event type outside the harness vocabulary (`KNOWN_SESSION_EVENT_TYPES`) unless the envelope carries `ignorable: true` — and `Session.append()` has no way to set that marker. A plugin-owned event type loads fine in the process that wrote it and bricks the log on the next cold read.

**What persists and what does not:**

| | Where | After a restart |
|---|---|---|
| Envelope memory (previous turn) | session log → projection | ✅ present |
| The chip's decision (effort, confidence, reason) | host memory | ❌ empty until the next decision |
| Per-session switch | host memory | ❌ back to the global setting |
| Manual-pick baseline | host memory | ❌ first turn does not detect |

The `jevContext` state lands in `~/.dsh/storages/session_projcache`, including plain-text fragments of user messages and the assistant's tail. It is derived from the log, but it is one more copy.

The Remote is hand-written JavaScript with no generated typert artifact; the gateway's SRC fallback discovers it. The browser calls it through `connection.rpc.call`, because `ctx.remote.*` mounts generated namespaces only. Parameter checking therefore degrades to "JSON by name", and the host validates types itself.

Settings are wired two ways, picked at runtime:

- **DSH 0.1.5**: the host half registers its schema with the `settings` service (persisted in `settings.yaml`); the browser half reads and writes through `settingsScope` and registers a card on `settings.plugin.item`.
- **DSH 0.1.7+**: the host half exports a Cordis `Config` (every field `.volatile()`, persisted in the profile's `cordis.patch.yml`) and `apply` receives live references; the browser half reads and writes through `configForms` and registers the detail-page form on `plugins.bundle.config`.

The browser half lists neither service in `inject` — Cordis has no optional dependency, so listing one would leave the plugin pending forever on the version without it. Each is awaited by its own `ctx.inject` branch instead; the branch whose service is missing simply never runs.

→ Why the chip is not persisted, the per-session switch's boundaries, how the SRC channel was built, why nothing is written to the log: [DESIGN.en.md §7–10](DESIGN.en.md#7-the-chips-lifetime)

## Known behaviour

- With `compat.forceAdaptiveThinking: true` on the provider, `off` does not switch thinking off; it only drops to the minimum. That is gateway behaviour the plugin cannot override.
- **With Jev on, the model selector follows Jev's decisions.** The plugin changes only the outgoing LLM parameter, but the selector shows "the effort this session is running at", derived from the requests recorded in the log. So after switching Jev off, the session stays at Jev's last pick; pick one in the selector to change it. How it works: [DESIGN.en.md §6](DESIGN.en.md#the-model-selector-follows-jev).
- Manual-pick detection compares against the `model/selection` count seen at the last decision, held in memory; the first turn after a restart has no baseline and simply lets Jev decide.
- Switching models is not a manual effort pick: Jev decides afresh for the new route.

## License

MIT
