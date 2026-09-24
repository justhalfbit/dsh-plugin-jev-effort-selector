/**
 * dsh-plugin-jev-effort-selector — host half.
 *
 * Asks the Jev System One model which reasoning effort each user message
 * deserves, then rewrites `LlmCallConfig.reasoningEffort` for that turn.
 *
 * Registrations:
 *
 * 1. The plugin's settings. The schema declared here validates every field
 *    and the harness persists edits — the plugin owns no storage of its own.
 *    DSH ≤ 0.1.5 keeps them in settings.yaml (registered namespace
 *    `jev-effort-selector`); DSH ≥ 0.1.7 keeps them as this row's Cordis
 *    config (the exported `Config`). The form the user sees is always the
 *    browser half's own; see `settingsFields`.
 * 2. Two session projections, both folds over the harness's OWN events (this
 *    plugin appends NOTHING to the session log):
 *    - `jevTurn` (wired to the browser): moves once per turn, right after
 *      the turn's decision is made. The chip subscribes to it as its refresh
 *      trigger and fetches the decision itself from the Remote.
 *    - `jevContext` (host-only): what the previous turn looked like — the
 *      user's words, how the assistant left off, how much work it did, and
 *      whether it finished. This is the envelope's memory, and because it is
 *      rebuilt from the log it survives restarts; the plugin holds no
 *      cross-turn state of its own.
 * 3. `agent/pre-step` (capture the current user text — it is not in the log
 *    yet when the decision runs) and `agent/request` (decide once per turn,
 *    then replace the frozen call config on every step of that turn).
 * 4. A small SRC-mode Remote (`jevEffortSelector`) the browser half calls
 *    for the per-session switch and the latest decision.
 *
 * Failure is always silent and non-blocking: a missing key, a transport
 * error, a timeout, or an unparseable answer all leave the caller's original
 * effort untouched.
 * @module dsh-plugin-jev-effort-selector
 */

import { z as zod } from 'zod'
import z from '@deepseek-ai/schemastery'

/** Settings namespace owned by this plugin. */
const NS = 'jev-effort-selector'

/** Wired projection key: the chip's once-per-turn refresh trigger. */
const TURN_KEY = 'jevTurn'

/** Host-only projection key: the previous turn, as the envelope needs it. */
const CONTEXT_KEY = 'jevContext'

/** Wire namespace of the SRC-mode Remote the browser half calls. */
const REMOTE_NS = 'jevEffortSelector'

/**
 * Envelope size knobs. Jev is a classifier, so a few hundred extra tokens of
 * context cost little, while a one-word reply ("ok", "go") is unreadable
 * without the words it answers. Tune here, not inline.
 */
const USER_TEXT_CHARS = 300
const ASSISTANT_TAIL_CHARS = 500
const USER_TEXTS_PER_TURN = 3

/** `turn/end` reason kinds that mean the turn finished its work. */
const COMPLETED_KINDS = new Set(['completed'])

/** Effort ids ordered weakest to strongest, used to rank unknown ids. */
const RANK = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/**
 * Criteria text per level count. Jev is a classifier: these descriptions are
 * the whole prompt, so they carry the examples that separate the levels.
 */
const CRITERIA = {
  2: [
    'Simple: greetings, thanks, confirmations, yes/no, simple factual recall, basic formatting, short acknowledgments',
    'Complex: architecture design, deep analysis, performance optimization, multi-file refactoring, debugging, non-trivial code generation',
  ],
  3: [
    'Trivial: greetings, thanks, confirmations, yes/no, simple factual recall, basic formatting, short acknowledgments',
    'Moderate: standard code generation, summarization, translation, explaining a concept, simple debugging, routine file operations',
    'Complex: multi-file refactoring, architecture design, performance optimization, mathematical proofs, security analysis, debugging race conditions',
  ],
  4: [
    'Trivial: greetings, thanks, yes/no, simple facts, acknowledgments',
    'Simple: basic code edits, quick lookups, straightforward questions, formatting',
    'Moderate: standard code generation, explanations, simple debugging, routine refactoring',
    'Complex: architecture design, deep analysis, multi-file refactoring, performance optimization, proofs',
  ],
  5: [
    'Trivial: greetings, thanks, yes/no',
    'Simple: basic edits, quick lookups',
    'Moderate: standard code generation, explanations',
    'Hard: complex debugging, multi-file changes',
    'Extreme: architecture design, proofs, deep system analysis',
  ],
}

/** Longest ladder {@link CRITERIA} can describe with one distinct text per rung. */
const MAX_LADDER = 5

/**
 * Reduce a ladder to at most {@link MAX_LADDER} rungs, keeping the weakest,
 * the strongest, and an even spread between them.
 *
 * Every rung needs its own criteria text. Padding a longer ladder with a
 * repeated description would hand Jev two rungs it cannot tell apart, making
 * the choice between them arbitrary — worse than not offering them at all.
 * @param ladder - candidate ids, weakest first.
 * @returns at most `MAX_LADDER` ids, order preserved.
 */
function clampLadder(ladder) {
  if (ladder.length <= MAX_LADDER) return ladder
  const step = (ladder.length - 1) / (MAX_LADDER - 1)
  const picked = []
  for (let i = 0; i < MAX_LADDER; i += 1) {
    const id = ladder[Math.round(i * step)]
    if (!picked.includes(id)) picked.push(id)
  }
  return picked
}

/**
 * The plugin's settings fields, declared once for both DSH generations.
 *
 * - Up to 0.1.5 the harness keeps settings in `settings.yaml`; the plugin
 *   registers `SettingsSchema` with the `settings` service.
 * - From 0.1.7 that registration is gone. A plugin exports a Cordis `Config`
 *   whose `.volatile()` fields the settings form edits; values live in the
 *   profile's `cordis.patch.yml` under this row's id (`jev-effort-selector`,
 *   the same name as the old section, which is what lets 0.1.7 import an old
 *   `settings.yaml` section into it on its first start). `apply` receives
 *   live references and reads them with `.get()`.
 * @param volatile - mark every field volatile (the `Config` form).
 */
function settingsFields(volatile) {
  const v = (schema) => (volatile ? schema.volatile() : schema)
  // The browser form repeats the number bounds and the defaults below
  // (FIELDS in lib/client.js) — the bounds to check them before Save, the
  // defaults for 恢复默认 to show; keep the two in step.
  const fields = {
    enabled: z.boolean().default(true)
      .description('Let Jev choose the reasoning effort. When off, your manual selection is kept.'),
    apiUrl: z.string().default('')
      .description('Full URL of the Jev System One endpoint. No default: until the user fills it in, Jev is never called.'),
    apiKey: z.string().default('').role('secret')
      .description('Literal token, kept only as an escape hatch. `role(\u2018secret\u2019)` strips it from every settings read, so it never reaches the browser; the credential reference below is the supported path.'),
    apiKeyEnv: z.string().default('JEV_API_KEY').role('credential-ref')
      .description('Credential reference resolved through the credentials service: the launching environment, then $DSH_HOME/.credentials.yaml, then the .env fallbacks.'),
    model: z.string().default('jev-latest')
      .description('Jev model route, e.g. jev-latest.'),
    confidenceThreshold: z.number().min(0).max(1).default(0.6)
      .description('Below this confidence, take the stronger of Jev\u2019s two most likely levels.'),
    timeoutMs: z.number().min(500).max(30000).default(5000)
      .description('Give up on Jev after this long and leave this call\u2019s effort as the caller resolved it.'),
    useContext: z.boolean().default(true)
      .description('Send a context envelope describing the previous turn (effort used, what the user said, how the assistant left off, activity, whether it finished) so follow-ups like \u201Ccontinue\u201D inherit the topic\u2019s depth.'),
    levels: z.dict(z.array(z.string())).default({})
      .description('Per-model effort ladder, keyed by "provider/model". Omit a model to derive its ladder from the levels it advertises.'),
  }
  return Object.fromEntries(Object.entries(fields).map(([key, schema]) => [key, v(schema)]))
}

/** Older DSH (≤ 0.1.5): the schema registered with the `settings` service. */
const SettingsSchema = z.object(settingsFields(false))

/** Newer DSH (≥ 0.1.7): the plugin's Cordis config, edited by the settings form. */
const Config = z.object(settingsFields(true))

/** Every field at its default — what is in force before any settings have been read. */
const DEFAULT_SETTINGS = SettingsSchema({})

/**
 * Plain values out of the config `apply` received. On 0.1.7 each field is a
 * live reference read with `.get()`; a field that is missing or unreadable
 * keeps its default, so a partial or foreign config can never leave a hole.
 * @param config - the second argument of `apply`, whatever the loader passed.
 */
function readConfig(config) {
  const out = { ...DEFAULT_SETTINGS }
  if (config === null || typeof config !== 'object') return out
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    const ref = config[key]
    const value = ref !== null && typeof ref === 'object' && typeof ref.get === 'function' ? ref.get() : ref
    if (value !== undefined) out[key] = value
  }
  return out
}

/**
 * `jevTurn` state. `tick` is the seq of the first `user/message` committed
 * after each `turn/start`; `armed` says a turn has started and its first
 * message is still to come. Zod, not schemastery — the projection seam
 * validates state and wire payloads with `ZodType`, while the settings seam
 * takes a schemastery schema. The two are not interchangeable.
 */
const TurnStateSchema = zod.object({
  armed: zod.boolean(),
  tick: zod.number(),
})

/** What the browser sees of `jevTurn`: only the tick. */
const TurnViewSchema = zod.number()

/**
 * One turn as the envelope describes it. `outcome` is the `turn/end` reason
 * kind (`completed`, `aborted`, `error`, `max-tokens`, `blocked`), or null
 * while the turn is still open. `openTodos` counts the items of the turn's
 * last `todo/write` that were not yet completed (pending or in progress).
 */
const TurnSummarySchema = zod.object({
  turn: zod.number(),
  userTexts: zod.array(zod.string()),
  assistantTail: zod.string(),
  steps: zod.number(),
  toolCalls: zod.number(),
  openTodos: zod.number(),
  effort: zod.string().nullable(),
  route: zod.string().nullable(),
  outcome: zod.string().nullable(),
})

/**
 * Host-only context state: the open turn plus the two before it, and a count
 * of manual model/effort picks so a decision can tell whether the selector
 * moved since the last one. Plain JSON, rebuilt from the log on demand.
 */
const ContextSchema = zod.object({
  current: TurnSummarySchema.nullable(),
  previous: TurnSummarySchema.nullable(),
  earlier: TurnSummarySchema.nullable(),
  selections: zod.number(),
})

const name = 'jev-effort-selector'
const inject = ['sessionProjections']

/**
 * Derive a ladder from the levels one model advertises: weakest, a middle
 * rung, and a deep one.
 *
 * Both upper rungs prefer a named level and fall back to a position, so the
 * result stays predictable across providers: `medium` for the middle, `high`
 * for the top. The top deliberately is NOT the strongest level advertised —
 * a route that offers `max` or `xhigh` would otherwise spend it on every
 * message Jev finds complex. Those remain available through `levels`.
 * @param ids - effort ids in the adapter's preferred order.
 * @returns two or three ids, weakest first.
 */
function deriveLadder(ids) {
  if (ids.length <= 2) return ids.slice()
  const low = ids[0]
  let high = ids.includes('high') ? 'high' : ids[ids.length - 1]
  if (high === low) high = ids[ids.length - 1]
  let mid = ids.includes('medium') ? 'medium' : ids[Math.floor(ids.length / 2)]
  if (mid === low || mid === high) {
    // Fall back to the midpoint, then to any rung that is not already taken,
    // so the ladder never carries a duplicate.
    mid = ids[Math.floor(ids.length / 2)]
    if (mid === low || mid === high) mid = ids.find((id) => id !== low && id !== high) ?? mid
  }
  // Restore the advertised order. `high` prefers a named rung over a position,
  // so the rung picked for the middle can sit *after* it in the adapter's list
  // (`['low','high','max']` yields low/max/high). Criteria are assigned by
  // index, so an unsorted ladder would describe the stronger rung as the
  // lighter option and invert every decision it produces.
  return [low, mid, high].sort((a, b) => ids.indexOf(a) - ids.indexOf(b))
}

/**
 * Rank one effort id so a weaker/stronger comparison works for ids the
 * RANK table does not know.
 * @param ladder - the ladder in force for this call.
 * @param id - the effort id to rank.
 */
function rankOf(ladder, id) {
  const inLadder = ladder.indexOf(id)
  if (inLadder !== -1) return inLadder
  const known = RANK.indexOf(id)
  return known === -1 ? 0 : known
}

/**
 * Read the exact text of one user message, ignoring non-text blocks.
 * @param message - the UserMessage entering the step.
 */
function messageText(message) {
  const content = message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  let text = ''
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') text += block.text
  }
  return text
}

/** Last `n` characters of `text`, marked when something was cut. */
function tail(text, n) {
  return text.length <= n ? text : `…${text.slice(text.length - n)}`
}

/** First `n` characters of `text`, marked when something was cut. */
function head(text, n) {
  return text.length <= n ? text : `${text.slice(0, n)}…`
}

/**
 * An empty summary for turn `turn`. `effort` and `route` are inherited from
 * the turn before: the harness appends `request/header` only when the config
 * CHANGES, so a turn with no header event ran at the previous header's
 * values, and those are what "effort used" must report.
 *
 * `openTodos` is NOT inherited: the harness clears the todo list at every
 * `turn/start`, so a turn that writes none has none.
 * @param turn - turn number.
 * @param inherit - the turn this one follows, or null.
 */
function freshTurn(turn, inherit = null) {
  return {
    turn, userTexts: [], assistantTail: '', steps: 0, toolCalls: 0, openTodos: 0,
    effort: inherit?.effort ?? null, route: inherit?.route ?? null, outcome: null,
  }
}

/** Initial context state: nothing seen yet. */
function initContext() {
  return { current: null, previous: null, earlier: null, selections: 0 }
}

/**
 * Fold one session event into the context state. Turn boundaries come from
 * `turn/start`: everything until the next one belongs to that turn. Only
 * messages the person typed (`source.kind === 'user'`) count as user text;
 * plugin-injected reminders share the event type but are not what Jev should
 * read as "the user said".
 *
 * Returns the same reference for events that change nothing, so downstream
 * change detection stays cheap.
 * @param state - previous context state.
 * @param event - one committed session event.
 * @returns the next state.
 */
function foldContext(state, event) {
  const data = event.data
  switch (event.type) {
    case 'turn/start': {
      const turn = typeof data?.turn === 'number' ? data.turn : (state.current?.turn ?? 0) + 1
      return { ...state, current: freshTurn(turn, state.current), previous: state.current, earlier: state.previous }
    }
    case 'turn/end': {
      if (state.current === null) return state
      const kind = data?.reason?.kind
      return { ...state, current: { ...state.current, outcome: typeof kind === 'string' ? kind : 'unknown' } }
    }
    case 'user/message': {
      if (data?.source?.kind !== 'user') return state
      const text = messageText(data).trim()
      if (text === '') return state
      const current = state.current ?? freshTurn(0)
      const userTexts = [...current.userTexts, head(text, USER_TEXT_CHARS)].slice(-USER_TEXTS_PER_TURN)
      return { ...state, current: { ...current, userTexts } }
    }
    case 'assistant/message': {
      if (state.current === null) return state
      const text = messageText(data?.message).trim()
      if (text === '') return state
      return { ...state, current: { ...state.current, assistantTail: tail(text, ASSISTANT_TAIL_CHARS) } }
    }
    case 'step/start': {
      if (state.current === null) return state
      return { ...state, current: { ...state.current, steps: state.current.steps + 1 } }
    }
    case 'tool/call': {
      if (state.current === null) return state
      return { ...state, current: { ...state.current, toolCalls: state.current.toolCalls + 1 } }
    }
    case 'todo/write': {
      // Each write replaces the whole list, so the last one of the turn is
      // what the turn left behind. Read it here, not from the harness's own
      // `todos` projection: that one is reset by the NEXT turn's `turn/start`,
      // which is committed before `agent/request` runs — at decision time it
      // is always empty.
      if (state.current === null) return state
      const todos = Array.isArray(data?.todos) ? data.todos : []
      const openTodos = todos.filter((item) => item && item.status !== 'completed').length
      if (openTodos === state.current.openTodos) return state
      return { ...state, current: { ...state.current, openTodos } }
    }
    case 'request/header': {
      if (state.current === null) return state
      const config = data?.header?.config
      const effort = typeof config?.reasoningEffort === 'string' ? config.reasoningEffort : null
      const route = typeof config?.provider === 'string' && typeof config?.model === 'string' ? `${config.provider}/${config.model}` : null
      if (effort === state.current.effort && route === state.current.route) return state
      return { ...state, current: { ...state.current, effort, route } }
    }
    case 'model/selection':
      return { ...state, selections: state.selections + 1 }
    default:
      return state
  }
}

/**
 * The context block Jev reads before the current message.
 *
 * It describes the previous turn in facts Jev can weigh — what was asked,
 * how the assistant left off, how much work happened, whether it finished —
 * rather than in instructions. A first turn has no previous turn and gets
 * only the topic.
 * @param previous - the previous turn, or null.
 * @param earlier - the turn before that, or null.
 * @param title - the session title, or undefined.
 * @returns the system-role text.
 */
function contextBlock(previous, earlier, title) {
  const lines = ['Context: an ongoing conversation with an AI coding assistant.']
  if (title) lines.push(`Session topic: ${title}`)
  if (previous !== null) {
    lines.push('Previous turn:')
    if (previous.effort) lines.push(`- reasoning effort used: ${previous.effort}`)
    const said = previous.userTexts
    if (said.length > 0) lines.push(`- user said: ${JSON.stringify(said[said.length - 1])}`)
    const before = said.length > 1 ? said[said.length - 2] : earlier?.userTexts[earlier.userTexts.length - 1]
    if (before) lines.push(`- earlier the user said: ${JSON.stringify(before)}`)
    if (previous.assistantTail) lines.push(`- assistant ended with: ${JSON.stringify(previous.assistantTail)}`)
    lines.push(`- activity: ${previous.steps} steps, ${previous.toolCalls} tool calls`)
    lines.push(`- previous turn outcome: ${previous.outcome !== null && COMPLETED_KINDS.has(previous.outcome) ? 'completed' : 'not completed'}`)
    lines.push(`- unfinished todos: ${previous.openTodos}`)
  }
  return lines.join('\n')
}

/** askJev outcomes that are not a decision. Frozen so callers can compare by identity. */
const TIMED_OUT = Object.freeze({ failure: 'timeout' })
const FAILED = Object.freeze({ failure: 'failed' })
const CANCELLED = Object.freeze({ failure: 'cancelled' })

/**
 * Ask Jev two things in one call: which rung of `ladder` the current message
 * deserves, and whether the message continues the previous task.
 *
 * The second question is what separates "what time is it" from "go on":
 * both are short, but only one inherits the depth of the work in flight.
 * Jev answers it with high confidence even when the effort itself is a
 * coin toss, so the decision policy leans on it.
 * @param config - resolved plugin settings.
 * @param key - the bearer token.
 * @param state - the Jev `state` payload: a string or a chat-shaped array.
 * @param ladder - candidate effort ids, weakest first.
 * @param askRelation - whether a previous turn exists to relate to.
 * @param signal - the step's abort signal.
 * @returns the decision `{choice, confidence, relation}`, or a failure
 *   `{failure: 'timeout' | 'failed' | 'cancelled'}`.
 */
async function askJev(config, key, state, ladder, askRelation, signal) {
  // Callers clamp the ladder into the table's range; a length the table cannot
  // describe honestly keeps the caller's effort rather than inventing criteria.
  const descriptions = CRITERIA[ladder.length]
  if (descriptions === undefined) return FAILED
  const criteria = {}
  ladder.forEach((id, i) => {
    criteria[id] = descriptions[i]
  })

  const questions = {
    reasoning_effort: {
      type: 'choice',
      instructions: 'How much reasoning depth does answering the CURRENT user message require? Weigh the context: a short reply that continues work already in flight needs the depth of that work; an unrelated simple question does not.',
      criteria,
    },
  }
  if (askRelation) {
    questions.relation = {
      type: 'choice',
      instructions: 'How does the CURRENT user message relate to the previous turn?',
      criteria: {
        continues: 'continues, follows up on, confirms, or asks about the previous task — including "go on", "ok", "done?", or a one-word answer to a question the assistant asked',
        new: 'an unrelated new request or a standalone question',
      },
    }
  }

  const controller = new AbortController()
  const abort = () => controller.abort()
  signal?.addEventListener('abort', abort, { once: true })
  // Two things can abort the fetch: our own timer, or the turn itself being
  // cancelled. Only the first is a Jev timeout worth showing on the chip; a
  // cancelled turn never happened, so it records nothing.
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; abort() }, config.timeoutMs)

  try {
    const response = await fetch(config.apiUrl.trim(), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: config.model, state, questions }),
      signal: controller.signal,
    })
    if (!response.ok) return FAILED

    const answers = (await response.json())?.answers
    const effort = answers?.reasoning_effort
    if (!effort || typeof effort.choice !== 'string') return FAILED

    let choice = effort.choice
    const confidence = typeof effort.confidence === 'number' ? effort.confidence : 0

    // Low confidence: prefer the stronger of the two most likely rungs —
    // over-thinking a simple message costs tokens, under-thinking a hard one
    // costs the answer.
    if (confidence < config.confidenceThreshold) {
      const ranked = Object.entries(effort.probabilities ?? {})
        .sort((a, b) => b[1] - a[1])
        .slice(0, 2)
        .map(([id]) => id)
      if (ranked.length === 2) {
        choice = rankOf(ladder, ranked[0]) >= rankOf(ladder, ranked[1]) ? ranked[0] : ranked[1]
      }
    }
    if (!ladder.includes(choice)) return FAILED

    // Relation: when unsure, err toward "continues" — the anchoring it can
    // trigger only ever keeps depth, never removes it.
    let relation = null
    const rel = answers?.relation
    if (rel && typeof rel.choice === 'string') {
      const relConfidence = typeof rel.confidence === 'number' ? rel.confidence : 0
      relation = relConfidence < config.confidenceThreshold ? 'continues' : rel.choice
    }

    return { choice, confidence, relation }
  } catch {
    // Abort, timeout, transport failure, malformed JSON: keep the caller's effort.
    if (signal?.aborted) return CANCELLED
    return timedOut ? TIMED_OUT : FAILED
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
  }
}

/**
 * Resolve the bearer token the way the stock providers do (see
 * `dsh-web-search-deepseek`): an explicit literal first, then the credential
 * reference through the optional `credentials` service, and finally the bare
 * process environment for a deployment that mounts no credential provider.
 *
 * The seam layers the launching environment over the harness-managed
 * `$DSH_HOME/.credentials.yaml` over the `.env` fallbacks, so a key exported
 * into the environment keeps working untouched while the settings page gains
 * a place to write one. Resolution is per call by contract — the seam forbids
 * caching a resolved value across operations, which is what lets a key edited
 * in the browser reach the very next turn without a restart.
 * @param ctx - host context.
 * @param settings - resolved plugin settings.
 * @returns the token, or an empty string when nothing supplies one.
 */
async function resolveKey(ctx, settings) {
  if (settings.apiKey) return settings.apiKey

  // The reference grammar is deliberately NOT restated here. `resolve` is a
  // pure lookup that answers `undefined` for a name it does not hold, so the
  // running harness stays the single authority on what a valid reference is
  // and this plugin cannot drift from it. Only emptiness is checked, which is
  // not a grammar question.
  const name = settings.apiKeyEnv
  if (typeof name !== 'string' || name === '') return ''

  const credentials = ctx.get('credentials')
  if (credentials === undefined) return process.env[name] ?? ''
  try {
    return (await credentials.resolve(name))?.value ?? ''
  } catch {
    return ''
  }
}

/**
 * Effort ids ordered strongest first, restricted to `ladder`. Used to decide
 * whether one rung is below another.
 * @param ladder - the ladder in force.
 * @param a - first id.
 * @param b - second id.
 * @returns negative when `a` is weaker than `b`.
 */
function compareEffort(ladder, a, b) {
  return rankOf(ladder, a) - rankOf(ladder, b)
}

/** Key the Remote and the decision cache both use for one session. */
function sessionKeyOf(agent) {
  return String(agent.session.id)
}

/**
 * Whether a session is a subagent's. Jev picks the depth for what the PERSON
 * sent; a subagent's task is written by the parent agent, which also chooses
 * (or inherits) the subagent's effort. Those sessions are left alone.
 *
 * The message cannot tell them apart: DSH hands a subagent its task as a
 * `user`-sourced message. The session header can — dsh-subagent stamps
 * `origin: 'subagent'`. `parentSession` alone is NOT the test: a
 * conversation the user forks from the UI carries it too, and that one is
 * the user's own.
 * @param session - the agent's session.
 */
function isSubagentSession(session) {
  try {
    return session?.header?.origin === 'subagent'
  } catch {
    return false
  }
}

/**
 * Register settings, both projections, the per-turn decision listener, and
 * the SRC-mode Remote the browser half calls.
 * @param ctx - host context.
 * @param config - on DSH ≥ 0.1.7 the live `Config` references; older DSH passes defaults only.
 */
function apply(ctx, config) {
  /** provider/model -> advertised effort ids, resolved once per route. */
  const ladders = new Map()

  /**
   * Process-local state, all keyed by session id and all deliberately NOT
   * persisted: a restart clears them, and the plugin falls back to the log
   * (context) and the global settings (switch).
   */
  /** sessionId -> { turn, effort }: the decision in force for the open turn. */
  const turnDecisions = new Map()
  /** sessionId -> latest decision record for the chip. */
  const decisions = new Map()
  /** sessionId -> per-session override of the global `enabled` switch. */
  const sessionOverrides = new Map()
  /** sessionId -> `selections` count seen at the last decision (manual-pick detection). */
  const seenSelections = new Map()
  /**
   * sessionId -> { turn, text }: the user text entering the open turn.
   *
   * This cannot come from the projection. `agent/request` runs BEFORE the
   * accepted user batch is committed to the log (see the waterfall's
   * contract in dsh-agent), so at decision time the fold has not seen the
   * message yet. `agent/pre-step` hands the batch over first; only the text
   * typed by the person is kept — plugin-injected reminders share the
   * message type but are not what Jev should read as "the user said".
   */
  const pendingText = new Map()

  /** The section from the older `settings` service; null on DSH ≥ 0.1.7. */
  let legacy = null

  ctx.inject(['settings'], (scope) => {
    const service = scope.settings
    if (typeof service.register === 'function') {
      // DSH ≤ 0.1.5: settings.yaml, through the registered namespace.
      const section = service.register(NS, SettingsSchema)
      legacy = section.get()
      scope.effect(() => section.watch((next) => { legacy = next }))
      scope.effect(() => () => { legacy = null })
    } else if (typeof service.configure === 'function') {
      // DSH ≥ 0.1.7: the browser half draws its own page, so ask the
      // settings service not to offer a generated one for this entry.
      scope.effect(() => service.configure({ auto: false }, ctx.fiber))
    }
  })

  /** The settings in force right now, from whichever generation this DSH is. */
  function currentSettings() {
    return legacy ?? readConfig(config)
  }

  /** Whether Jev may decide for this session right now. */
  function enabledFor(sessionKey) {
    if (!currentSettings().enabled) return false
    const override = sessionOverrides.get(sessionKey)
    return override === undefined ? true : override
  }

  // The chip's refresh trigger. It moves exactly once per turn, at the first
  // `user/message` after `turn/start`. That event is committed right AFTER
  // `agent/request` returns (dsh-agent-loop appends the accepted batch only
  // once the request is prepared), so by the time the browser sees the tick
  // move, this turn's decision is already in memory.
  //
  // `request/header` looked like the obvious trigger and was the old one, but
  // the harness appends it only when the config CHANGES. A turn that kept the
  // previous effort — exactly the "go on" after an interrupt — produced no
  // header, no refresh, and a chip still showing the turn before.
  //
  // Later messages in the same turn (runtime context, plugin notices, a
  // mid-turn steer) leave the tick alone, so the chip fetches once per turn.
  ctx.sessionProjections.register({
    key: TURN_KEY,
    stateVersion: 1,
    stateSchema: TurnStateSchema,
    init: () => ({ armed: false, tick: 0 }),
    apply(state, event) {
      if (event.type === 'turn/start') return state.armed ? state : { armed: true, tick: state.tick }
      if (event.type === 'user/message' && state.armed) return { armed: false, tick: event.seq }
      return state
    },
    wire: {
      viewSchema: TurnViewSchema,
      view: (state) => state.tick,
    },
  })

  // The envelope's memory. Host-only: no `wire`, so the message text it holds
  // never leaves the process. Rebuilt from the log, so a restart or a long
  // idle costs nothing — the previous turn is still there when the next
  // decision asks for it.
  //
  // stateVersion 2: each turn summary gained `openTodos`. Bumping the version
  // makes the harness drop version-1 cache entries and refold from the log.
  ctx.sessionProjections.register({
    key: CONTEXT_KEY,
    stateVersion: 2,
    stateSchema: ContextSchema,
    init: initContext,
    apply: foldContext,
  })

  // Capture the current turn's user text before `agent/request` needs it.
  // The batch is the step's accepted messages; the person's own text is the
  // last block-bearing message whose source is the user. An empty batch, or
  // one made only of plugin notices, leaves the previous capture alone.
  // Subagent sessions are skipped here and in `agent/request` alike.
  ctx.on('agent/pre-step', (payload, next) => {
    if (payload.step === 1 && !isSubagentSession(payload.agent.session)) {
      let text = ''
      for (const message of payload.messages) {
        if (message?.source?.kind !== 'user') continue
        const t = messageText(message).trim()
        if (t !== '') text = t
      }
      if (text !== '') pendingText.set(sessionKeyOf(payload.agent), { turn: payload.turn, text })
    }
    return next()
  })

  ctx.on('agent/request', async (payload, next) => {
    const config = await next()
    // A subagent runs at the effort its parent chose or passed down; Jev is
    // not asked, nothing is recorded, and the per-session switch of the
    // parent conversation therefore never has to reach it.
    if (isSubagentSession(payload.agent.session)) return config
    const sessionKey = sessionKeyOf(payload.agent)

    // A turn Jev could not decide still gets a record, so the chip says so
    // instead of repeating the last success as if Jev had chosen again. The
    // effort is the one actually going out — the session's current effort,
    // passed through untouched. Caching it for the turn also stops a retry of
    // this step from waiting on Jev a second time.
    const fail = (reason) => {
      turnDecisions.set(sessionKey, { turn: payload.turn, effort: null })
      decisions.set(sessionKey, {
        effort: typeof config.reasoningEffort === 'string' ? config.reasoningEffort : null,
        confidence: null, reason, relation: null,
        model: String(config.model ?? ''), at: Date.now(),
      })
      return config
    }

    // One decision per turn. Every later request of the turn reuses it, so
    // the whole turn goes out at the same depth — steps 2+, and also a RETRY
    // of step 1: the loop re-runs this waterfall for each attempt of a step,
    // and asking Jev again would cost another call and could hand the same
    // step a different effort the chip never hears about (the retry appends
    // no new user/message, so the refresh trigger does not move).
    const held = turnDecisions.get(sessionKey)
    if (held !== undefined && held.turn === payload.turn) {
      return held.effort !== null ? { ...config, reasoningEffort: held.effort } : config
    }
    if (payload.step !== 1) return config
    turnDecisions.delete(sessionKey)

    if (!enabledFor(sessionKey)) return config
    // One read for the whole decision, so a save landing mid-call cannot
    // hand it half old and half new values.
    const settings = currentSettings()

    const session = payload.agent.session
    let context
    try {
      context = ctx.sessionProjections.stateOf(session, CONTEXT_KEY)
    } catch {
      context = undefined
    }
    if (context === undefined) return config

    // Manual pick: the selector changed since the last decision (each change
    // logs a `model/selection` the fold counts). The harness has already
    // folded the pick into `config`, so passing it through honors it. A
    // fresh process has no baseline and simply lets Jev decide.
    const seen = seenSelections.get(sessionKey)
    seenSelections.set(sessionKey, context.selections)
    const previous = context.previous
    const route = `${config.provider}/${config.model}`
    // A model switch is not a manual effort pick: Jev decides for the new
    // route, and the fold's route comparison keeps the two apart.
    const routeUnchanged = previous !== null && previous.route === route
    if (seen !== undefined && context.selections > seen && routeUnchanged) {
      const manual = typeof config.reasoningEffort === 'string' ? config.reasoningEffort : null
      turnDecisions.set(sessionKey, { turn: payload.turn, effort: manual })
      decisions.set(sessionKey, {
        effort: manual, confidence: null, reason: 'manual', relation: null,
        model: String(config.model ?? ''), at: Date.now(),
      })
      return config
    }

    // The current message comes from `agent/pre-step`, not the fold: the log
    // does not hold it yet at this point (see `pendingText`).
    const pending = pendingText.get(sessionKey)
    const currentText = pending !== undefined && pending.turn === payload.turn ? pending.text : ''
    if (currentText === '') return config

    // No endpoint configured: same treatment as a missing key — pass the
    // effort through, and let the chip say why instead of failing a fetch.
    if (typeof settings.apiUrl !== 'string' || settings.apiUrl.trim() === '') return fail('no-url')

    const key = await resolveKey(ctx, settings)
    if (!key) return fail('no-key')

    // What the route advertises is resolved first in every case: it is both
    // the fallback ladder and the guard for a configured one.
    let advertised = ladders.get(route)
    if (advertised === undefined) {
      const llm = ctx.get('llm')
      if (llm === undefined) return config
      try {
        const info = await llm.resolveModelInfo(config.provider, config.model, payload.signal)
        advertised = (info?.reasoning?.efforts ?? []).map((effort) => String(effort.id))
      } catch {
        // A route the adapter cannot describe right now. Leave the cache
        // empty so a later turn retries instead of writing this route off.
        return config
      }
      // Only a usable answer is worth caching; an empty one would otherwise
      // pin the route to "no ladder" for the life of the process.
      if (advertised.length >= 2) ladders.set(route, advertised)
    }
    if (advertised.length < 2) return config

    // A configured ladder is filtered against the advertised ids rather than
    // trusted. dsh-llm rejects an unsupported effort before provider I/O, so
    // one typo in `levels` would fail every first step instead of being
    // ignored — the opposite of this plugin's non-blocking contract.
    const configured = settings.levels?.[route]
    let ladder
    if (Array.isArray(configured)) {
      const usable = [...new Set(configured)].filter((id) => advertised.includes(id))
      ladder = usable.length >= 2 ? usable : deriveLadder(advertised)
    } else {
      ladder = deriveLadder(advertised)
    }
    ladder = clampLadder(ladder)

    // The envelope: the previous turn as facts, then the current message.
    let state = currentText
    if (settings.useContext) {
      let title
      const titles = ctx.get('sessionTitle')
      if (titles !== undefined) {
        try {
          title = titles.get(payload.agent.session)?.title
        } catch {
          // Title is advisory; its absence never blocks a decision.
        }
      }
      state = [
        { role: 'system', content: contextBlock(previous, context.earlier, title) },
        { role: 'user', content: currentText },
      ]
    }

    const decision = await askJev(settings, key, state, ladder, previous !== null, payload.signal)
    if (decision === CANCELLED) return config
    if (decision === TIMED_OUT) return fail('timeout')
    if (decision === FAILED) return fail('failed')

    // The one hard rule. Work still in flight, and a message that continues
    // it, keeps at least the depth that work already had. Everything else —
    // new topics, follow-ups after finished work, any upgrade — is Jev's call.
    let effort = decision.choice
    let reason = 'jev'
    const inFlight = previous !== null
      && (previous.outcome === null || !COMPLETED_KINDS.has(previous.outcome) || previous.openTodos > 0)
    if (decision.relation === 'continues' && inFlight && previous.effort !== null && ladder.includes(previous.effort)) {
      if (compareEffort(ladder, effort, previous.effort) < 0) {
        effort = previous.effort
        reason = 'anchored'
      }
    }

    turnDecisions.set(sessionKey, { turn: payload.turn, effort })
    decisions.set(sessionKey, {
      effort, confidence: decision.confidence, reason, relation: decision.relation,
      model: String(config.model ?? ''), at: Date.now(),
    })

    // The decision is deliberately NOT appended to the session log. The
    // persistence read path refuses to reconstruct a session containing an
    // event type outside the harness's own `KNOWN_SESSION_EVENT_TYPES` unless
    // the envelope carries `ignorable: true` — and `Session.append()` offers
    // no way to set that marker. The effort this returns is recorded anyway:
    // the loop appends its own `request/header` event carrying the config.
    return { ...config, reasoningEffort: effort }
  })

  // The browser half's door. Hand-written services have no generated typert
  // manifest; the gateway's SRC fallback discovers them from two markers —
  // the binding below and the method descriptor on the prototype — and reads
  // parameters by name. Types are therefore checked here, by hand.
  class JevRemote {
    /**
     * The latest decision and the effective switch for one session.
     * @param sessionId - session key.
     */
    getSessionState(sessionId) {
      const keyOf = String(sessionId ?? '')
      const decision = decisions.get(keyOf) ?? null
      const override = sessionOverrides.get(keyOf)
      return {
        globalEnabled: currentSettings().enabled === true,
        sessionEnabled: override === undefined ? null : override,
        enabled: enabledFor(keyOf),
        decision,
      }
    }

    /**
     * Set or clear this session's override of the global switch.
     * @param sessionId - session key.
     * @param enabled - true/false to override, null to fall back to global.
     */
    setSessionEnabled(sessionId, enabled) {
      const keyOf = String(sessionId ?? '')
      if (keyOf === '') throw new Error('sessionId is required')
      if (enabled === null || enabled === undefined) sessionOverrides.delete(keyOf)
      else if (typeof enabled === 'boolean') sessionOverrides.set(keyOf, enabled)
      else throw new Error('enabled must be a boolean or null')
      return this.getSessionState(keyOf)
    }

    /**
     * Every model that advertises at least two reasoning levels, grouped by
     * provider, with the ladder "auto" would use for it.
     *
     * The settings card needs both the levels a model offers and what the
     * plugin would pick on its own. Computing the auto ladder here keeps
     * `deriveLadder` / `clampLadder` the single source of truth: the card
     * shows exactly the rungs a decision would offer Jev. The advertised
     * levels come from `llm.resolveModelInfo`, the same call a decision uses,
     * so the two can never disagree about what a model supports.
     * @returns `{ groups: [{id, name, models: [{id, name, route, efforts: [{id, name}], auto}]}], failures: [{id, name, message}] }`.
     */
    async modelLadders() {
      const llm = ctx.get('llm')
      if (llm === undefined) return { groups: [], failures: [] }
      const groups = []
      const failures = []
      for (const provider of llm.listProviders()) {
        try {
          const models = []
          for (const model of await llm.listModels(provider.id)) {
            const info = await llm.resolveModelInfo(provider.id, model.id)
            const efforts = (info?.reasoning?.efforts ?? []).map((e) => ({ id: String(e.id), name: String(e.name ?? e.id) }))
            if (efforts.length < 2) continue
            models.push({
              id: String(model.id),
              name: String(model.name ?? model.id),
              route: `${provider.id}/${model.id}`,
              efforts,
              auto: clampLadder(deriveLadder(efforts.map((e) => e.id))),
            })
          }
          if (models.length > 0) groups.push({ id: String(provider.id), name: String(provider.name ?? provider.id), models })
        } catch (error) {
          failures.push({ id: String(provider.id), name: String(provider.name ?? provider.id), message: String(error && error.message ? error.message : error) })
        }
      }
      return { groups, failures }
    }
  }
  Object.defineProperty(JevRemote.prototype, '@deepseek-ai/dsh-typert-protocol/remote-methods', {
    value: Object.freeze({
      version: 1,
      methods: [
        Object.freeze({ method: 'getSessionState', invocation: Object.freeze({ kind: 'direct' }) }),
        Object.freeze({ method: 'setSessionEnabled', invocation: Object.freeze({ kind: 'direct' }) }),
        Object.freeze({ method: 'modelLadders', invocation: Object.freeze({ kind: 'direct' }) }),
      ],
    }),
    enumerable: false,
    configurable: true,
    writable: false,
  })
  const remote = new JevRemote()
  remote.typertRemote = Object.freeze({ service: remote, serviceKey: REMOTE_NS, namespace: REMOTE_NS })
  ctx.provide(REMOTE_NS, remote)

  ctx.on('agent/disposed', (payload) => {
    const sessionKey = sessionKeyOf(payload.agent)
    turnDecisions.delete(sessionKey)
    pendingText.delete(sessionKey)
  })
}

export { name, inject, apply, Config }
