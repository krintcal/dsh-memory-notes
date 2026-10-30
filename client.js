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
			suggestions: "api/dsh-memory-notes/suggestions",
			sync: "api/dsh-memory-notes/sync",
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
		const dangerBtn = { ...smallBtn, border: "1px solid rgba(179,38,30,0.7)", color: "#b3261e" };
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
			background: percent >= 90 ? "#b3261e" : percent >= 75 ? "#d9a441" : "#4a9d6a",
			transition: "width 160ms ease",
		});

		function formatClock(value) {
			const date = value instanceof Date ? value : new Date(value);
			if (Number.isNaN(date.getTime())) return "";
			return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
		}

		/* ------------------------------- entry card ------------------------------ */

		function EntryCard({ target, entry, index, busy, onSave, onRemove }) {
			const [text, setText] = react.useState(entry);
			react.useEffect(() => setText(entry), [entry]);
			const [confirming, setConfirming] = react.useState(false);
			react.useEffect(() => {
				if (!confirming) return undefined;
				const timer = setTimeout(() => setConfirming(false), 3000);
				return () => clearTimeout(timer);
			}, [confirming]);
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
						h(
							"button",
							{
								style: confirming ? dangerBtn : smallBtn,
								disabled: busy,
								onClick: () => {
									if (!confirming) {
										setConfirming(true);
										return;
									}
									setConfirming(false);
									onRemove(entry);
								},
							},
							confirming ? "确认删除" : "删除",
						),
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
								onRemove: (oldText) => onWrite({ target, action: "remove", old_text: oldText }),
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
						item.operation_count !== undefined
							? h(
									"div",
									{ style: { ...muted, marginTop: "4px", maxHeight: "160px", overflow: "auto" } },
									h("div", null, `批量操作 × ${item.operation_count}`),
									(Array.isArray(item.operations) ? item.operations : []).map((op, opIndex) =>
										h(
											"div",
											{ key: `${item.id}:op:${opIndex}`, style: { paddingLeft: "10px", whiteSpace: "pre-wrap", wordBreak: "break-word" } },
											`· ${op.action}${op.old_text ? ` "${op.old_text}"` : ""}${op.content ? ` → "${op.content}"` : ""}`,
										),
									),
									Array.isArray(item.operations) && item.operation_count > item.operations.length
										? h("div", null, `还有 ${item.operation_count - item.operations.length} 项`)
										: null,
								)
							: null,
					),
				),
			);
		}

		function SuggestionsSection({ items, busy, onDecide }) {
			if (!Array.isArray(items) || items.length === 0) return null;
			return h(
				"section",
				{ style: card },
				h(
					"div",
					{ style: { ...row, justifyContent: "space-between", marginBottom: "8px" } },
					h("strong", { style: { fontSize: "14px" } }, "建议"),
					h("span", { style: muted }, `${items.length} 条`),
				),
				h(
					"div",
					{ style: { ...muted, marginBottom: "10px" } },
					"回顾时以 suggest 模式提交的记忆建议；采纳后才会真正写入对应记忆库。",
				),
				items.map((item) =>
					h(
						"div",
						{ key: item.id, style: { ...card, padding: "10px 12px", marginBottom: "10px" } },
						h(
							"div",
							{ style: { ...row, justifyContent: "space-between", marginBottom: "4px" } },
							h("span", { style: { fontSize: "13px" } }, `${item.target} · ${formatClock(item.created_at)}`),
							h(
								"div",
								{ style: row },
								h(
									"button",
									{
										style: primaryBtn,
										disabled: busy,
										onClick: () => onDecide({ id: item.id, decision: "accept" }),
									},
									"采纳",
								),
								h(
									"button",
									{ style: smallBtn, disabled: busy, onClick: () => onDecide({ id: item.id, decision: "discard" }) },
									"丢弃",
								),
							),
						),
						h(
							"div",
							{ style: { ...muted, whiteSpace: "pre-wrap", wordBreak: "break-word" } },
							item.text && item.text.length > 280 ? `${item.text.slice(0, 280)}…` : item.text || "",
						),
					),
				),
			);
		}


		function writeSummary(item) {
			const values = [item.after, item.before, item.content, item.old_text];
			const text = values.find((value) => typeof value === "string" && value.trim() !== "");
			return text ? clipText(text, 80) : "";
		}

		function undoBody(item) {
			if (!item || item.batch) return undefined;
			if (item.action === "add" && typeof item.after === "string") {
				return { target: item.target, action: "remove", old_text: item.after };
			}
			if (item.action === "remove" && typeof item.before === "string") {
				return { target: item.target, action: "add", content: item.before };
			}
			if (
				(item.action === "patch" || item.action === "replace") &&
				typeof item.after === "string" &&
				typeof item.before === "string"
			) {
				return { target: item.target, action: "patch", old_text: item.after, content: item.before };
			}
			return undefined;
		}

		function ReviewsSection({ items }) {
			const list = Array.isArray(items) ? items : [];
			return h(
				"section",
				{ style: card },
				h(
					"div",
					{ style: { ...row, justifyContent: "space-between", marginBottom: "8px" } },
					h("strong", { style: { fontSize: "14px" } }, "最近 review"),
					h("span", { style: muted }, `${list.length} 条`),
				),
				list.length === 0
					? h("div", { style: muted }, "还没有后台 review 记录")
					: list.map((item) =>
							h(
								"div",
								{
									key: item.id,
									style: { ...row, justifyContent: "space-between", gap: "12px", padding: "3px 0" },
								},
								h("span", { style: { fontSize: "13px", wordBreak: "break-word" } }, item.summary || ""),
								h("span", { style: { ...muted, whiteSpace: "nowrap" } }, formatClock(item.finished_at)),
							),
						),
			);
		}

		function WritesSection({ items, busy, onWrite }) {
			const list = Array.isArray(items) ? items : [];
			return h(
				"section",
				{ style: card },
				h(
					"div",
					{ style: { ...row, justifyContent: "space-between", marginBottom: "8px" } },
					h("strong", { style: { fontSize: "14px" } }, "最近变更"),
					h("span", { style: muted }, `${list.length} 条`),
				),
				list.length === 0
					? h("div", { style: muted }, "还没有写入记录")
					: list.map((item, index) => {
							const undo = undoBody(item);
							return h(
								"div",
								{ key: `${item.ts}:${index}`, style: { ...card, padding: "8px 10px", marginBottom: "8px" } },
								h(
									"div",
									{ style: { ...row, justifyContent: "space-between", marginBottom: "3px" } },
									h(
										"span",
										{ style: { fontSize: "13px" } },
										`${formatClock(item.ts)} · ${item.action} · ${item.target}`,
									),
									item.batch
										? h("span", { style: muted }, "批量操作不可撤销")
										: undo
											? h("button", { style: smallBtn, disabled: busy, onClick: () => onWrite(undo) }, "撤销")
											: null,
								),
								h("div", { style: { ...muted, wordBreak: "break-word" } }, writeSummary(item)),
							);
						}),
			);
		}

		/* ---------------------------------- page --------------------------------- */

		/* --------------------------- 同步与疑似重复 --------------------------- */

		const TARGET_LABELS = {
			memory: "MEMORY",
			user: "USER",
			key: "KEY",
			project: "PROJECT",
			daily: "DAILY",
		};

		const syncTextArea = {
			width: "100%",
			boxSizing: "border-box",
			minHeight: "120px",
			marginTop: "8px",
			padding: "8px 10px",
			fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace",
			fontSize: "12px",
			lineHeight: "1.45",
			borderRadius: "8px",
			border: "1px solid rgba(127,127,127,0.35)",
			background: "transparent",
			color: "inherit",
			resize: "vertical",
		};

		// 0.9.0：把另一台设备的 bundle 合并进来。只加不删，删除只报告。
		function SyncSection({ busy, onMerged }) {
			const [text, setText] = react.useState("");
			const [localBusy, setLocalBusy] = react.useState(false);
			const [message, setMessage] = react.useState("");
			const [failure, setFailure] = react.useState("");

			const doExport = react.useCallback(async () => {
				setLocalBusy(true);
				setMessage("");
				setFailure("");
				try {
					const data = await fetchJson(API.sync);
					const bundle = data && data.bundle ? data.bundle : data;
					setText(JSON.stringify(bundle, null, 2));
					setMessage("已导出；复制这段 JSON 到另一台设备的输入框里合并。");
				} catch (err) {
					setFailure(err && err.message ? err.message : String(err));
				} finally {
					setLocalBusy(false);
				}
			}, []);

			const doMerge = react.useCallback(async () => {
				setLocalBusy(true);
				setMessage("");
				setFailure("");
				try {
					let bundle;
					try {
						bundle = JSON.parse(text);
					} catch {
						throw new Error("JSON 解析失败：请粘贴完整导出内容");
					}
					const data = await fetchJson(API.sync, bundle);
					const added = typeof data.added === "number" ? data.added : 0;
					setMessage(`合并完成：新增 ${added} 条；远端删除只报告不执行。`);
					if (onMerged) await onMerged();
				} catch (err) {
					setFailure(err && err.message ? err.message : String(err));
				} finally {
					setLocalBusy(false);
				}
			}, [text, onMerged]);

			return h(
				"div",
				{ style: card },
				h(
					"div",
					{ style: { ...row, justifyContent: "space-between", marginBottom: "6px" } },
					h("strong", null, "SYNC · 同步 / 迁移"),
					h(
						"div",
						{ style: row },
						h(
							"button",
							{ style: smallBtn, disabled: busy || localBusy, onClick: () => void doExport() },
							"导出 JSON",
						),
						h(
							"button",
							{
								style: smallBtn,
								disabled: busy || localBusy || !text.trim(),
								onClick: () => void doMerge(),
							},
							"合并导入",
						),
					),
				),
				h(
					"div",
					{ style: muted },
					"安全合并：远端新增才写入；远端删除只报告、不执行；内容重复会在下面「疑似重复」里提示，手动处理。",
				),
				h("textarea", {
					style: syncTextArea,
					value: text,
					placeholder: "粘贴另一台设备「导出 JSON」得到的内容…",
					onChange: (event) => setText(event.target.value),
					spellCheck: false,
				}),
				message ? h("div", { style: { ...muted, color: "#2e7d32", marginTop: "6px" } }, message) : null,
				failure ? h("div", { style: { ...muted, color: "#b3261e", marginTop: "6px" } }, failure) : null,
			);
		}

		// 0.9.0：疑似重复/冲突只提示，不自动合并。
		function ConflictsSection({ items }) {
			if (!Array.isArray(items) || items.length === 0) return null;
			return h(
				"div",
				{ style: card },
				h("strong", null, "疑似重复 · 需要人工合并"),
				h(
					"div",
					{ style: { ...muted, marginTop: "4px" } },
					"这些条目内容高度相似（相似度 ≥ 0.8）；工具与同步都不会自动合并，请编辑其中一条。",
				),
				items.map((item, index) =>
					h(
						"div",
						{
							key: `${item.target}-${index}`,
							style: { marginTop: "10px", paddingTop: index === 0 ? "0" : "10px", borderTop: index === 0 ? "none" : "1px solid rgba(127,127,127,0.18)" },
						},
						h(
							"div",
							{ style: muted },
							`${TARGET_LABELS[item.target] || item.target} · 相似度 ${Math.round((item.similarity || 0) * 100)}%`,
						),
						h("div", { style: { fontSize: "12px", marginTop: "4px", opacity: 0.85 } }, `A: ${clipText(item.a, 160)}`),
						h("div", { style: { fontSize: "12px", marginTop: "2px", opacity: 0.85 } }, `B: ${clipText(item.b, 160)}`),
					),
				),
			);
		}

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

			const onSuggest = react.useCallback(
				(body) => applyResult(fetchJson(API.suggestions, body)),
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
			const key = state.targets && state.targets.key;
			const project = state.targets && state.targets.project;
			const daily = state.targets && state.targets.daily;

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
							busy ? "刷新中…" : "刷新",
						),
					),
				),
				h(
					"div",
					{ style: { ...muted, marginBottom: "14px" } },
					"写入立即落盘；记忆块作为运行时上下文消息注入，内容变化时会在对话尾部追加新消息，本会话内写入下一轮即可见。",
				),
				error
					? h(
							"div",
							{
								style: {
									...card,
									borderColor: "rgba(179,38,30,0.6)",
									color: "#b3261e",
									padding: "10px 12px",
								},
							},
							error,
						)
					: null,
				user ? h(StoreSection, { target: "user", title: "USER PROFILE · 用户是谁", subtitle: "偏好、期望、背景；一条事实只进一个库。", view: user, busy, onWrite }) : null,
				memory ? h(StoreSection, { target: "memory", title: "MEMORY · 我的工作笔记", subtitle: "环境事实、工具怪癖、项目约定与路径。", view: memory, busy, onWrite }) : null,
				key
					? h(StoreSection, {
							target: "key",
							title: "KEY · 当前项目/分支要点",
							subtitle: "按项目路径隔离并按 git 分支过滤；会注入上下文。",
							view: key,
							busy,
							onWrite,
						})
					: null,
				project
					? h(StoreSection, {
							target: "project",
							title: "PROJECT LOG · 项目日志",
							subtitle: "按项目路径隔离，作为工作日志，不注入上下文。",
							view: project,
							busy,
							onWrite,
						})
					: null,
				daily
					? h(StoreSection, {
							target: "daily",
							title: "DAILY LOG · 每日日志",
							subtitle: "按日期分文件，作为每日工作日志，不注入上下文。",
							view: daily,
							busy,
							onWrite,
						})
					: null,
				h(PendingSection, { items: state.pending, busy, onDecide }),
				h(SuggestionsSection, { items: state.suggestions, busy, onDecide: onSuggest }),
				h(ReviewsSection, { items: state.reviews }),
				h(WritesSection, { items: state.writes, busy, onWrite }),
				h(ConflictsSection, { items: state.conflicts }),
				h(SyncSection, { busy, onMerged: refresh }),
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
		const errorText = { color: "#b3261e" };

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
					suggest: "正在提交一条记忆建议",
					operations: "正在批量更新记忆",
				}[action] || "正在更新记忆";
				return { icon: "🧠", headline, detail: [where, clipText(args.content || args.old_text, 60)].filter(Boolean).join(" · ") };
			}
			if (action === "suggest") {
				return { icon: "🧠", headline: "记忆建议已入队，等待确认", detail: clipText(args.content, 90) };
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

		// 宿主的 layout face（打开面板用）；apply 时取一次，取不到就在点击时再懒取。
		let layoutFace = null;
		let appCtx = null;

		const PLACEHOLDER_COMMANDS = /^\/(memory|记忆)(\s|$)/i;

		function useMemoryStatus() {
			const [status, setStatus] = react.useState({ pending: 0, suggestions: 0 });
			react.useEffect(() => {
				let alive = true;
				const pull = async () => {
					try {
						const res = await fetch(API.state);
						const data = await res.json();
						if (!alive) return;
						setStatus({
							pending: Array.isArray(data.pending) ? data.pending.length : 0,
							suggestions: Array.isArray(data.suggestions) ? data.suggestions.length : 0,
						});
					} catch {
						/* 面板不可用就不显示徽标 */
					}
				};
				void pull();
				const timer = setInterval(pull, 20000);
				const onFocus = () => void pull();
				window.addEventListener("focus", onFocus);
				return () => {
					alive = false;
					clearInterval(timer);
					window.removeEventListener("focus", onFocus);
				};
			}, []);
			return status;
		}

		/* 输入框下方的常驻入口：待确认数、命令提示与「打开面板」。 */
		function MemoryDock(props) {
			const status = useMemoryStatus();
			let text = "";
			try {
				text = typeof props?.useInput === "function" ? props.useInput((state) => state?.text ?? "") : "";
			} catch {
				text = "";
			}
			const commandMode = typeof text === "string" && PLACEHOLDER_COMMANDS.test(text);
			const inputActions = props?.inputActions;
			const canClear =
				typeof inputActions?.clear === "function" || typeof inputActions?.setText === "function";
			const openPanel = () => {
				try {
					const face = resolveLayoutFace();
					face?.selectPanel?.(PANEL_ID);
				} catch (err) {
					console.warn("[dsh-memory-notes] cannot open the memory panel:", err);
				}
			};
			const clearInput = () => {
				try {
					if (typeof inputActions?.clear === "function") {
						inputActions.clear();
						return;
					}
					inputActions?.setText?.("");
				} catch {
					/* 清空失败不影响输入框 */
				}
			};
			const children = [h("span", { key: "label" }, "🧠 记忆")];
			if (status.pending > 0) {
				children.push(
					h("span", { key: "pending", style: { color: "#b3261e", fontWeight: 600 } }, `· 待确认 ${status.pending}`),
				);
			}
			if (commandMode) {
				children.push(h("span", { key: "hint" }, "· 命令：打开面板 / 清空输入"));
			}
			children.push(
				h("span", { key: "spacer", style: { flex: "1 1 auto" } }),
				h("button", { key: "open", style: smallBtn, onClick: openPanel }, "打开面板"),
			);
			if (commandMode && canClear) {
				children.push(h("button", { key: "clear", style: smallBtn, onClick: clearInput }, "清空输入"));
			}
			return h(
				"div",
				{
					"data-dsh-memory-notes-dock": "",
					style: { display: "flex", alignItems: "center", gap: "8px", fontSize: "12px", color: "#6b7280", padding: "2px 2px" },
				},
				children,
			);
		}

		/* 侧栏折叠时展开按钮里的红点。 */
		function MemoryBadge() {
			const status = useMemoryStatus();
			if (!status.pending) return null;
			return h("span", {
				title: `${status.pending} 条记忆待确认`,
				style: { display: "inline-block", width: 6, height: 6, borderRadius: 3, background: "#b3261e" },
			});
		}

		/* layout 服务可能比我们晚就绪：点击时再解析一次，别把 null 缓存成永久结论。 */
		function resolveLayoutFace() {
			if (layoutFace) return layoutFace;
			try {
				layoutFace = appCtx?.layout ?? appCtx?.get?.("layout") ?? null;
			} catch {
				layoutFace = null;
			}
			return layoutFace;
		}

		function registerMemoryEntrypoints(ctx) {
			const slots = ctx.slots;
			if (!slots || typeof slots.inject !== "function" || typeof slots.register !== "function") return () => {};
			const disposers = [];
			try {
				disposers.push(
					slots.inject("conversation.composer.dock", () =>
						slots.register(
							{
								name: "conversation.composer.dock",
								id: "memory-notes-dock",
								order: 40,
								label: () => "记忆",
							},
							MemoryDock,
						),
					),
				);
			} catch {
				/* 宿主没有该 slot 时跳过 */
			}
			try {
				disposers.push(
					slots.inject("sidebar.toggle.badge", () =>
						slots.register({ name: "sidebar.toggle.badge" }, MemoryBadge),
					),
				);
			} catch {
				/* 宿主没有该 slot 时跳过 */
			}
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
			appCtx = ctx;
			try {
				layoutFace = ctx.layout ?? ctx.get?.("layout") ?? null;
			} catch {
				layoutFace = null;
			}
			try {
				disposers.push(registerPanel(ctx));
			} catch (err) {
				console.warn("[dsh-memory-notes] panel registration failed:", err);
			}
			try {
				disposers.push(registerMemoryEntrypoints(ctx));
			} catch (err) {
				console.warn("[dsh-memory-notes] composer entry registration failed:", err);
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
		exports.inject = ["slots", "layout"];
		return module.exports;
	},
});
