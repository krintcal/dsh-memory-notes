window.__ModuleLoader__.load({
	id: "dsh-memory-notes",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		const h = react.createElement;

		/* ------------------------------ API client ------------------------------ */

		// 文档相对路径（无前导斜杠）：GUI 用 <base href="./">，根绝对路径会逃出
		// 子路径部署（/dsh/dsh/ 之类）。
		const API = {
			state: "api/dsh-memory-notes/state",
			write: "api/dsh-memory-notes/write",
			pending: "api/dsh-memory-notes/pending",
		};

		async function fetchJson(url, body) {
			const init =
				body === undefined
					? { headers: { accept: "application/json" } }
					: {
							method: "POST",
							headers: { "content-type": "application/json", accept: "application/json" },
							body: JSON.stringify(body),
						};
			const response = await fetch(url, init);
			let data = null;
			try {
				data = await response.json();
			} catch {
				data = null;
			}
			if (!response.ok) {
				throw new Error((data && data.error) || `HTTP ${response.status}`);
			}
			return data ?? {};
		}

		/* --------------------------------- styles ------------------------------- */

		const card = {
			border: "1px solid rgba(127,127,127,0.32)",
			borderRadius: "10px",
			padding: "14px 16px",
			marginBottom: "14px",
			background: "transparent",
		};
		const row = { display: "flex", alignItems: "center", gap: "10px" };
		const muted = { opacity: 0.66, fontSize: "12px" };
		const smallBtn = {
			font: "inherit",
			fontSize: "12px",
			padding: "4px 10px",
			borderRadius: "7px",
			border: "1px solid rgba(127,127,127,0.4)",
			background: "transparent",
			color: "inherit",
			cursor: "pointer",
		};
		const primaryBtn = {
			...smallBtn,
			border: "1px solid rgba(127,127,127,0.7)",
			background: "rgba(127,127,127,0.16)",
		};
		const textarea = {
			width: "100%",
			boxSizing: "border-box",
			minHeight: "52px",
			resize: "vertical",
			font: "inherit",
			fontSize: "13px",
			lineHeight: 1.45,
			color: "inherit",
			background: "transparent",
			border: "1px solid rgba(127,127,127,0.35)",
			borderRadius: "8px",
			padding: "8px 10px",
			outline: "none",
		};
		const barTrack = {
			height: "5px",
			borderRadius: "999px",
			background: "rgba(127,127,127,0.25)",
			overflow: "hidden",
			flex: "1 1 auto",
		};
		const barFill = (percent) => ({
			height: "100%",
			width: `${Math.max(0, Math.min(100, percent))}%`,
			borderRadius: "999px",
			background: percent >= 90 ? "#d9534f" : percent >= 75 ? "#d9a441" : "#4a9d6a",
			transition: "width 160ms ease",
		});

		/* ------------------------------- entry card ------------------------------ */

		function EntryCard({ target, entry, index, busy, onSave, onRemove }) {
			const [text, setText] = react.useState(entry);
			react.useEffect(() => setText(entry), [entry]);
			const dirty = text !== entry;
			return h(
				"div",
				{ style: { ...card, padding: "10px 12px", marginBottom: "10px" } },
				h(
					"div",
					{ style: { ...row, justifyContent: "space-between", marginBottom: "6px" } },
					h("span", { style: muted }, `${target} · #${index + 1} · ${entry.length} 字符`),
					h(
						"div",
						{ style: row },
						dirty
							? h(
									"button",
									{ style: primaryBtn, disabled: busy, onClick: () => onSave(entry, text) },
									"保存",
								)
							: null,
						h("button", { style: smallBtn, disabled: busy, onClick: () => onRemove(entry) }, "删除"),
					),
				),
				h("textarea", {
					style: textarea,
					value: text,
					disabled: busy,
					onChange: (event) => setText(event.target.value),
				}),
			);
		}

		function AddEntry({ target, busy, onAdd }) {
			const [text, setText] = react.useState("");
			const canAdd = text.trim().length > 0 && !busy;
			return h(
				"div",
				{ style: { ...row, alignItems: "flex-end", gap: "8px" } },
				h("textarea", {
					style: { ...textarea, flex: "1 1 auto", minHeight: "44px" },
					placeholder: `给 ${target} 添加一条记忆…`,
					value: text,
					disabled: busy,
					onChange: (event) => setText(event.target.value),
				}),
				h(
					"button",
					{
						style: { ...primaryBtn, opacity: canAdd ? 1 : 0.5 },
						disabled: !canAdd,
						onClick: () => {
							const value = text;
							onAdd(value).then((ok) => {
								if (ok) setText("");
							});
						},
					},
					"添加",
				),
			);
		}

		function StoreSection({ target, title, subtitle, view, busy, onWrite }) {
			return h(
				"section",
				{ style: card },
				h(
					"div",
					{ style: { ...row, justifyContent: "space-between", marginBottom: "4px" } },
					h("strong", { style: { fontSize: "14px" } }, title),
					h("span", { style: muted }, `${view.entries.length} 条 · ${view.usage}`),
				),
				h("div", { style: { ...muted, marginBottom: "8px" } }, subtitle),
				h("div", { style: { ...row, marginBottom: "12px" } }, h("div", { style: barTrack }, h("div", { style: barFill(view.percent) }))),
				view.entries.length === 0
					? h("div", { style: { ...muted, marginBottom: "10px" } }, "（空）")
					: view.entries.map((entry, index) =>
							h(EntryCard, {
								key: `${target}:${index}:${entry.slice(0, 24)}`,
								target,
								entry,
								index,
								busy,
								onSave: (oldText, content) => onWrite({ target, action: "patch", old_text: oldText, content }),
								onRemove: (oldText) => {
									if (typeof window !== "undefined" && typeof window.confirm === "function") {
										if (!window.confirm("删除这条记忆？")) return Promise.resolve(false);
									}
									return onWrite({ target, action: "remove", old_text: oldText });
								},
							}),
						),
				h(AddEntry, {
					target,
					busy,
					onAdd: (content) => onWrite({ target, action: "add", content }),
				}),
			);
		}

		function PendingSection({ items, busy, onDecide }) {
			if (!Array.isArray(items) || items.length === 0) return null;
			return h(
				"section",
				{ style: card },
				h(
					"div",
					{ style: { ...row, justifyContent: "space-between", marginBottom: "8px" } },
					h("strong", { style: { fontSize: "14px" } }, "待确认的后台改动"),
					h("span", { style: muted }, `${items.length} 条`),
				),
				h(
					"div",
					{ style: muted, marginBottom: "10px" },
					"后台 review 想删除或改写条目，需在这里批准；条目自提案后已变则会拒绝（stale）。",
				),
				items.map((item) =>
					h(
						"div",
						{ key: item.id, style: { ...card, padding: "10px 12px", marginBottom: "10px" } },
						h(
							"div",
							{ style: { ...row, justifyContent: "space-between", marginBottom: "4px" } },
							h("span", { style: { fontSize: "13px" } }, `${item.action} · ${item.target}`),
							h(
								"div",
								{ style: row },
								h(
									"button",
									{
										style: primaryBtn,
										disabled: busy,
										onClick: () => onDecide({ id: item.id, decision: "apply" }),
									},
									"批准",
								),
								h(
									"button",
									{ style: smallBtn, disabled: busy, onClick: () => onDecide({ id: item.id, decision: "discard" }) },
									"丢弃",
								),
							),
						),
						item.old_text
							? h(
									"div",
									{ style: { ...muted, whiteSpace: "pre-wrap", wordBreak: "break-word" } },
									`old: ${item.old_text.length > 200 ? `${item.old_text.slice(0, 200)}…` : item.old_text}`,
								)
							: null,
						item.content
							? h(
									"div",
									{ style: { ...muted, whiteSpace: "pre-wrap", wordBreak: "break-word" } },
									`new: ${item.content.length > 200 ? `${item.content.slice(0, 200)}…` : item.content}`,
								)
							: null,
						item.operation_count !== undefined ? h("div", { style: muted }, `批量操作 × ${item.operation_count}`) : null,
					),
				),
			);
		}

		/* ---------------------------------- page --------------------------------- */

		function PanelPage() {
			const [state, setState] = react.useState(null);
			const [error, setError] = react.useState("");
			const [busy, setBusy] = react.useState(false);
			const [notice, setNotice] = react.useState("");

			const refresh = react.useCallback(async (silent = false) => {
				try {
					const data = await fetchJson(API.state);
					setState(data);
					setError("");
					return data;
				} catch (err) {
					if (!silent) setError(err && err.message ? err.message : String(err));
					return null;
				}
			}, []);

			react.useEffect(() => {
				void refresh();
			}, [refresh]);

			react.useEffect(() => {
				if (typeof window === "undefined" || typeof document === "undefined") return undefined;
				const timer = setInterval(() => {
					void refresh(true);
				}, 10000);
				const onFocus = () => {
					void refresh(true);
				};
				const onVisibilityChange = () => {
					if (document.visibilityState === "visible") void refresh(true);
				};
				window.addEventListener("focus", onFocus);
				document.addEventListener("visibilitychange", onVisibilityChange);
				return () => {
					clearInterval(timer);
					window.removeEventListener("focus", onFocus);
					document.removeEventListener("visibilitychange", onVisibilityChange);
				};
			}, [refresh]);

			const applyResult = react.useCallback(
				async (promise) => {
					setBusy(true);
					setNotice("");
					try {
						const data = await promise;
						if (data && data.state) setState(data.state);
						else await refresh();
						setError("");
						setNotice("已保存");
						return true;
					} catch (err) {
						setError(err && err.message ? err.message : String(err));
						return false;
					} finally {
						setBusy(false);
					}
				},
				[refresh],
			);

			const onWrite = react.useCallback(
				(body) => applyResult(fetchJson(API.write, body)),
				[applyResult],
			);

			const onDecide = react.useCallback(
				(body) => applyResult(fetchJson(API.pending, body)),
				[applyResult],
			);

			if (!state) {
				return h(
					"div",
					{ style: { padding: "20px 24px", opacity: 0.7 } },
					error ? `加载失败：${error}` : "加载记忆…",
				);
			}

			const memory = state.targets && state.targets.memory;
			const user = state.targets && state.targets.user;

			return h(
				"div",
				{
					"data-dsh-memory-notes-view": "",
					style: { padding: "18px 22px 40px", overflow: "auto", height: "100%", boxSizing: "border-box" },
				},
				h(
					"div",
					{ style: { ...row, justifyContent: "space-between", marginBottom: "12px" } },
					h("strong", { style: { fontSize: "16px" } }, "记忆"),
					h(
						"div",
						{ style: row },
						notice && !error ? h("span", { style: muted }, notice) : null,
						h(
							"button",
							{
								style: smallBtn,
								disabled: busy,
								onClick: () => {
									void refresh();
								},
							},
							"刷新",
						),
					),
				),
				h(
					"div",
					{ style: { ...muted, marginBottom: "14px" } },
					"写入立即落盘；当前会话的系统提示词是会话开始时的冻结快照，下个会话才看到本次修改。",
				),
				error
					? h(
							"div",
							{
								style: {
									...card,
									borderColor: "rgba(217,83,79,0.6)",
									color: "#d9534f",
									padding: "10px 12px",
								},
							},
							error,
						)
					: null,
				user ? h(StoreSection, { target: "user", title: "USER PROFILE · 用户是谁", subtitle: "偏好、期望、背景；一条事实只进一个库。", view: user, busy, onWrite }) : null,
				memory ? h(StoreSection, { target: "memory", title: "MEMORY · 我的工作笔记", subtitle: "环境事实、工具怪癖、项目约定与路径。", view: memory, busy, onWrite }) : null,
				h(PendingSection, { items: state.pending, busy, onDecide }),
			);
		}

		/* ----------------------------- tool call rows ---------------------------- */

		// 每次 memory / skill_manage 调用在会话流里显示一行提示（🧠 已记住 · MEMORY 82%），
		// 对应 Hermes 的 "💾 Memory updated"；点开看完整内容与结果 JSON。

		const toolRowStyle = {
			display: "flex",
			alignItems: "flex-start",
			gap: "7px",
			padding: "3px 2px",
			borderRadius: "6px",
			cursor: "pointer",
			fontSize: "12px",
			lineHeight: "1.45",
			userSelect: "none",
		};
		const toolRowBody = { display: "flex", flexDirection: "column", gap: "1px", minWidth: 0, flex: "1 1 auto" };
		const toolRowTail = { marginLeft: "auto", opacity: 0.5, fontSize: "11px", whiteSpace: "nowrap" };
		const toolRowMeta = { opacity: 0.62, fontSize: "11px" };
		const toolRowDetails = {
			margin: "0 0 6px 24px",
			display: "flex",
			flexDirection: "column",
			gap: "5px",
			fontSize: "12px",
			lineHeight: "1.5",
			opacity: 0.88,
			whiteSpace: "pre-wrap",
			wordBreak: "break-word",
		};
		const errorText = { color: "#d9534f" };

		function clipText(value, max) {
			if (typeof value !== "string") return "";
			const text = value.replace(/\s+/g, " ").trim();
			if (text.length <= max) return text;
			return `${text.slice(0, Math.max(0, max - 1))}…`;
		}

		function callArguments(block) {
			if (!block || typeof block !== "object") return {};
			if (block.args && typeof block.args === "object" && !Array.isArray(block.args)) return block.args;
			const raw = block.call && typeof block.call.argsRaw === "string" ? block.call.argsRaw : block.argsRaw;
			if (typeof raw !== "string" || raw.trim() === "") return {};
			try {
				const value = JSON.parse(raw);
				return value && typeof value === "object" && !Array.isArray(value) ? value : {};
			} catch {
				return {};
			}
		}

		function callErrorText(block) {
			if (!block || typeof block !== "object" || !block.error || typeof block.error !== "object") return "";
			return String(block.error.reason || block.error.message || block.error.code || "");
		}

		function resultPayload(block) {
			if (!block || typeof block !== "object" || !Array.isArray(block.content)) return null;
			const text = block.content
				.filter((part) => part && part.type === "text" && typeof part.text === "string")
				.map((part) => part.text)
				.join("\n")
				.trim();
			if (text === "" || (text[0] !== "{" && text[0] !== "[")) return null;
			try {
				const value = JSON.parse(text);
				return value && typeof value === "object" && !Array.isArray(value) ? value : null;
			} catch {
				return null;
			}
		}

		function memoryCallView(args, result, failed, failureText) {
			const action = typeof args.action === "string" ? args.action : Array.isArray(args.operations) ? "operations" : "";
			const target = typeof args.target === "string" ? args.target : "";
			const where = target === "user" ? "USER" : target === "memory" ? "MEMORY" : "";
			const usage = result && typeof result.usage === "string" ? result.usage : "";
			const suffix = [where, usage].filter(Boolean).join(" · ");
			if (failed) {
				const reason = (result && (result.error || result.message)) || failureText || "未知错误";
				return { icon: "🧠", headline: "记忆写入失败", detail: clipText(String(reason), 160), failed: true };
			}
			if (!result) {
				const headline = {
					add: "正在记住一条新记忆",
					patch: "正在修改一条记忆",
					remove: "正在删除一条记忆",
					operations: "正在批量更新记忆",
				}[action] || "正在更新记忆";
				return { icon: "🧠", headline, detail: [where, clipText(args.content || args.old_text, 60)].filter(Boolean).join(" · ") };
			}
			if (result.staged) return { icon: "🧠", headline: "记忆修改已提交，等待确认", detail: clipText(result.message, 160) };
			switch (action) {
				case "add":
					return { icon: "🧠", headline: `已记住${suffix ? ` · ${suffix}` : ""}`, detail: clipText(args.content, 90) };
				case "patch":
					return {
						icon: "🧠",
						headline: `已更新一条记忆${suffix ? ` · ${suffix}` : ""}`,
						detail: clipText(`${args.old_text || ""} → ${args.content || ""}`, 120),
					};
				case "remove":
					return { icon: "🧠", headline: `已删除一条记忆${suffix ? ` · ${suffix}` : ""}`, detail: clipText(args.old_text, 120) };
				case "operations":
					return {
						icon: "🧠",
						headline: `已批量更新 ${Array.isArray(args.operations) ? args.operations.length : 0} 条${suffix ? ` · ${suffix}` : ""}`,
					};
				case "list_pending": {
					const count = typeof result.pending_count === "number" ? result.pending_count : Array.isArray(result.pending) ? result.pending.length : 0;
					return { icon: "🧠", headline: `待确认修改 ${count} 项` };
				}
				case "apply_pending":
					return { icon: "🧠", headline: "已应用待确认修改", detail: clipText(result.message, 120) };
				case "discard_pending":
					return { icon: "🧠", headline: "已丢弃待确认修改" };
				default:
					return { icon: "🧠", headline: "记忆已更新", detail: suffix };
			}
		}

		function skillCallView(args, result, failed, failureText) {
			const action = typeof args.action === "string" ? args.action : "";
			const skillName = typeof args.name === "string" ? args.name : "";
			if (failed) {
				const reason = (result && (result.error || result.message)) || failureText || "未知错误";
				return { icon: "📚", headline: "技能操作失败", detail: clipText(String(reason), 160), failed: true };
			}
			if (!result) {
				return { icon: "📚", headline: action === "read" ? "正在读取技能" : "正在更新技能库", detail: skillName };
			}
			const label = {
				create: "已创建技能",
				patch: "已更新技能",
				delete: "已删除技能",
				write_file: "已写入技能文件",
				read: "已读取技能",
				list: "技能列表",
			}[action] || "技能库已更新";
			return {
				icon: "📚",
				headline: `${label}${skillName ? ` · ${skillName}` : ""}`,
				detail: clipText(result.message || result.name || "", 120),
			};
		}

		function makeToolRow(viewFn) {
			return function ToolCallRow({ block }) {
				const [open, setOpen] = react.useState(false);
				const settled = !!(block && typeof block === "object" && "kind" in block);
				const args = callArguments(block);
				const result = settled ? resultPayload(block) : null;
				const failed = settled && ((result && result.success === false) || block.isError === true);
				const view = viewFn(args, result, failed, callErrorText(block));
				const details = [];
				const actionLine = [args.action, args.target ? `目标 ${args.target}` : ""].filter(Boolean).join(" · ");
				if (actionLine) details.push(`动作：${actionLine}`);
				if (typeof args.content === "string" && args.content.trim() !== "") details.push(`内容：${args.content}`);
				if (typeof args.old_text === "string" && args.old_text.trim() !== "") details.push(`原片段：${args.old_text}`);
				if (Array.isArray(args.operations)) details.push(`批量操作：${args.operations.length} 项`);
				if (result) details.push(`结果：${JSON.stringify(result, null, 2).slice(0, 1600)}`);
				return h(
					"div",
					null,
					h(
						"div",
						{
							style: toolRowStyle,
							role: "button",
							title: open ? "收起" : "查看详情",
							onClick: () => setOpen(!open),
						},
						h("span", { style: { fontSize: "13px", lineHeight: "18px" } }, view.icon),
						h(
							"span",
							{ style: toolRowBody },
							h("span", { style: view.failed ? errorText : undefined }, view.headline),
							view.detail ? h("span", { style: toolRowMeta }, view.detail) : null,
						),
						h("span", { style: toolRowTail }, open ? "收起" : "详情"),
					),
					open ? h("div", { style: toolRowDetails }, details.length > 0 ? details.join("\n") : "（暂无详情）") : null,
				);
			};
		}

		const MemoryToolRow = makeToolRow(memoryCallView);
		const SkillToolRow = makeToolRow(skillCallView);

		/* ------------------------------- registration ---------------------------- */

		const PANEL_ID = "memory-notes";
		const PANEL_ORDER = 31;

		function PanelIcon({ size }) {
			return h(
				"svg",
				{
					"data-dsh-panel-entry": PANEL_ID,
					viewBox: "0 0 16 16",
					width: size,
					height: size,
					fill: "none",
					stroke: "currentColor",
					strokeWidth: "1.3",
					strokeLinecap: "round",
					strokeLinejoin: "round",
					"aria-hidden": "true",
				},
				h("path", { d: "M4 2.5h8v11H4z" }),
				h("path", { d: "M6 5.5h4M6 8h4M6 10.5h2.5" }),
			);
		}

		function registerPanel(ctx) {
			const slots = ctx.slots;
			if (!slots || typeof slots.inject !== "function" || typeof slots.register !== "function") return () => {};
			const disposers = [];
			disposers.push(
				slots.inject("sidebar.panellist", () =>
					slots.register(
						{
							name: "sidebar.panellist",
							id: PANEL_ID,
							order: PANEL_ORDER,
							label: () => "记忆",
						},
						PanelIcon,
					),
				),
			);
			disposers.push(
				slots.inject("main", () =>
					slots.register(
						{
							name: "main",
							key: PANEL_ID,
							inject: () => ({}),
						},
						PanelPage,
					),
				),
			);
			return () => {
				for (const dispose of disposers.splice(0)) {
					try {
						dispose();
					} catch {
						/* 卸载失败不该影响宿主 */
					}
				}
			};
		}

		function registerToolViews(ctx) {
			const slots = ctx.slots;
			if (!slots || typeof slots.inject !== "function" || typeof slots.register !== "function") return () => {};
			const disposers = [];
			disposers.push(
				slots.inject("tool.call.toolview", () =>
					slots.register({ name: "tool.call.toolview", key: "memory" }, MemoryToolRow),
				),
			);
			disposers.push(
				slots.inject("tool.call.toolview", () =>
					slots.register({ name: "tool.call.toolview", key: "skill_manage" }, SkillToolRow),
				),
			);
			return () => {
				for (const dispose of disposers.splice(0)) {
					try {
						dispose();
					} catch {
						/* 卸载失败不该影响宿主 */
					}
				}
			};
		}

		function apply(ctx) {
			const disposers = [];
			try {
				disposers.push(registerPanel(ctx));
			} catch (err) {
				console.warn("[dsh-memory-notes] panel registration failed:", err);
			}
			try {
				disposers.push(registerToolViews(ctx));
			} catch (err) {
				console.warn("[dsh-memory-notes] tool row registration failed:", err);
			}
			if (typeof ctx.effect === "function") {
				ctx.effect(
					() => () => {
						for (const dispose of disposers.splice(0)) {
							try {
								dispose();
							} catch {
								/* ignore */
							}
						}
					},
					"memory-notes: ui mounts",
				);
			}
		}

		exports.apply = apply;
		exports.inject = ["slots"];
		return module.exports;
	},
});
