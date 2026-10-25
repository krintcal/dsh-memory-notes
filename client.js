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

		function apply(ctx) {
			let dispose = () => {};
			try {
				dispose = registerPanel(ctx);
			} catch (err) {
				console.warn("[dsh-memory-notes] panel registration failed:", err);
			}
			if (typeof ctx.effect === "function") {
				ctx.effect(() => () => dispose(), "memory-notes: ui mounts");
			}
		}

		exports.apply = apply;
		exports.inject = ["slots"];
		return module.exports;
	},
});
