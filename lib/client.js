/**
 * dsh-plugin-jev-effort-selector — browser half (hand-written lazy-CJS plugin bundle).
 *
 * Renders one chip in the composer's right-hand control row, beside the model
 * selector: Jev's latest decision for this session — the effort, how sure it
 * was, and why — plus a per-session switch behind a click.
 *
 * The decision lives in the host's memory (it is deliberately not persisted:
 * a restart clears it, and the chip stays empty until the next decision). The
 * chip fetches it over the gateway's raw RPC carrier from the host half's
 * SRC-mode Remote, and re-fetches whenever the `jevTurn` projection moves —
 * once per turn, right after that turn's decision is made. No polling, and
 * the chip never shows another session's value because everything is keyed
 * by `sessionId`.
 *
 * Visibility: hidden while the global switch is off; "Jev 关" while
 * this session alone is off (so it can be switched back on), and likewise
 * when Jev did not decide this turn (timeout, failed call, no key, no
 * address — the tooltip names which); hidden until the first decision; the
 * decision otherwise.
 *
 * It also registers the plugin's settings form. Where that form lives depends
 * on the DSH version, and one build serves both:
 *
 * - up to 0.1.5 the settings transport is the `settingsScope` service and the
 *   form is a collapsible card on Settings → Plugins (`settings.plugin.item`);
 * - from 0.1.7 the transport is the `configForms` service and the form is this
 *   bundle's page in the Plugins manager (`plugins.bundle.config`).
 *
 * Neither service is in the top-level `inject` list — Cordis has no optional
 * dependency, so listing one would leave the plugin pending forever on the
 * version that lacks it. Each is instead awaited by its own `ctx.inject`
 * branch; the branch for the missing service simply never runs.
 */
window.__ModuleLoader__.load({
	id: "dsh-plugin-jev-effort-selector",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const React = require("react");

		/* The snapshot-store factory moved packages across DSH versions; try the
		   current home first and fall back so one plugin build serves both. */
		let runtime;
		try {
			runtime = require("@deepseek-ai/dsh-client-store");
		} catch {
			runtime = require("@deepseek-ai/dsh-client-runtime/client");
		}

		/* The stock cards draw their disclosure affordance with the shared 14px
		   chevron primitive; require it so this card cannot drift from the
		   official icon, and keep an identical inline SVG for any host that
		   does not expose the primitives module. */
		let primitives = null;
		try {
			primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		} catch {
			primitives = null;
		}
		const CHEVRON_PATH = "M11.8486 5.5L11.4238 5.92383L8.69727 8.65137C8.44157 8.90706 8.21562 9.13382 8.01172 9.29785C7.79912 9.46883 7.55595 9.61756 7.25 9.66602C7.08435 9.69222 6.91565 9.69222 6.75 9.66602C6.44405 9.61756 6.20088 9.46883 5.98828 9.29785C5.78438 9.13382 5.55843 8.90706 5.30273 8.65137L2.57617 5.92383L2.15137 5.5L3 4.65137L3.42383 5.07617L6.15137 7.80273C6.42595 8.07732 6.59876 8.24849 6.74023 8.3623C6.87291 8.46904 6.92272 8.47813 6.9375 8.48047C6.97895 8.48703 7.02105 8.48703 7.0625 8.48047C7.07728 8.47813 7.12709 8.46904 7.25977 8.3623C7.40124 8.24849 7.57405 8.07732 7.84863 7.80273L10.5762 5.07617L11 4.65137L11.8486 5.5Z";
		const ChevronDown = typeof primitives?.IconChevronDownOutline14 === "function"
			? primitives.IconChevronDownOutline14
			: () => React.createElement("svg", {
				width: 14,
				height: 14,
				viewBox: "0 0 14 14",
				fill: "none",
				xmlns: "http://www.w3.org/2000/svg",
			}, React.createElement("path", { d: CHEVRON_PATH, fill: "currentColor" }));

		/* The stock Pill: a button when given onClick, a static span otherwise;
		   `active` marks the selected one. The fallback copies its markup and
		   its rules verbatim. */
		const Pill = typeof primitives?.Pill === "function"
			? primitives.Pill
			: (props) => {
				const { active, className, children, onClick, ...rest } = props;
				const cls = "dshjev-pillBase" + (onClick ? " dshjev-pillInteractive" : "") + (active ? " dshjev-pillActive" : "") + (className ? " " + className : "");
				return onClick
					? React.createElement("button", { type: "button", className: cls, onClick, ...rest }, children)
					: React.createElement("span", { className: cls }, children);
			};

		/* The stock settings Switch (the one Settings → Models uses). The fallback
		   renders the same markup and takes the same rules as the primitive's own
		   stylesheet, so a host without the primitives module still gets an
		   identical control. */
		const Switch = typeof primitives?.Switch === "function"
			? primitives.Switch
			: (props) => React.createElement("button", {
				type: "button",
				role: "switch",
				"aria-checked": props.checked,
				"aria-label": props.label,
				title: props.title,
				disabled: props.disabled === true,
				className: "dshjev-switch",
				onClick: () => props.onChange(!props.checked),
			}, React.createElement("span", { className: "dshjev-switchThumb" }));

		/* The card's container states, copied from the stock plugin card so this
		   one darkens on open exactly like every other card in the tab. Inline
		   styles cannot express `:hover` or `:disabled`, so these few rules ride
		   a deduplicated <style> tag; everything else stays inline. */
		const CSS_TAG_ID = "dsh-plugin-jev-effort-selector/settings-card.css";
		const CSS = [
			".dshjev-card{border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);border-radius:16px;list-style:none;transition:border-color .16s,background .16s}",
			".dshjev-card:hover{border-color:var(--dsw-alias-label-dimmed)}",
			".dshjev-cardOpen{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}",
			".dshjev-btn:disabled{opacity:.4;cursor:default}",
			/* Fallback Pill: the primitive's own rules, verbatim. */
			".dshjev-pillBase{display:inline-flex;align-items:center;gap:4px;height:24px;padding:0 8px;border:none;border-radius:12px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2)}",
			".dshjev-pillInteractive{cursor:pointer}",
			".dshjev-pillInteractive:hover{background:var(--dsw-alias-interactive-bg-hover)}",
			".dshjev-pillActive{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-button-ghost-active-fill);box-shadow:inset 0 0 0 1px var(--dsw-alias-button-ghost-active-border)}",
			/* The open card is bg-layer-2, the same fill as an idle pill, so an
			   unselected rung would have no edge at all. A hairline gives it one;
			   the selected state's own ring still wins. */
			".dshjev-pill{font-family:inherit}",
			".dshjev-pill:not([class*=_active]):not(.dshjev-pillActive){box-shadow:inset 0 0 0 .5px var(--dsw-alias-border-l4)}",
			".dshjev-pill:disabled{opacity:.4;cursor:default}",
			".dshjev-levelsHead{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:0 0;border:0;padding:0;display:flex;align-items:center;gap:8px}",
			/* Fallback Switch: the primitive's own rules, verbatim. */
			".dshjev-switch{box-sizing:border-box;position:relative;flex:0 0 auto;width:36px;height:20px;padding:2px;border:0;border-radius:10px;background:var(--dsw-alias-border-l3);cursor:pointer}",
			".dshjev-switch[aria-checked=true]{background:var(--dsw-alias-brand-primary)}",
			".dshjev-switch:disabled{cursor:default;opacity:.5}",
			".dshjev-switch:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}",
			".dshjev-switchThumb{display:block;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-label-primary-foreground);transition:transform .12s ease}",
			".dshjev-switch[aria-checked=true] .dshjev-switchThumb{transform:translate(16px)}",
			/* The chip sits beside the stock model selector and must read as the
			   same control. These rules copy that trigger's own (the
			   `_trigger` / `_triggerLabel` / `_triggerEffort` classes of
			   dsh-client-ui-model-selection) verbatim: box, type metrics, the
			   secondary colour of the model id, the caption colour of the effort,
			   the hover fill and the focus ring. Keep them in step with it. */
			".dshjev-chipRoot{min-width:0;position:relative}",
			".dshjev-chip{min-width:0;height:28px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;border-radius:24px;outline:none;align-items:center;gap:4px;padding:0 4px 0 8px;font-size:13px;font-weight:500;line-height:20px;white-space:nowrap;display:flex}",
			".dshjev-chip:hover{background:var(--dsw-alias-interactive-bg-hover)}",
			".dshjev-chip:focus-visible{box-shadow:0 0 0 2px var(--dsw-alias-border-l3)}",
			".dshjev-effort{color:var(--dsw-alias-label-caption)}",
			/* One deliberate departure from the stock trigger: the effort keeps a
			   colour per depth — caption grey for off/minimal/low, warn for medium,
			   error for anything above — so a deep turn is visible at a glance. */
			".dshjev-effortMedium{color:var(--dsw-alias-state-warn-primary)}",
			".dshjev-effortHigh{color:var(--dsw-alias-state-error-primary)}",
			/* No muted variant: in every state "Jev" wears the model id's colour
			   and the second word — an effort or 关 — the effort's. 关 is the
			   quiet caption grey like off/low; the word itself says Jev did not
			   decide, so nothing else needs dimming. */
		].join("");
		if (typeof document !== "undefined"
			&& document.querySelector("style[data-plugin-css=" + JSON.stringify(CSS_TAG_ID) + "]") === null) {
			const tag = document.createElement("style");
			tag.setAttribute("data-plugin-css", CSS_TAG_ID);
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}

		/**
		 * Required services: the UI slot registry, the credentials Remote
		 * namespace, and the connection. The credentials namespace is how the
		 * API key is written without ever being read back — `describe` reports
		 * only whether a reference is configured, from which source, and whether
		 * this client may write it; no method on it can return a secret.
		 *
		 * The settings transport is deliberately absent: it is `settingsScope`
		 * on older DSH and `configForms` on newer, and `apply` waits for
		 * whichever one exists (see the file header).
		 */
		const inject = ["slots", "remote", "remote.credentials", "connection"];

		/** Settings namespace served by the host half. */
		const NS = "jev-effort-selector";

		/** This package's name: the key of its page in the newer Plugins manager. */
		const PKG = "dsh-plugin-jev-effort-selector";

		/** One-line description, shared by the older card's header and the newer page's summary. */
		const DESCRIPTION = "由 Jev 判断每条消息该用多深的推理，自动切换当前模型的思考等级。";

		/** Projection key published by the host half; the chip's refetch trigger. */
		const TURN_KEY = "jevTurn";

		/** Wire namespace of the host half's SRC-mode Remote. */
		const REMOTE_NS = "jevEffortSelector";

		/** Human text for each decision reason the host records. */
		const REASONS = {
			jev: "由 Jev 判断",
			anchored: "延续未完成的任务，保持上一轮的等级",
			manual: "手动选择，Jev 本轮未参与",
			timeout: "Jev 未响应（超时），沿用当前等级",
			failed: "Jev 调用失败，沿用当前等级",
			"no-key": "未配置 Jev 密钥，沿用当前等级",
			"no-url": "未配置 Jev API 地址，沿用当前等级",
		};

		/**
		 * Reasons meaning Jev did NOT decide this turn. The chip reads "Jev 关"
		 * for these: the effort in force is not Jev's choice, and the model
		 * selector beside the chip already shows it.
		 */
		const NOT_DECIDED = ["timeout", "failed", "no-key", "no-url"];


		/**
		 * The settings card's scalar fields, in display order. `levels` is a map
		 * of arrays and gets its own section (LevelsSection) instead of a row.
		 *
		 * A number field's `min` / `max` and every field's `default` mirror the
		 * host schema (`settingsFields` in lib/index.js) — keep the two in step.
		 * The form checks ranges before Save because DSH 0.1.5 refuses an
		 * out-of-range write without telling the form: the box would silently
		 * snap back to the old value.
		 *
		 * `default` is what 恢复默认 shows in the box. The settings snapshot's
		 * `base` would carry it only if this plugin declared a composition
		 * layer, which it does not, so without this the box went blank.
		 *
		 * `required` fields refuse an empty box: clearing one used to save as
		 * "back to the default" silently, and a number box the browser cannot
		 * parse (say `1e`) reads as empty too. The way back to the default is
		 * the 恢复默认 link. `apiUrl` stays optional — empty means "never call
		 * Jev", which is its default.
		 */
		const FIELDS = [
			{ field: "enabled", kind: "boolean", default: true, label: "启用自动选择", hint: "关闭后保持你手动选择的推理等级。" },
			{ field: "apiUrl", kind: "text", default: "", label: "API 地址", hint: "Jev System One 接口的完整地址。未填写时不会调用 Jev。", placeholder: "输入 Jev System One 接口地址" },
			{ field: "model", kind: "text", default: "jev-latest", required: true, label: "Jev 模型", hint: "用于判断推理等级的模型路由。" },
			{ field: "confidenceThreshold", kind: "number", min: 0, max: 1, default: 0.6, required: true, label: "置信度阈值", hint: "低于该值时，在概率最高的两档中选更高的那个。" },
			{ field: "timeoutMs", kind: "number", min: 500, max: 30000, default: 5000, required: true, label: "超时时间（毫秒）", hint: "超时后跳过 Jev，沿用调用方已解析出的等级。" },
			{ field: "useContext", kind: "boolean", default: true, label: "发送上下文信封", hint: "附带上一轮的等级、用户消息、助手结尾、活动量与完成状态，让「继续」这类追问继承话题深度。" },
		];
		const SPEC = new Map(FIELDS.map((f) => [f.field, f]));

		/**
		 * Why a typed number cannot be saved, or "" when it can.
		 * @param spec - the field's entry in FIELDS (carries `min` / `max`).
		 * @param text - the trimmed, non-empty text in the box.
		 */
		function numberError(spec, text) {
			const n = Number(text);
			if (!Number.isFinite(n)) return "请输入数字。";
			if (n < spec.min || n > spec.max) return `请输入 ${spec.min} 到 ${spec.max} 之间的数字。`;
			return "";
		}

		/**
		 * The character set the stock Models page accepts for a key, reused
		 * verbatim so this card refuses exactly what that one refuses.
		 */
		const LEGAL_API_KEY = /^[\x21-\x7E]+$/;

		/**
		 * Reference the key is stored under. The settings schema still carries
		 * `apiKeyEnv` for anyone who wants a different name in settings.yaml, but
		 * the form does not show it: naming the slot is not a decision this card
		 * should ask a user to make.
		 */
		const DEFAULT_KEY_REF = "JEV_API_KEY";

		/* ── Styles ─────────────────────────────────────────────── */

		/** Effort ids that read as "barely thinking" and keep the caption grey. */
		const QUIET = ["off", "minimal", "low"];

		/** The colour class for one effort id: none for quiet, warn for medium, error above. */
		function effortClass(choice) {
			if (choice === "" || QUIET.indexOf(choice) !== -1) return "dshjev-effort";
			return choice === "medium" ? "dshjev-effort dshjev-effortMedium" : "dshjev-effort dshjev-effortHigh";
		}

		/** Title-case one effort id for display. */
		function label(choice) {
			return choice.charAt(0).toUpperCase() + choice.slice(1);
		}

		/**
		 * Whether the switch in Settings is on at this moment.
		 *
		 * A section that has not resolved yet reports no value; read that as
		 * off, so the chip cannot flash in before its own setting is known.
		 * @param scope - the bound settings scope for this namespace.
		 */
		function readEnabled(scope) {
			const value = scope.getSnapshot().value;
			return value !== undefined && value !== null && value.enabled === true;
		}

		/* The popover behind the chip: a small card in the stock card idiom. */
		const popoverStyle = {
			position: "absolute",
			right: 0,
			bottom: "calc(100% + 6px)",
			minWidth: "220px",
			padding: "10px 12px",
			borderRadius: "12px",
			border: ".5px solid var(--dsw-alias-border-l4)",
			background: "var(--dsw-alias-bg-layer-2)",
			boxShadow: "0 8px 24px rgba(0,0,0,.18)",
			zIndex: 20,
			fontSize: "12px",
			lineHeight: "18px",
			color: "var(--dsw-alias-label-secondary)",
			whiteSpace: "normal",
		};
		const popoverRowStyle = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px", color: "var(--dsw-alias-label-primary)", fontSize: "13px" };

		/**
		 * Call one method of the host half's Remote over the raw RPC carrier.
		 *
		 * `ctx.remote.<ns>` only mounts namespaces that ship a generated typert
		 * manifest; a hand-written Service reaches the browser through the same
		 * carrier one level down. The gateway answers with a result envelope, so
		 * the value is unwrapped here and a refusal becomes a thrown Error.
		 * @param connection - the client connection service.
		 * @param method - Remote method name.
		 * @param args - arguments by parameter name.
		 */
		async function callRemote(connection, method, args) {
			const result = await connection.rpc.call("/api", REMOTE_NS + "/" + method, { args });
			if (result && result.ok === true) return result.value;
			const message = result && result.error && result.error.message ? result.error.message : "remote call failed";
			throw new Error(message);
		}

		/**
		 * The composer chip: "Jev · High · 87%", with the per-session switch.
		 *
		 * Three hooks run unconditionally on every render — React fixes hook
		 * order, so no early return may sit above them.
		 * @param props - session-scoped standard props plus the injected hooks.
		 */
		function EffortChip(props) {
			const globalEnabled = props.useJevEnabled((on) => on);
			const trigger = props.useProjection(TURN_KEY);
			const [state, setState] = React.useState(null);
			const [open, setOpen] = React.useState(false);
			const [busy, setBusy] = React.useState(false);
			const sessionId = typeof props.sessionId === "string" ? props.sessionId : "";
			const connection = props.useJevConnection((c) => c);
			const triggerAt = typeof trigger === "number" ? trigger : 0;

			/* Fetch on mount, and again each time a request goes out. */
			React.useEffect(() => {
				if (!globalEnabled || sessionId === "" || connection === null) return undefined;
				let cancelled = false;
				callRemote(connection, "getSessionState", { sessionId })
					.then((value) => { if (!cancelled) setState(value); })
					.catch(() => { if (!cancelled) setState(null); });
				return () => { cancelled = true; };
			}, [globalEnabled, sessionId, connection, triggerAt]);

			/* Close the popover when the pointer lands anywhere else. */
			const rootRef = React.useRef(null);
			React.useEffect(() => {
				if (!open || typeof document === "undefined") return undefined;
				const onDown = (event) => {
					if (rootRef.current && !rootRef.current.contains(event.target)) setOpen(false);
				};
				document.addEventListener("mousedown", onDown, true);
				return () => document.removeEventListener("mousedown", onDown, true);
			}, [open]);

			if (!globalEnabled || state === null) return null;

			const sessionOn = state.enabled === true;
			const decision = state.decision;
			if (sessionOn && (decision === null || decision === undefined)) return null;

			const toggle = () => {
				if (busy || connection === null) return;
				setBusy(true);
				/* Off → on clears the override (falls back to global), on → off sets it. */
				const next = sessionOn ? false : null;
				callRemote(connection, "setSessionEnabled", { sessionId, enabled: next })
					.then((value) => setState(value))
					.catch(() => undefined)
					.then(() => setBusy(false));
			};

			let body;
			let title;
			if (!sessionOn) {
				title = "本会话已关闭 Jev 推理选择，点击可开启";
				body = [
					React.createElement("span", { key: "n" }, "Jev"),
					React.createElement("span", { key: "l", className: "dshjev-effort" }, "关"),
				];
			} else {
				const effort = typeof decision.effort === "string" ? decision.effort : "";
				const pct = typeof decision.confidence === "number" ? Math.round(decision.confidence * 100) + "%" : null;
				title = REASONS[decision.reason] || REASONS.jev;
				const undecided = NOT_DECIDED.indexOf(decision.reason) !== -1;
				/* Jev did not decide this turn: say so as "Jev 关", the same words
				   as the session switch. The effort in force already shows in the
				   model selector beside the chip; repeating it here read as if
				   Jev had picked it. The tooltip keeps the cause. */
				body = [
					React.createElement("span", { key: "n" }, "Jev"),
					React.createElement("span", { key: "l", className: undecided ? "dshjev-effort" : effortClass(effort) },
						undecided ? "关" : effort === "" ? "—" : label(effort)),
				];
				if (pct !== null && !undecided) body.push(React.createElement("span", { key: "c", className: "dshjev-effort" }, pct));
			}

			const reasonText = sessionOn && decision ? (REASONS[decision.reason] || REASONS.jev) : "";
			return React.createElement("div", { ref: rootRef, className: "dshjev-chipRoot" },
				React.createElement("button", {
					type: "button",
					className: "dshjev-chip",
					title,
					"aria-expanded": open,
					onClick: () => setOpen((v) => !v),
				}, ...body),
				open ? React.createElement("div", { style: popoverStyle, role: "dialog" },
					React.createElement("div", { style: popoverRowStyle },
						React.createElement("span", null, "本会话启用 Jev 推理选择"),
						React.createElement(Switch, {
							checked: sessionOn,
							label: "本会话启用 Jev 推理选择",
							disabled: busy,
							onChange: toggle,
						}),
					),
					React.createElement("div", { style: { marginTop: "6px" } },
						sessionOn
							? reasonText
							: "关闭后本会话沿用你手动选择的推理等级；重启服务后恢复为全局设置。"),
				) : null,
			);
		}

		/* ── Settings card ──────────────────────────────────────── */

		/**
		 * Turn a refused settings write into a thrown error. The newer transport
		 * resolves `false` when the Host refuses. The older one resolves
		 * `undefined` either way and rejects only when the transport itself
		 * fails, so a refusal there cannot be seen from here — which is why the
		 * form checks number ranges before Save (see FIELDS).
		 * @param result - what `set` / `unset` resolved to.
		 */
		function accepted(result) {
			if (result === false) throw new Error("settings write refused");
		}

		/**
		 * Staged editor over the namespace scope: edits accumulate here and only
		 * reach the Host when Save runs, so a half-typed endpoint never lands.
		 * `scope` is either transport — both expose the same snapshot shape and
		 * the same getSnapshot / subscribe / set / unset.
		 */
		class JevForm {
			constructor(scope, credentials, connection) {
				this.scope = scope;
				this.credentials = credentials;
				this.connection = connection;
				/** Models and their ladders, fetched from the host when the levels section first opens. */
				this.ladders = { status: "idle", groups: [], failures: [], error: "" };
				/** route -> string[] (a custom ladder) | null (back to auto). Committed by the card's Save. */
				this.levelEdits = new Map();
				/** field -> { kind: 'set', value } | { kind: 'clear' } | { kind: 'draft', text } */
				this.staged = new Map();
				this.saving = false;
				this.failed = false;
				/**
				 * The key lives outside the settings document entirely. `configured`
				 * is the whole fact this card keeps — the describe view carries no
				 * slot a secret could ride in, and this object never holds one, not
				 * even transiently after a successful write.
				 */
				this.secret = { ref: "", known: false, configured: false, draft: "",  error: "" };
				this.store = runtime.createSnapshotStore(this.projection());
			}

			/** Follow scope changes; the returned disposer belongs to an effect. */
			attach() {
				const dispose = this.scope.subscribe(() => { this.publish(); this.syncSecret() });
				this.syncSecret();
				return dispose;
			}

			/**
			 * The reference the Host will actually resolve: the saved value, never
			 * a half-typed draft, so the status line cannot describe a name that
			 * is not in force yet.
			 */
			savedRef() {
				const value = this.snapshot().value;
				const ref = value === undefined || value === null ? undefined : value.apiKeyEnv;
				return typeof ref === "string" && ref !== "" ? ref : DEFAULT_KEY_REF;
			}

			/** Re-describe when the reference in force changed under us. */
			syncSecret() {
				const ref = this.savedRef();
				if (ref === this.secret.ref) return;
				this.secret = { ...this.secret, ref, known: false, configured: false, error: "" };
				this.publish();
				void this.describeSecret(ref);
			}

			/**
			 * Read one reference's status. A reply for a superseded name is
			 * dropped, so a fast rename cannot leave the older answer on screen.
			 */
			async describeSecret(ref) {
				if (ref === "") return;
				let configured = false;
				let error = "";
				try {
					// Every remote method answers a result envelope and reports refusal
					// through `ok: false` instead of rejecting. Reading the payload off
					// the envelope directly yields undefined forever — the status then
					// never settles, which is exactly what a missing `.value` looked
					// like on screen.
					const response = await this.credentials.describe([ref]);
					if (response?.ok) configured = response.value?.[ref]?.configured === true;
					else error = response?.error?.message ?? "无法读取密钥状态。";
				} catch {
					error = "无法读取密钥状态。";
				}
				if (this.secret.ref !== ref) return;
				this.secret = { ...this.secret, known: true, configured, error };
				this.publish();
			}

			/**
			 * Commit a typed key as part of the card's single save.
			 *
			 * A blank draft writes nothing and keeps whatever is stored — the
			 * control starts blank on every load because the value can never be
			 * read back, so treating blank as "clear" would wipe the key of
			 * anyone who saved an unrelated field.
			 * @returns the failure message, or "" when nothing needed doing.
			 */
			async commitSecret() {
				const ref = this.secret.ref;
				const value = this.secret.draft.trim();
				if (value === "" || ref === "") return "";
				if (!LEGAL_API_KEY.test(value)) return "该 API 密钥格式错误，请检查。";
				try {
					// A refusal — most often a read-only layer shadowing the reference —
					// arrives as `ok: false` carrying the seam's own message, which is
					// what must be shown verbatim rather than a guess.
					const response = await this.credentials.set(ref, value);
					if (!response?.ok) return response?.error?.message ?? "保存失败，请重试。";
				} catch {
					return "保存失败，请重试。";
				}
				this.secret = { ...this.secret, draft: "" };
				await this.describeSecret(ref);
				return "";
			}

			/** Fetch every model's levels and auto ladder once; a failed fetch can be retried. */
			async loadLadders() {
				if (this.ladders.status === "loading" || this.ladders.status === "ready") return;
				if (this.connection === null || this.connection === undefined) {
					this.ladders = { status: "error", groups: [], failures: [], error: "无法连接到插件。" };
					this.publish();
					return;
				}
				this.ladders = { status: "loading", groups: [], failures: [], error: "" };
				this.publish();
				try {
					const value = await callRemote(this.connection, "modelLadders", {});
					this.ladders = { status: "ready", groups: value.groups ?? [], failures: value.failures ?? [], error: "" };
				} catch (error) {
					this.ladders = { status: "error", groups: [], failures: [], error: error && error.message ? error.message : "读取模型列表失败。" };
				}
				this.publish();
			}

			/** The saved `levels` map, as the host resolves it. */
			savedLevels() {
				const value = this.snapshot().value;
				const levels = value === undefined || value === null ? undefined : value.levels;
				return levels !== null && typeof levels === "object" ? levels : {};
			}

			/** The model entry for one route, or undefined before the list is in. */
			modelFor(route) {
				for (const group of this.ladders.groups) {
					for (const model of group.models) if (model.route === route) return model;
				}
				return undefined;
			}

			/**
			 * Display state for one model: which mode it is in, which rungs are
			 * selected, and whether that differs from what is saved. A saved ladder
			 * is shown filtered to what the model advertises — exactly what a
			 * decision would use.
			 */
			levelState(model) {
				const ids = model.efforts.map((e) => e.id);
				const order = (list) => ids.filter((id) => list.indexOf(id) !== -1);
				const stored = Array.isArray(this.savedLevels()[model.route]) ? this.savedLevels()[model.route] : undefined;
				const edit = this.levelEdits.get(model.route);
				let mode, selected, dirty;
				if (edit === undefined) {
					mode = stored === undefined ? "auto" : "custom";
					selected = stored === undefined ? model.auto : order(stored);
					dirty = false;
				} else if (edit === null) {
					mode = "auto"; selected = model.auto; dirty = stored !== undefined;
				} else {
					mode = "custom"; selected = order(edit);
					dirty = stored === undefined || selected.join(" ") !== order(stored).join(" ");
				}
				const tooFew = mode === "custom" && selected.length < 2;
				const tooMany = mode === "custom" && selected.length > 5;
				return { mode, selected, dirty, invalid: tooFew || tooMany, tooFew, tooMany };
			}

			publish() {
				this.store.set(this.projection());
			}

			snapshot() {
				return this.scope.getSnapshot();
			}

			/** Effective display state for one field: staged edit over resolved value. */
			fieldState(field) {
				const spec = SPEC.get(field);
				const snapshot = this.snapshot();
				const resolved = snapshot.value === undefined ? undefined : snapshot.value[field];
				const user = snapshot.user;
				const overridden = user !== undefined && user !== null && Object.hasOwn(user, field);
				const staged = this.staged.get(field);

				if (staged === undefined) {
					return { value: resolved, text: resolved === undefined ? "" : String(resolved), overridden, invalid: false, error: "", dirty: false };
				}
				if (staged.kind === "clear") {
					// A declared composition layer wins; otherwise the schema default
					// this form mirrors (see FIELDS) — never a blank box.
					const layer = snapshot.base === undefined || snapshot.base === null ? undefined : snapshot.base[field];
					const base = layer !== undefined ? layer : spec.default;
					return { value: base, text: base === undefined ? "" : String(base), overridden: false, invalid: false, error: "", dirty: true };
				}
				if (staged.kind === "set") {
					return { value: staged.value, text: String(staged.value), overridden: true, invalid: false, error: "", dirty: true };
				}
				// An emptied optional box (apiUrl) is valid and saves as "back to
				// the default"; an emptied required one blocks Save.
				const trimmed = staged.text.trim();
				const error = trimmed === ""
					? (spec.required ? "不能为空。" : "")
					: spec.kind === "number" ? numberError(spec, trimmed) : "";
				return { value: undefined, text: staged.text, overridden: true, invalid: error !== "", error, dirty: true };
			}

			projection() {
				const snapshot = this.snapshot();
				let dirty = false;
				let invalid = false;
				const fields = {};
				for (const spec of FIELDS) {
					const state = this.fieldState(spec.field);
					fields[spec.field] = state;
					dirty = dirty || state.dirty;
					invalid = invalid || state.invalid;
				}
				// A typed key makes the card dirty exactly like any other staged
				// edit, because one Save commits them together.
				if (this.secret.draft !== "") dirty = true;
				const groups = this.ladders.groups.map((group) => ({
					id: group.id,
					name: group.name,
					models: group.models.map((model) => {
						const st = this.levelState(model);
						dirty = dirty || st.dirty;
						invalid = invalid || st.invalid;
						return { ...model, ...st };
					}),
				}));
				return {
					available: snapshot.status === "ready",
					writable: snapshot.writable,
					saving: this.saving,
					failed: this.failed,
					dirty,
					invalid,
					fields,
					levels: { status: this.ladders.status, error: this.ladders.error, failures: this.ladders.failures, groups },
					secret: {
						/* `known` gates the status line so the row renders nothing at
						   all until the answer is in: a key is either configured or it
						   is not, and a transient "reading…" is noise either way. */
						known: this.secret.known,
						configured: this.secret.configured,
						draft: this.secret.draft,
						error: this.secret.error,
					},
				};
			}

			actions() {
				return {
					edit: (field, text) => { this.staged.set(field, { kind: "draft", text }); this.publish() },
					toggle: (field, value) => { this.staged.set(field, { kind: "set", value }); this.publish() },
					resetField: (field) => { this.staged.set(field, { kind: "clear" }); this.publish() },
					openLevels: () => { void this.loadLadders() },
					retryLevels: () => { this.ladders = { status: "idle", groups: [], failures: [], error: "" }; void this.loadLadders() },
					setLevelMode: (route, mode) => {
						const model = this.modelFor(route);
						if (model === undefined) return;
						const stored = this.savedLevels()[route];
						if (mode === "auto") {
							if (Array.isArray(stored)) this.levelEdits.set(route, null); else this.levelEdits.delete(route);
						} else {
							const current = this.levelState(model);
							if (current.mode !== "custom") this.levelEdits.set(route, model.auto.slice());
						}
						this.publish();
					},
					toggleLevel: (route, id) => {
						const model = this.modelFor(route);
						if (model === undefined) return;
						const current = this.levelState(model);
						if (current.mode !== "custom") return;
						const next = current.selected.indexOf(id) === -1
							? model.efforts.map((e) => e.id).filter((x) => x === id || current.selected.indexOf(x) !== -1)
							: current.selected.filter((x) => x !== id);
						this.levelEdits.set(route, next);
						this.publish();
					},
					discard: () => {
						this.staged.clear();
						this.levelEdits.clear();
						this.failed = false;
						this.secret = { ...this.secret, draft: "", error: "" };
						this.publish();
					},
					save: () => { void this.save() },
					editSecret: (text) => { this.secret = { ...this.secret, draft: text, error: "" }; this.publish() },
				};
			}

			async save() {
				if (this.saving) return;
				const view = this.projection();
				if (!view.dirty || view.invalid || !view.writable) return;
				this.saving = true;
				this.failed = false;
				this.publish();

				let landed = true;
				for (const [field, staged] of [...this.staged]) {
					try {
						const spec = SPEC.get(field);
						// An emptied optional box (only apiUrl — required ones never
						// get here, see fieldState) means "revert to the default",
						// not "store an empty string".
						const blank = staged.kind === "draft" && staged.text.trim() === "";
						if (staged.kind === "clear" || blank) {
							accepted(await this.scope.unset(field));
						} else {
							let value = staged.kind === "set" ? staged.value : staged.text;
							// Drafts are stored trimmed: a stray space in the model
							// route would reach Jev verbatim.
							if (staged.kind === "draft") value = spec.kind === "number" ? Number(value.trim()) : value.trim();
							accepted(await this.scope.set(field, value));
						}
						this.staged.delete(field);
					} catch {
						// Keep this edit staged so Save can be retried after the cause clears.
						landed = false;
					}
				}
				// Per-model ladders commit as one write of the whole `levels` map.
				// Routes the list does not know (a model since removed, a hand
				// edit) are carried over untouched; only edited routes change.
				if (this.levelEdits.size > 0) {
					try {
						const next = { ...this.savedLevels() };
						for (const [route, edit] of this.levelEdits) {
							const model = this.modelFor(route);
							if (edit === null) delete next[route];
							else next[route] = model === undefined ? edit : this.levelState(model).selected;
						}
						accepted(Object.keys(next).length === 0
							? await this.scope.unset("levels")
							: await this.scope.set("levels", next));
						this.levelEdits.clear();
					} catch {
						landed = false;
					}
				}
				// The key rides the same Save. It travels a different transport —
				// the credentials seam, never the settings document — but a user
				// pressing one button expects one commit.
				const secretError = await this.commitSecret();
				this.saving = false;
				this.failed = !landed;
				this.secret = { ...this.secret, error: secretError };
				this.publish();
			}
		}

		const cardCSS = {
			header: { appearance: "none", width: "100%", font: "inherit", color: "inherit", textAlign: "left", cursor: "pointer", background: "0 0", border: 0, borderRadius: "12px", alignItems: "center", gap: "12px", padding: "14px 16px", display: "flex" },
			headText: { flexDirection: "column", flex: 1, gap: "4px", minWidth: 0, display: "flex" },
			name: { color: "var(--dsw-alias-label-primary)", fontSize: "15px", fontWeight: 600, lineHeight: 1.4 },
			desc: { color: "var(--dsw-alias-label-tertiary)", fontSize: "13px", lineHeight: 1.5 },
			pending: { flex: "none", color: "var(--dsw-alias-label-tertiary)", fontSize: "12px" },
			chevron: { display: "inline-flex", flex: "none", color: "var(--dsw-alias-label-tertiary)", transition: "transform .16s" },
			chevronOpen: { transform: "rotate(180deg)" },
			body: { borderTop: ".5px solid var(--dsw-alias-border-l2)", margin: "0 16px", paddingBottom: "8px" },
			page: { paddingBottom: "4px" },
			field: { flexDirection: "column", gap: "6px", padding: "12px 0", display: "flex", borderTop: ".5px solid var(--dsw-alias-border-l2)" },
			fieldHead: { alignItems: "center", gap: "8px", display: "flex" },
			label: { minWidth: 0, color: "var(--dsw-alias-label-primary)", flex: 1, fontSize: "13px", fontWeight: 500, lineHeight: 1.5 },
			reset: { font: "inherit", color: "var(--dsw-alias-label-secondary)", cursor: "pointer", background: "0 0", border: "none", padding: 0, fontSize: "12px", lineHeight: 1.5 },
			input: { border: ".5px solid var(--dsw-alias-border-l4)", background: "var(--dsw-alias-bg-layer-3)", height: "34px", font: "inherit", color: "var(--dsw-alias-label-primary)", borderRadius: "8px", padding: "0 12px", fontSize: "13px", lineHeight: 1.5, boxSizing: "border-box" },
			hint: { color: "var(--dsw-alias-label-tertiary)", margin: 0, fontSize: "12px", lineHeight: 1.5 },
			invalid: { color: "var(--dsw-alias-state-error-primary)", margin: 0, fontSize: "12px", lineHeight: 1.5 },
			toggleRow: { color: "var(--dsw-alias-label-primary)", justifyContent: "space-between", alignItems: "flex-start", gap: "16px", fontSize: "13px", lineHeight: 1.5, display: "flex" },
			toggleLabel: { flex: 1, minWidth: 0 },
			footer: { borderTop: ".5px solid var(--dsw-alias-border-l2)", justifyContent: "flex-end", alignItems: "center", gap: "8px", padding: "12px 0 4px", display: "flex" },
			failed: { minWidth: 0, color: "var(--dsw-alias-state-error-primary)", flex: 1, margin: 0, fontSize: "12px", lineHeight: 1.5 },
			button: { appearance: "none", font: "inherit", cursor: "pointer", border: "1px solid transparent", borderRadius: "8px", padding: "5px 14px", fontSize: "13px", lineHeight: 1.5 },
			discard: { borderColor: "var(--dsw-alias-border-l2)", color: "var(--dsw-alias-label-secondary)", background: "0 0" },
			save: { background: "var(--dsw-alias-label-primary)", color: "var(--dsw-alias-bg-layer-3)" },
			readOnly: { color: "var(--dsw-alias-label-tertiary)", margin: "12px 0 0", fontSize: "12px", lineHeight: 1.5 },
			groupTitle: { color: "var(--dsw-alias-label-tertiary)", fontSize: "12px", fontWeight: 500, lineHeight: "18px", margin: "10px 0 2px" },
			modelRow: { flexDirection: "column", gap: "8px", padding: "10px 0", display: "flex", borderTop: ".5px solid var(--dsw-alias-border-l2)" },
			modelHead: { alignItems: "center", gap: "12px", display: "flex" },
			modelName: { minWidth: 0, flex: 1, color: "var(--dsw-alias-label-primary)", fontSize: "13px", fontWeight: 500, lineHeight: "20px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
			pills: { flexWrap: "wrap", alignItems: "center", gap: "6px", display: "flex" },
		};

		/** One field row: label, optional reset, control, hint. */
		function Field(props) {
			const { spec, state, actions, disabled } = props;
			const control = spec.kind === "boolean"
				? React.createElement("div", { style: cardCSS.toggleRow },
					React.createElement("div", { style: cardCSS.toggleLabel },
						React.createElement("div", { style: cardCSS.label }, spec.label),
						React.createElement("p", { style: cardCSS.hint }, spec.hint)),
					React.createElement("input", {
						type: "checkbox", checked: state.value === true, disabled,
						onChange: (e) => actions.toggle(spec.field, e.target.checked),
					}))
				: React.createElement(React.Fragment, null,
					React.createElement("div", { style: cardCSS.fieldHead },
						React.createElement("span", { style: cardCSS.label }, spec.label),
						state.overridden
							? React.createElement("button", { type: "button", style: cardCSS.reset, disabled, onClick: () => actions.resetField(spec.field) }, "恢复默认")
							: null),
					React.createElement("input", {
						type: spec.kind === "secret" ? "password" : spec.kind === "number" ? "number" : "text",
						value: state.text, disabled, style: cardCSS.input,
						placeholder: spec.placeholder,
						onChange: (e) => actions.edit(spec.field, e.target.value),
					}),
					state.invalid
						? React.createElement("p", { style: cardCSS.invalid }, state.error)
						: React.createElement("p", { style: cardCSS.hint }, spec.hint));

			return React.createElement("div", { style: cardCSS.field }, control);
		}

		/**
		 * The API key row, written through the credentials seam rather than into
		 * the settings document.
		 *
		 * The value is never read back — the describe view carries only whether a
		 * key is stored — so the row states that one fact and nothing more, in
		 * the stock Models page's own words. Until the answer is in it states
		 * nothing at all: a placeholder that narrates the read tells the user
		 * about this card's plumbing rather than about their key.
		 * @param props - the credential view plus the card's actions.
		 */
		function SecretField(props) {
			const { secret, actions, disabled } = props;

			return React.createElement("div", { style: cardCSS.field },
				React.createElement("div", { style: cardCSS.fieldHead },
					React.createElement("span", { style: cardCSS.label }, "API 密钥")),
				React.createElement("input", {
					type: "password",
					value: secret.draft,
					disabled,
					placeholder: "输入 API 密钥",
					style: cardCSS.input,
					onChange: (e) => actions.editSecret(e.target.value),
				}),
				secret.error !== ""
					? React.createElement("p", { style: cardCSS.invalid }, secret.error)
					: secret.known
						? React.createElement("p", { style: cardCSS.hint },
							secret.configured ? "API 密钥已配置" : "API 密钥缺失")
						: null);
		}

		/**
		 * Per-model ladders: every model that offers at least two levels, each in
		 * "auto" (the plugin's own pick, shown read-only) or "custom" (tick 2–5
		 * of the model's levels; Jev then chooses only among them). Edits stage
		 * like every other field and commit with the card's Save.
		 * @param props - the levels view, the card's actions, and whether controls are disabled.
		 */
		function LevelsSection(props) {
			const { levels, actions, disabled } = props;
			const [open, setOpen] = React.useState(false);
			const toggleOpen = () => {
				if (!open) actions.openLevels();
				setOpen(!open);
			};

			let body = null;
			if (open) {
				if (levels.status === "loading" || levels.status === "idle") {
					body = React.createElement("p", { style: cardCSS.hint }, "正在读取模型列表…");
				} else if (levels.status === "error") {
					body = React.createElement("div", { style: cardCSS.fieldHead },
						React.createElement("p", { style: { ...cardCSS.invalid, flex: 1 } }, levels.error),
						React.createElement("button", { type: "button", style: cardCSS.reset, onClick: actions.retryLevels }, "重试"));
				} else if (levels.groups.length === 0) {
					body = React.createElement("p", { style: cardCSS.hint }, "没有支持多档推理等级的模型。");
				} else {
					body = React.createElement(React.Fragment, null,
						levels.groups.map((group) => React.createElement(React.Fragment, { key: group.id },
							React.createElement("div", { style: cardCSS.groupTitle }, group.name),
							group.models.map((model) => {
								const custom = model.mode === "custom";
								const names = new Map(model.efforts.map((e) => [e.id, e.name]));
								return React.createElement("div", { key: model.route, style: cardCSS.modelRow, "data-route": model.route },
									React.createElement("div", { style: cardCSS.modelHead },
										React.createElement("span", { style: cardCSS.modelName, title: model.route }, model.name),
										React.createElement("div", { style: cardCSS.pills },
											React.createElement(Pill, { className: "dshjev-pill", active: !custom, disabled, onClick: () => actions.setLevelMode(model.route, "auto") }, "自动"),
											React.createElement(Pill, { className: "dshjev-pill", active: custom, disabled, onClick: () => actions.setLevelMode(model.route, "custom") }, "自定义"))),
									React.createElement("div", { style: cardCSS.pills },
										model.efforts.map((effort) => React.createElement(Pill, custom
											? { key: effort.id, className: "dshjev-pill", active: model.selected.indexOf(effort.id) !== -1, disabled, onClick: () => actions.toggleLevel(model.route, effort.id) }
											: { key: effort.id, className: "dshjev-pill", active: model.selected.indexOf(effort.id) !== -1 },
											names.get(effort.id) ?? effort.id))),
									model.tooFew
										? React.createElement("p", { style: cardCSS.invalid }, "至少选择 2 档。")
										: model.tooMany
											? React.createElement("p", { style: cardCSS.invalid }, "最多选择 5 档。")
											: null);
							}))),
						levels.failures.length > 0
							? React.createElement("p", { style: cardCSS.hint }, "以下提供方读取失败：" + levels.failures.map((f) => f.name).join("、"))
							: null);
				}
			}

			return React.createElement("div", { style: cardCSS.field },
				React.createElement("button", { type: "button", className: "dshjev-levelsHead", "aria-expanded": open, onClick: toggleOpen },
					React.createElement("span", { style: cardCSS.label }, "按模型设置档位"),
					React.createElement("span",
						{ style: open ? { ...cardCSS.chevron, ...cardCSS.chevronOpen } : cardCSS.chevron, "aria-hidden": true },
						React.createElement(ChevronDown, null))),
				/* One explanation for the whole list, shown open or closed, instead
				   of the same sentence under every model. Rows only speak up when
				   their selection is invalid. */
				React.createElement("p", { style: cardCSS.hint }, "为每个模型指定 Jev 可选的推理档位。自动：高亮的是插件推导出的档位；自定义：Jev 只会在你选中的档位里挑选。"),
				body);
		}

		/**
		 * The form itself — every field, the levels section, and the one Save —
		 * without any surrounding chrome. The older card wraps it in its own
		 * collapsible shell; the newer Plugins page draws title and icon itself
		 * and renders it bare.
		 * @param props - `state` (the form snapshot), `actions` (the form's actions), `style` for the outer box.
		 */
		function FormBody(props) {
			const { state, actions } = props;
			const disabled = !state.writable || state.saving;
			const blocked = !state.dirty || state.invalid || state.saving || !state.writable;
			return React.createElement("div", { style: props.style },
				state.writable ? null : React.createElement("p", { style: cardCSS.readOnly }, "当前设置文档为只读，无法保存修改。"),
				FIELDS.map((spec) => {
					const row = React.createElement(Field, {
						key: spec.field, spec, state: state.fields[spec.field], actions, disabled,
					});
					// The key follows the endpoint it authenticates, mirroring
					// the stock Models page's 地址-then-密钥 ordering.
					if (spec.field !== "apiUrl") return row;
					return React.createElement(React.Fragment, { key: spec.field },
						row,
						React.createElement(SecretField, { secret: state.secret, actions, disabled }));
				}),
				React.createElement(LevelsSection, { levels: state.levels, actions, disabled }),
				React.createElement("div", { style: cardCSS.footer },
					state.failed ? React.createElement("p", { style: cardCSS.failed }, "保存失败，请重试。") : null,
					React.createElement("button", {
						type: "button", className: "dshjev-btn",
						style: { ...cardCSS.button, ...cardCSS.discard },
						disabled: !state.dirty || state.saving, onClick: actions.discard,
					}, "放弃修改"),
					React.createElement("button", {
						type: "button", className: "dshjev-btn",
						style: { ...cardCSS.button, ...cardCSS.save },
						disabled: blocked, onClick: actions.save,
					}, state.saving ? "保存中…" : "保存")));
		}

		/**
		 * Older DSH (≤ 0.1.5): the collapsible card on Settings → Plugins.
		 * @param props - owner props carrying the card's hook and actions.
		 */
		function SettingsCard(props) {
			const state = props.useJevCard((snapshot) => snapshot);
			const [open, setOpen] = React.useState(false);
			if (!state.available) return null;

			// The open state darkens the card to bg-layer-2, exactly as the stock
			// plugin cards do, so an expanded section reads as one surface with
			// the rest of the tab instead of staying flat at bg-layer-3.
			return React.createElement("li", { className: open ? "dshjev-card dshjev-cardOpen" : "dshjev-card" },
				React.createElement("button", {
					type: "button", style: cardCSS.header, "aria-expanded": open,
					onClick: () => setOpen(!open),
				},
					React.createElement("span", { style: cardCSS.headText },
						React.createElement("span", { style: cardCSS.name }, "Jev 推理选择"),
						React.createElement("span", { style: cardCSS.desc }, DESCRIPTION)),
					state.dirty ? React.createElement("span", { style: cardCSS.pending }, "未保存") : null,
					React.createElement("span",
						{ style: open ? { ...cardCSS.chevron, ...cardCSS.chevronOpen } : cardCSS.chevron, "aria-hidden": true },
						React.createElement(ChevronDown, null))),
				open ? React.createElement(FormBody, { state, actions: props, style: cardCSS.body }) : null);
		}

		/**
		 * Newer DSH (≥ 0.1.7): this bundle's page in the Plugins manager. The page
		 * asks for `view: 'page'` (the form) or `view: 'summary'` (a one-liner).
		 * @param props - owner props: `view`, plus the card's hook and actions.
		 */
		function ConfigPage(props) {
			const state = props.useJevCard((snapshot) => snapshot);
			if (props.view === "summary") return DESCRIPTION;
			if (!state.available) return null;
			return React.createElement(FormBody, { state, actions: props, style: cardCSS.page });
		}

		/**
		 * Wire the chip and the settings form to one settings transport.
		 *
		 * Called once, by whichever branch of `apply` found its service; `ctx`
		 * is that branch's context, so everything registered here is disposed
		 * with it.
		 * @param ctx - the branch context (carries every service of `inject`).
		 * @param scope - the namespace's settings handle, from either transport.
		 * @param mountForm - registers the form in the right place for this DSH version.
		 */
		function mount(ctx, scope, mountForm) {
			/* The chip's visibility is settings state, not session state, so it
			   travels by its own snapshot store rather than the projection. One
			   handle serves both seats: the form writes the switch and the chip
			   reads it, so they cannot disagree while subscriptions converge. */
			const enabledStore = runtime.createSnapshotStore(readEnabled(scope));
			ctx.effect(
				() => scope.subscribe(() => enabledStore.set(readEnabled(scope))),
				"dsh-plugin-jev-effort-selector: chip visibility subscription",
			);

			/* The connection is a service, not React state; it rides a snapshot
			   store so the chip reads it through the same hooks face as the
			   switch, and never touches `ctx` from inside a render. */
			const connectionStore = runtime.createSnapshotStore(ctx.connection);

			ctx.slots.inject("conversation.input.right", () => ctx.slots.register(
				{
					name: "conversation.input.right",
					id: "jev-effort",
					order: 50,
					inject: () => ({ hooks: { jevEnabled: enabledStore, jevConnection: connectionStore } }),
				},
				EffortChip,
			));

			const form = new JevForm(scope, ctx.remote.credentials, ctx.connection);
			ctx.effect(() => form.attach(), "dsh-plugin-jev-effort-selector: settings scope subscription");
			mountForm(() => ({ hooks: { jevCard: form.store }, ...form.actions() }));
		}

		/**
		 * Register the composer chip and the settings form, on whichever
		 * settings transport this DSH provides.
		 * @param ctx - Client root context.
		 */
		function apply(ctx) {
			/* Newer DSH: the form is this bundle's page in the Plugins manager,
			   present exactly while the Host serves the namespace. */
			ctx.inject(["configForms"], (branch) => {
				mount(branch, branch.configForms.get(NS), (inject) => {
					branch.effect(() => branch.configForms.whileServed([NS], () => branch.slots.inject("plugins.bundle.config", () => branch.slots.register({
						name: "plugins.bundle.config",
						key: PKG,
						inject,
					}, ConfigPage))), "dsh-plugin-jev-effort-selector: plugin page");
				});
			});

			/* Older DSH: the collapsible card on Settings → Plugins. The tab shows
			   the intersection of namespaces the Host serves and cards registered
			   on `settings.plugin.item`, and lists cards by `priority` ascending
			   (ties keep registration order); every stock card sits at 0, so -1
			   pins this one to the top. */
			ctx.inject(["settingsScope"], (branch) => {
				mount(branch, branch.settingsScope.bind({ namespace: NS }), (inject) => {
					branch.slots.inject("settings.plugin.item", () => branch.slots.register({
						name: "settings.plugin.item",
						key: NS,
						priority: -1,
						inject,
					}, SettingsCard));
				});
			});
		}

		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	},
});
