window.__ModuleLoader__.load({
	id: "dsh-memory-notes",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		const h = react.createElement;

		/* ------------------------------ Design tokens ------------------------------ */
		// 颜色走 DSH 主题变量（--dsw-alias-*，light/dark 由主题包切换），
		// 第二参数是脱离宿主（单测/离线渲染）时的 fallback。
		const T = {
			font: { xs: "11px", sm: "12px", md: "13px", lg: "14px", xl: "15px" },
			radius: { xs: "4px", sm: "6px", md: "8px", lg: "10px", pill: "999px" },
			space: { 0: "0px", 1: "2px", 2: "4px", 3: "6px", 4: "8px", 5: "10px", 6: "12px", 7: "14px", 8: "16px", 9: "18px", 10: "20px", 12: "24px", 14: "28px", 28: "56px" },
			color: {
				text: "var(--dsw-alias-label-primary, #1f2328)",
				textSecondary: "var(--dsw-alias-label-secondary, #4a5058)",
				textTertiary: "var(--dsw-alias-label-tertiary, #6b7280)",
				textDimmed: "var(--dsw-alias-label-dimmed, #6b7280)",
				textCaption: "var(--dsw-alias-label-caption, #6b7280)",
				bgBase: "var(--dsw-alias-bg-base, #ffffff)",
				bgLayer1: "var(--dsw-alias-bg-layer-1, #f7f7f8)",
				bgLayer2: "var(--dsw-alias-bg-layer-2, #f2f2f4)",
				hoverSubtle: "var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.06))",
				fillQuiet: "var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.16))",
				fill: "var(--dsw-alias-bg-skeleton, rgba(127,127,127,0.20))",
				fillStrong: "var(--dsw-alias-interactive-bg-active, rgba(127,127,127,0.25))",
				danger: "var(--dsw-alias-state-error-primary, #b3261e)",
				dangerBg: "var(--dsw-alias-interactive-bg-hover-danger, rgba(179,38,30,0.12))",
				success: "var(--dsw-alias-state-success-primary, #2e7d32)",
				successBg: "var(--dsw-alias-state-success-tertiary, rgba(46,125,50,0.14))",
				warn: "var(--dsw-alias-state-warn-primary, #d9a441)",
				brand: "var(--dsw-alias-brand-primary, #b3261e)",
				link: "var(--dsw-alias-link, #6b7280)",
				toastBg: "var(--dsw-alias-toast-bg, rgba(32,32,32,0.94))",
				toastLabel: "var(--dsw-alias-toast-label, #ffffff)",
				mask: "var(--dsw-alias-bg-mask, rgba(0,0,0,0.35))",
				dangerOnDark: "#ffb4ab",

			},
			border: {
				subtle: "var(--dsw-alias-border-l1, rgba(127,127,127,0.22))",  // 细线：分隔、卡片
				base: "var(--dsw-alias-border-l2, rgba(127,127,127,0.32))",
				strong: "var(--dsw-alias-border-l3, rgba(127,127,127,0.45))",
				stronger: "var(--dsw-alias-border-l4, rgba(127,127,127,0.70))",
				danger: "var(--dsw-alias-state-error-primary, #b3261e)",
				onDark: "rgba(255,255,255,0.55)",
			},
			shadow: {
				pop: "0 6px 24px var(--dsw-alias-bg-mask-drop, rgba(0,0,0,0.28))",
			},
			line: { tight: 1.45, base: 1.5, loose: 1.6, pixel: "18px" },
		};

		/* ------------------------------ API client ------------------------------ */

		// 文档相对路径（无前导斜杠）：GUI 用 <base href="./">，根绝对路径会逃出
		// 子路径部署（/dsh/dsh/ 之类）。
		const API = {
			state: "api/dsh-memory-notes/state",
			write: "api/dsh-memory-notes/write",
			pending: "api/dsh-memory-notes/pending",
			suggestions: "api/dsh-memory-notes/suggestions",
			sync: "api/dsh-memory-notes/sync",
			search: "api/dsh-memory-notes/search",
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
			border: `1px solid ${T.border.base}`,
			borderRadius: T.radius.lg,
			padding: `${T.space[7]} ${T.space[8]}`,
			marginBottom: T.space[7],
			background: "transparent",
		};
		const row = { display: "flex", alignItems: "center", gap: T.space[5] };
		const muted = { opacity: 0.66, fontSize: T.font.sm };
		const smallBtn = {
			font: "inherit",
			fontSize: T.font.sm,
			padding: `${T.space[2]} ${T.space[5]}`,
			borderRadius: T.radius.md,
			border: `1px solid ${T.border.strong}`,
			background: "transparent",
			color: "inherit",
			cursor: "pointer",
		};
		const primaryBtn = {
			...smallBtn,
			border: `1px solid ${T.border.stronger}`,
			background: T.color.fillQuiet,
		};
		const dangerBtn = { ...smallBtn, border: `1px solid ${T.border.danger}`, color: T.color.danger };
		const focusRing = { outline: "2px solid currentColor", outlineOffset: "1px" };
		const focusShadow = "0 0 0 2px currentColor";
		function withFocus(props) {
			const base = props || {};
			return {
				...base,
				onFocus: (event) => {
					const node = event && event.currentTarget;
					if (node && node.style) {
						node.style.boxShadow = focusShadow;
						node.style.outline = focusRing.outline;
						node.style.outlineOffset = focusRing.outlineOffset;
					}
					if (typeof base.onFocus === "function") base.onFocus(event);
				},
				onBlur: (event) => {
					const node = event && event.currentTarget;
					if (node && node.style) {
						node.style.boxShadow = "";
						node.style.outline = "";
						node.style.outlineOffset = "";
					}
					if (typeof base.onBlur === "function") base.onBlur(event);
				},
			};
		}
		const textarea = {
			width: "100%",
			boxSizing: "border-box",
			minHeight: "52px",
			resize: "vertical",
			font: "inherit",
			fontSize: T.font.md,
			lineHeight: T.line.tight,
			color: "inherit",
			background: "transparent",
			border: `1px solid ${T.border.base}`,
			borderRadius: T.radius.md,
			padding: `${T.space[4]} ${T.space[5]}`,
			outline: "none",
		};
		const barTrack = {
			height: "5px",
			borderRadius: T.radius.pill,
			background: T.color.fillStrong,
			overflow: "hidden",
			flex: "1 1 auto",
		};
		const barFill = (percent) => ({
			height: "100%",
			width: `${Math.max(0, Math.min(100, percent))}%`,
			borderRadius: T.radius.pill,
			background: percent >= 90 ? T.color.danger : percent >= 75 ? T.color.warn : T.color.success,
			transition: "width 160ms ease",
		});

		const panel = {
			padding: `${T.space[10]} ${T.space[14]} ${T.space[28]}`,
			maxWidth: "1280px",
			margin: "0",
			width: "100%",
			boxSizing: "border-box",
			height: "100%",
			overflow: "auto",
		};
		const title = { fontSize: T.font.xl, fontWeight: 600, letterSpacing: "0.01em" };
		const note = { fontSize: T.font.sm, opacity: 0.55, margin: `${T.space[3]} 0 ${T.space[7]}` };
		const tabBar = { display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: T.space[1], marginBottom: T.space[7], borderBottom: `1px solid ${T.border.subtle}` };
		const tabBase = {
			font: "inherit",
			fontSize: T.font.sm,
			padding: `${T.space[3]} ${T.space[5]}`,
			marginBottom: "-1px",
			border: "none",
			borderBottom: "2px solid transparent",
			background: "transparent",
			color: "inherit",
			cursor: "pointer",
			opacity: 0.55,
		};
		const tabActive = { ...tabBase, opacity: 1, borderBottom: "2px solid currentColor" };
		const tabCount = { marginLeft: T.space[2], fontSize: T.font.xs, opacity: 0.6 };
		const thinTrack = { height: "3px", borderRadius: T.radius.pill, background: T.color.fill, overflow: "hidden", flex: "1 1 auto" };
		const entryRow = { display: "flex", alignItems: "flex-start", gap: T.space[4], padding: `${T.space[3]} ${T.space[4]}`, borderRadius: T.radius.md, borderBottom: `1px solid ${T.border.subtle}`, width: "100%", boxSizing: "border-box" };
		const entryText = { flex: "1 1 auto", minWidth: 0, fontSize: T.font.md, lineHeight: T.line.base, whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: "42px", overflow: "hidden", cursor: "pointer" };
		const ghostBtn = { font: "inherit", fontSize: T.font.xs, padding: `${T.space[1]} ${T.space[3]}`, border: "none", borderRadius: T.radius.sm, background: "transparent", color: "inherit", opacity: 0.55, cursor: "pointer" };
		const statGroup = { display: "flex", alignItems: "center", flexWrap: "wrap", gap: T.space[5] };
		const statText = { fontSize: T.font.sm, opacity: 0.66 };
		const statBadge = {
			display: "inline-block",
			minWidth: T.space[4],
			marginLeft: T.space[2],
			padding: `0 ${T.space[2]}`,
			borderRadius: T.radius.pill,
			background: T.color.fillQuiet,
			fontSize: T.font.xs,
			lineHeight: T.line.pixel,
			textAlign: "center",
		};
		const ringColor = (percent) => (percent >= 90 ? T.color.danger : percent >= 75 ? T.color.warn : T.color.success);
		const budgetRing = (percent) => {
			const clamped = Math.max(0, Math.min(100, percent));
			return {
				display: "inline-flex",
				alignItems: "center",
				justifyContent: "center",
				width: T.space[8],
				height: T.space[8],
				borderRadius: T.radius.pill,
				background: `conic-gradient(${ringColor(clamped)} ${clamped}%, ${T.color.fill} 0)`,
				flex: "0 0 auto",
			};
		};
		const budgetRingHole = { width: T.space[6], height: T.space[6], borderRadius: T.radius.pill, background: T.color.bgBase };
		const drawerMask = { position: "fixed", inset: 0, background: T.color.mask, zIndex: 39 };
		const drawerPanel = {
			position: "fixed",
			top: 0,
			right: 0,
			bottom: 0,
			width: "min(420px, 92vw)",
			boxSizing: "border-box",
			background: T.color.bgBase,
			borderLeft: `1px solid ${T.border.subtle}`,
			boxShadow: T.shadow.pop,
			overflow: "auto",
			padding: T.space[9],
			zIndex: 40,
		};
		const drawerHeader = { ...row, justifyContent: "space-between", marginBottom: T.space[7] };
		const drawerNav = { ...tabBar, marginBottom: T.space[7] };
		const drawerEmpty = { ...muted, marginTop: T.space[5] };

		const TRACK_META = [
			{
				key: "memory",
				label: "记忆",
				title: "MEMORY · 我的工作笔记",
				hint: "记环境事实与踩坑结论，例：『pnpm 12.x 与桌面端不匹配，要用运行时自带的 11.28.5』",
			},
			{
				key: "user",
				label: "用户",
				title: "USER PROFILE · 用户是谁",
				hint: "记用户偏好，例：『回答尽量简短』",
			},
			{
				key: "key",
				label: "关键",
				title: "KEY · 当前项目/分支要点",
				hint: "记当前项目/分支的关键决策，例：『这个分支先不升级 cordis，等宿主发版』",
			},
			{
				key: "project",
				label: "项目日志",
				title: "PROJECT · 项目日志",
				hint: "每回合一行进展（不注入上下文，靠 memory action:'search' 查），例：『0.14.0 面板交互 P0 完成』",
			},
			{
				key: "daily",
				label: "每日",
				title: "DAILY · 每日日志",
				hint: "当天小结（同上），例：『今天修完按条目 busy 与编辑期暂停轮询』",
			},
		];
		const flatSection = { marginBottom: T.space[8] };
		const itemBox = { padding: `${T.space[4]} ${T.space[5]}`, borderRadius: T.radius.md, marginBottom: T.space[4], background: T.color.hoverSubtle };
		const diffLine = (kind) => ({
			...muted,
			whiteSpace: "pre-wrap",
			wordBreak: "break-word",
			padding: `${T.space[1]} ${T.space[3]}`,
			marginTop: T.space[1],
			borderRadius: T.radius.xs,
			background: kind === "remove" ? T.color.dangerBg : T.color.successBg,
			color: kind === "remove" ? T.color.danger : T.color.success,
		});
		const searchInput = {
			font: "inherit",
			fontSize: T.font.sm,
			padding: `${T.space[2]} ${T.space[4]}`,
			minWidth: "160px",
			borderRadius: T.radius.md,
			border: `1px solid ${T.border.strong}`,
			background: "transparent",
			color: "inherit",
			cursor: "text",
		};
		const searchResultRow = {
			display: "block",
			width: "100%",
			boxSizing: "border-box",
			textAlign: "left",
			font: "inherit",
			fontSize: T.font.md,
			lineHeight: T.line.base,
			padding: `${T.space[3]} ${T.space[4]}`,
			border: "none",
			borderBottom: `1px solid ${T.border.subtle}`,
			background: "transparent",
			color: "inherit",
			cursor: "pointer",
			whiteSpace: "pre-wrap",
			wordBreak: "break-word",
		};
		const toastBox = {
			position: "fixed",
			left: "50%",
			bottom: "24px",
			transform: "translateX(-50%)",
			display: "flex",
			alignItems: "center",
			gap: T.space[5],
			padding: `${T.space[4]} ${T.space[7]}`,
			borderRadius: T.radius.lg,
			border: `1px solid ${T.border.strong}`,
			background: T.color.toastBg,
			color: T.color.toastLabel,
			fontSize: T.font.md,
			boxShadow: T.shadow.pop,
			zIndex: 60,
		};
		const toastBtn = { ...smallBtn, color: "inherit", border: `1px solid ${T.border.onDark}`, padding: `${T.space[1]} ${T.space[4]}` };

		function clipRaw(value, max) {
			if (typeof value !== "string") return "";
			return value.length > max ? `${value.slice(0, max)}…` : value;
		}

		function diffRows(oldText, newText, keyPrefix) {
			const nodes = [];
			if (typeof oldText === "string" && oldText !== "") {
				nodes.push(h("div", { key: `${keyPrefix}:del`, style: diffLine("remove") }, `− ${clipRaw(oldText, 240)}`));
			}
			if (typeof newText === "string" && newText !== "") {
				nodes.push(h("div", { key: `${keyPrefix}:add`, style: diffLine("add") }, `+ ${clipRaw(newText, 240)}`));
			}
			return nodes;
		}

		function trackLabel(key) {
			const meta = TRACK_META.find((item) => item.key === key);
			return meta ? meta.label : key;
		}

		function formatClock(value) {
			const date = value instanceof Date ? value : new Date(value);
			if (Number.isNaN(date.getTime())) return "";
			return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
		}

		/* ------------------------------- entry card ------------------------------ */

		function EntryCard({ target, entry, index, busy, saved, onSave, onRemove, onEditingChange }) {
			const [editing, setEditing] = react.useState(false);
			const [text, setText] = react.useState(entry);
			const [confirming, setConfirming] = react.useState(false);
			const [saveState, setSaveState] = react.useState("");
			react.useEffect(() => {
				setText(entry);
				setEditing(false);
				setSaveState("");
			}, [entry]);
			react.useEffect(() => {
				if (!editing) return undefined;
				onEditingChange?.(1);
				return () => onEditingChange?.(-1);
			}, [editing, onEditingChange]);
			react.useEffect(() => {
				if (!confirming) return undefined;
				const timer = setTimeout(() => setConfirming(false), 3000);
				return () => clearTimeout(timer);
			}, [confirming]);
			react.useEffect(() => {
				if (saveState !== "saved") return undefined;
				const timer = setTimeout(() => setSaveState(""), 2000);
				return () => clearTimeout(timer);
			}, [saveState]);

			const dirty = text !== entry;

			const handleSave = async () => {
				if (busy || !dirty) return;
				setSaveState("saving");
				try {
					const result = await onSave(entry, text);
					if (result && result.ok) setSaveState("saved");
					else setSaveState((result && result.error) || "保存失败");
				} catch (err) {
					setSaveState(err && err.message ? err.message : String(err));
				}
			};

			const handleRemove = async () => {
				if (busy) return;
				if (!confirming) {
					setConfirming(true);
					return;
				}
				setConfirming(false);
				try {
					const result = await onRemove(entry);
					if (result && result.ok === false) setSaveState(result.error || "删除失败");
				} catch (err) {
					setSaveState(err && err.message ? err.message : String(err));
				}
			};

			if (!editing) {
				return h(
					"div",
					{ style: entryRow },
					h(
						"span",
						withFocus({
							style: entryText,
							title: entry,
							tabIndex: 0,
							role: "button",
							"aria-label": "编辑这条记忆",
							onClick: () => setEditing(true),
							onKeyDown: (event) => {
								if (event.key === "Enter" || event.key === " ") {
									event.preventDefault();
									setEditing(true);
								}
							},
						}),
						entry,
					),
					saved ? h("span", { style: { ...muted, color: T.color.success, flex: "0 0 auto" } }, "已保存 ✓") : null,
					h(
						"button",
						withFocus({
							style: { ...ghostBtn, flex: "0 0 auto" },
							disabled: busy,
							"aria-label": "编辑这条记忆",
							onClick: () => setEditing(true),
						}),
						"编辑",
					),
				);
			}
			const feedback =
				saveState === "saving"
					? h("span", { style: muted }, "保存中…")
					: saveState === "saved"
						? h("span", { style: { ...muted, color: T.color.success } }, "已保存 ✓")
						: saveState
							? h("span", { style: { color: T.color.danger, fontSize: T.font.sm, wordBreak: "break-word" } }, saveState)
							: null;
			return h(
				"div",
				{ style: { ...entryRow, flexDirection: "column", gap: T.space[3], background: T.color.hoverSubtle } },
				h(
					"textarea",
					withFocus({
						style: { ...textarea, minHeight: "60px" },
						value: text,
						disabled: busy,
						"aria-label": "编辑记忆条目",
						onChange: (event) => setText(event.target.value),
						onKeyDown: (event) => {
							if (event.key === "Escape") {
								event.preventDefault();
								setText(entry);
								setSaveState("");
								setEditing(false);
								return;
							}
							if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
								event.preventDefault();
								if (text !== entry) void handleSave();
							}
						},
					}),
				),
				h(
					"div",
					{ style: { ...row, justifyContent: "flex-end" } },
					feedback ? h("span", { style: { marginRight: "auto", display: "inline-flex" } }, feedback) : null,
					h(
						"button",
						withFocus({
							style: ghostBtn,
							disabled: busy,
							onClick: () => {
								setText(entry);
								setSaveState("");
								setEditing(false);
							},
						}),
						"取消",
					),
					h(
						"button",
						withFocus({
							style: { ...smallBtn, opacity: dirty ? 1 : 0.5 },
							disabled: busy || !dirty,
							"aria-label": "保存这条记忆",
							onClick: () => void handleSave(),
						}),
						"保存",
					),
					h(
						"button",
						withFocus({
							style: confirming ? dangerBtn : ghostBtn,
							disabled: busy,
							"aria-label": "删除这条记忆",
							onClick: () => void handleRemove(),
						}),
						confirming ? "确认删除" : "删除",
					),
				),
			);
		}
		function AddEntry({ target, onAdd }) {
			const [text, setText] = react.useState("");
			const [addBusy, setAddBusy] = react.useState(false);
			const [addError, setAddError] = react.useState("");
			const canAdd = text.trim().length > 0 && !addBusy;
			const submit = async () => {
				if (!canAdd) return;
				setAddBusy(true);
				setAddError("");
				try {
					const result = await onAdd(text);
					if (result && result.ok === false) setAddError(result.error || "添加失败");
					else setText("");
				} catch (err) {
					setAddError(err && err.message ? err.message : String(err));
				} finally {
					setAddBusy(false);
				}
			};
			return h(
				"div",
				{ style: { ...row, alignItems: "flex-start", gap: T.space[4], marginTop: T.space[4], flexWrap: "wrap" } },
				h(
					"textarea",
					withFocus({
						style: { ...textarea, flex: "1 1 auto", width: "auto", minWidth: 0, minHeight: "36px" },
						placeholder: "添加一条…",
						value: text,
						disabled: addBusy,
						"aria-label": "新增记忆条目",
						onChange: (event) => setText(event.target.value),
						onKeyDown: (event) => {
							if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
								event.preventDefault();
								void submit();
							}
						},
					}),
				),
				h(
					"button",
					withFocus({
						style: { ...primaryBtn, minWidth: "56px", opacity: canAdd ? 1 : 0.5 },
						disabled: !canAdd,
						"aria-label": "添加记忆条目",
						onClick: () => void submit(),
					}),
					addBusy ? "添加中…" : "添加",
				),
				addError ? h("div", { style: { color: T.color.danger, fontSize: T.font.sm, width: "100%" } }, addError) : null,
			);
		}
		function TrackTabs({ tracks, active, onSelect }) {
			const tabRefs = react.useRef({});
			const move = (event, index) => {
				let next = index;
				if (event.key === "ArrowRight") next = (index + 1) % tracks.length;
				else if (event.key === "ArrowLeft") next = (index - 1 + tracks.length) % tracks.length;
				else if (event.key === "Home") next = 0;
				else if (event.key === "End") next = tracks.length - 1;
				else return;
				event.preventDefault();
				const track = tracks[next];
				if (!track) return;
				onSelect(track.key);
				const node = tabRefs.current[track.key];
				if (node && typeof node.focus === "function") node.focus();
			};
			return h(
				"div",
				{ style: tabBar, role: "tablist", "aria-label": "记忆轨道" },
				tracks.map((track, index) =>
					h(
						"button",
						withFocus({
							key: track.key,
							type: "button",
							role: "tab",
							"aria-selected": track.key === active,
							tabIndex: track.key === active ? 0 : -1,
							style: track.key === active ? tabActive : tabBase,
							ref: (node) => {
								tabRefs.current[track.key] = node;
							},
							onClick: () => onSelect(track.key),
							onKeyDown: (event) => move(event, index),
						}),
						track.label,
						track.count ? h("span", { style: tabCount }, String(track.count)) : null,
					),
				),
			);
		}

		function TrackSection({ target, title: heading, hint, view, busyKey, savedKey, onWrite, onAdd, onEditingChange, onDeleted }) {
			const entries = Array.isArray(view.entries) ? view.entries : [];
			const seen = new Map();
			const keyed = entries.map((entry, index) => {
				const base = `${target}:${entry}`;
				const occurrence = seen.get(base) || 0;
				seen.set(base, occurrence + 1);
				return { entry, index, key: occurrence === 0 ? base : `${base}:${occurrence}` };
			});
			return h(
				"section",
				{ style: { marginBottom: T.space[3] } },
				h(
					"div",
					{ style: { ...row, justifyContent: "space-between", marginBottom: T.space[2] } },
					h("span", { style: { fontSize: T.font.sm, fontWeight: 600, opacity: 0.8 } }, heading),
					h("span", { style: muted, title: view.usage }, `${entries.length} 条 · ${view.percent}%`),
				),
				h("div", { style: { ...row, marginBottom: T.space[5] } }, h("div", { style: thinTrack }, h("div", { style: barFill(view.percent) }))),
				entries.length === 0
					? h("div", { style: { ...muted, padding: `${T.space[3]} ${T.space[4]}`, lineHeight: T.line.loose } }, hint || "")
					: keyed.map(({ entry, index, key }) =>
							h(EntryCard, {
								key,
								target,
								entry,
								busy: busyKey === key,
								saved: savedKey === key,
								onSave: (oldText, content) => onWrite({ target, action: "patch", old_text: oldText, content }, key),
								onRemove: async (oldText) => {
									const result = await onWrite({ target, action: "remove", old_text: oldText }, key);
									if (result && result.ok) onDeleted?.({ target, text: oldText, position: index });
									return result;
								},
								onEditingChange,
							}),
						),
				h(AddEntry, {
					target,
					onAdd: (content) => onAdd({ target, action: "add", content }),
				}),
			);
		}
		function PendingSection({ items, busy, onDecide, error, notice }) {
			if (!Array.isArray(items) || items.length === 0) return null;
			return h(
				"section",
				{ style: flatSection },
				h(
					"div",
					{ style: { ...row, justifyContent: "space-between", marginBottom: T.space[4] } },
					h("strong", { style: { fontSize: T.font.lg } }, "待确认的后台改动"),
					h("span", { style: muted }, `${items.length} 条`),
				),
				h(
					"div",
					{ style: muted, marginBottom: T.space[5] },
					"后台 review 想删除或改写条目，需在这里批准；条目自提案后已变则会标记「已过期」，只能丢弃。",
				),
				items.map((item) =>
					h(
						"div",
						{ key: item.id, style: itemBox },
						h(
							"div",
							{ style: { ...row, justifyContent: "space-between", marginBottom: T.space[2] } },
							h(
								"div",
								{ style: row },
								h("span", { style: { fontSize: T.font.md } }, `${item.action} · ${item.target}`),
								item.stale
									? h(
											"span",
											{ style: { ...muted, color: T.color.danger }, title: item.stale_reason || "" },
											"已过期",
										)
									: null,
							),
							h(
								"div",
								{ style: row },
								item.stale
									? null
									: h(
											"button",
											withFocus({
												style: primaryBtn,
												disabled: busy,
												onClick: () => onDecide({ id: item.id, decision: "apply" }),
											}),
											"批准",
										),
								h(
									"button",
									withFocus({
										style: item.stale ? primaryBtn : smallBtn,
										disabled: busy,
										onClick: () => onDecide({ id: item.id, decision: "discard" }),
									}),
									item.stale ? "丢弃这条过期提案" : "丢弃",
								),
							),
						),
						item.stale
							? h(
									"div",
									{ style: { ...muted, color: T.color.danger, marginTop: T.space[2] } },
									`${item.stale_reason || "条目自提案后已变"}；这条提案无法再应用，点「丢弃」清理即可。`,
								)
							: null,
						item.old_text || item.content
							? h("div", { style: { marginTop: T.space[2] } }, diffRows(item.old_text, item.content, `${item.id}:diff`))
							: null,
						item.operation_count !== undefined
							? h(
									"div",
									{ style: { ...muted, marginTop: T.space[2], maxHeight: "160px", overflow: "auto" } },
									h("div", null, `批量操作 × ${item.operation_count}`),
									(Array.isArray(item.operations) ? item.operations : []).map((op, opIndex) =>
										h(
											"div",
											{ key: `${item.id}:op:${opIndex}`, style: { paddingLeft: T.space[5], marginTop: T.space[1] } },
											h("div", { style: { ...muted, opacity: 0.8 } }, `· ${op.action}`),
											diffRows(op.old_text, op.content, `${item.id}:op:${opIndex}`),
										),
									),
									Array.isArray(item.operations) && item.operation_count > item.operations.length
										? h("div", null, `还有 ${item.operation_count - item.operations.length} 项`)
										: null,
								)
							: null,
					),
				),
				error
					? h("div", { style: { color: T.color.danger, fontSize: T.font.sm, marginTop: T.space[3] } }, error)
					: null,
				!error && notice ? h("div", { style: { ...muted, fontSize: T.font.sm, marginTop: T.space[3] } }, notice) : null,
			);
		}

		function SuggestionsSection({ items, busy, onDecide }) {
			if (!Array.isArray(items) || items.length === 0) return null;
			return h(
				"section",
				{ style: flatSection },
				h(
					"div",
					{ style: { ...row, justifyContent: "space-between", marginBottom: T.space[4] } },
					h("strong", { style: { fontSize: T.font.lg } }, "建议"),
					h("span", { style: muted }, `${items.length} 条`),
				),
				h(
					"div",
					{ style: { ...muted, marginBottom: T.space[5] } },
					"回顾时以 suggest 模式提交的记忆建议；采纳后才会真正写入对应记忆库。",
				),
				items.map((item) =>
					h(
						"div",
						{ key: item.id, style: itemBox },
						h(
							"div",
							{ style: { ...row, justifyContent: "space-between", marginBottom: T.space[2] } },
							h("span", { style: { fontSize: T.font.md } }, `${item.target} · ${formatClock(item.created_at)}`),
							h(
								"div",
								{ style: row },
								h(
									"button",
									withFocus({
										style: primaryBtn,
										disabled: busy,
										onClick: () => onDecide({ id: item.id, decision: "accept" }),
									}),
									"采纳",
								),
								h(
									"button",
									withFocus({ style: smallBtn, disabled: busy, onClick: () => onDecide({ id: item.id, decision: "discard" }) }),
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
				{ style: flatSection },
				h(
					"div",
					{ style: { ...row, justifyContent: "space-between", marginBottom: T.space[4] } },
					h("strong", { style: { fontSize: T.font.lg } }, "最近 review"),
					h("span", { style: muted }, `${list.length} 条`),
				),
				list.length === 0
					? h("div", { style: muted }, "还没有后台 review 记录")
					: list.map((item) =>
							h(
								"div",
								{
									key: item.id,
									style: { ...row, justifyContent: "space-between", gap: T.space[6], padding: `${T.space[1]} 0` },
								},
								h("span", { style: { fontSize: T.font.md, wordBreak: "break-word" } }, item.summary || ""),
								h("span", { style: { ...muted, whiteSpace: "nowrap" } }, formatClock(item.finished_at)),
							),
						),
			);
		}

		function WritesSection({ items, busy, onWrite }) {
			const list = Array.isArray(items) ? items : [];
			return h(
				"section",
				{ style: flatSection },
				h(
					"div",
					{ style: { ...row, justifyContent: "space-between", marginBottom: T.space[4] } },
					h("strong", { style: { fontSize: T.font.lg } }, "最近变更"),
					h("span", { style: muted }, `${list.length} 条`),
				),
				list.length === 0
					? h("div", { style: muted }, "还没有写入记录")
					: list.map((item, index) => {
							const undo = undoBody(item);
							return h(
								"div",
								{ key: `${item.ts}:${index}`, style: itemBox },
								h(
									"div",
									{ style: { ...row, justifyContent: "space-between", marginBottom: T.space[1] } },
									h(
										"span",
										{ style: { fontSize: T.font.md } },
										`${formatClock(item.ts)} · ${item.action} · ${item.target}`,
									),
									item.batch
										? h("span", { style: muted }, "批量操作不可撤销")
										: undo
											? h("button", withFocus({ style: smallBtn, disabled: busy, onClick: () => onWrite(undo) }), "撤销")
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
			marginTop: T.space[4],
			padding: `${T.space[4]} ${T.space[5]}`,
			fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace",
			fontSize: T.font.sm,
			lineHeight: T.line.tight,
			borderRadius: T.radius.md,
			border: `1px solid ${T.border.base}`,
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
				{ style: flatSection },
				h(
					"div",
					{ style: { ...row, justifyContent: "space-between", marginBottom: T.space[3] } },
					h("strong", null, "SYNC · 同步 / 迁移"),
					h(
						"div",
						{ style: row },
						h(
							"button",
							withFocus({ style: smallBtn, disabled: busy || localBusy, onClick: () => void doExport() }),
							"导出 JSON",
						),
						h(
							"button",
							withFocus({
								style: smallBtn,
								disabled: busy || localBusy || !text.trim(),
								onClick: () => void doMerge(),
							}),
							"合并导入",
						),
					),
				),
				h(
					"div",
					{ style: muted },
					"安全合并：远端新增才写入；远端删除只报告、不执行；内容重复会在下面「疑似重复」里提示，手动处理。",
				),
				h("textarea", withFocus({
					style: syncTextArea,
					value: text,
					placeholder: "粘贴另一台设备「导出 JSON」得到的内容…",
					"aria-label": "同步数据 JSON",
					onChange: (event) => setText(event.target.value),
					spellCheck: false,
				})),
				message ? h("div", { style: { ...muted, color: T.color.success, marginTop: T.space[3] } }, message) : null,
				failure ? h("div", { style: { ...muted, color: T.color.danger, marginTop: T.space[3] } }, failure) : null,
			);
		}

		// 0.9.0：疑似重复/冲突只提示，不自动合并。
		function ConflictsSection({ items }) {
			if (!Array.isArray(items) || items.length === 0) return null;
			return h(
				"div",
				{ style: flatSection },
				h("strong", null, "疑似重复 · 需要人工合并"),
				h(
					"div",
					{ style: { ...muted, marginTop: T.space[2] } },
					"这些条目内容高度相似（相似度 ≥ 0.8）；工具与同步都不会自动合并，请编辑其中一条。",
				),
				items.map((item, index) =>
					h(
						"div",
						{
							key: `${item.target}-${index}`,
							style: { marginTop: T.space[5], paddingTop: index === 0 ? T.space[0] : T.space[5], borderTop: index === 0 ? "none" : `1px solid ${T.border.subtle}` },
						},
						h(
							"div",
							{ style: muted },
							`${TARGET_LABELS[item.target] || item.target} · 相似度 ${Math.round((item.similarity || 0) * 100)}%`,
						),
						h("div", { style: { fontSize: T.font.sm, marginTop: T.space[2], opacity: 0.85 } }, `A: ${clipText(item.a, 160)}`),
						h("div", { style: { fontSize: T.font.sm, marginTop: T.space[1], opacity: 0.85 } }, `B: ${clipText(item.b, 160)}`),
					),
				),
			);
		}

		function DiagnosticsDrawer({ open, section, onSection, onClose, counts, children }) {
			const closeRef = react.useRef(null);

			react.useEffect(() => {
				if (!open) return undefined;
				const node = closeRef.current;
				if (node && typeof node.focus === "function") node.focus();
				return undefined;
			}, [open]);

			react.useEffect(() => {
				if (!open) return undefined;
				if (typeof document === "undefined" || !document.body || !document.body.style) return undefined;
				const previous = document.body.style.overflow;
				document.body.style.overflow = "hidden";
				return () => {
					document.body.style.overflow = previous;
				};
			}, [open]);

			if (!open) return null;

			const tabs = [
				{ key: "history", label: "历史", count: (counts && counts.history) || 0 },
				{ key: "conflicts", label: "冲突", count: (counts && counts.conflicts) || 0 },
				{ key: "sync", label: "同步", count: 0 },
			];

			return h(
				"div",
				{ "data-dsh-memory-notes-drawer": "" },
				h("div", { style: drawerMask, "aria-hidden": "true", onClick: onClose }),
				h(
					"div",
					{
						role: "dialog",
						"aria-modal": "false",
						"aria-label": "诊断面板",
						style: drawerPanel,
						tabIndex: -1,
						onKeyDown: (event) => {
							if (event && event.key === "Escape") {
								if (typeof event.preventDefault === "function") event.preventDefault();
								onClose();
							}
						},
					},
					h(
						"div",
						{ style: drawerHeader },
						h("strong", { style: { fontSize: T.font.lg } }, "诊断"),
						h(
							"button",
							withFocus({
								ref: closeRef,
								type: "button",
								style: ghostBtn,
								"aria-label": "关闭诊断面板",
								onClick: onClose,
							}),
							"关闭",
						),
					),
					h(
						"div",
						{ style: drawerNav, role: "tablist", "aria-label": "诊断分类" },
						tabs.map((tab) =>
							h(
								"button",
								withFocus({
									key: tab.key,
									type: "button",
									role: "tab",
									"aria-selected": section === tab.key,
									style: section === tab.key ? tabActive : tabBase,
									onClick: () => onSection(tab.key),
								}),
								tab.label,
								tab.count ? h("span", { style: tabCount }, String(tab.count)) : null,
							),
						),
					),
					h("div", { style: { marginTop: T.space[5] } }, children),
				),
			);
		}

		function PanelPage() {
			const [state, setState] = react.useState(null);
			const [error, setError] = react.useState("");
			const [busy, setBusy] = react.useState(false);
			const [busyKey, setBusyKey] = react.useState("");
			const [notice, setNotice] = react.useState("");
			const [activeTrack, setActiveTrack] = react.useState(null);
			const [editingCount, setEditingCount] = react.useState(0);
			const editingCountRef = react.useRef(0);
			const [savedKey, setSavedKey] = react.useState("");
			const [query, setQuery] = react.useState("");
			const [searchState, setSearchState] = react.useState({ status: "", results: [], error: "" });
			const [undoEntry, setUndoEntry] = react.useState(null);
			const [undoState, setUndoState] = react.useState("");
			const [drawerOpen, setDrawerOpen] = react.useState(false);
			const [drawerSection, setDrawerSection] = react.useState("history");
			const undoTimerRef = react.useRef(null);
			const undoDoneTimerRef = react.useRef(null);

			const onEditingChange = react.useCallback((delta) => {
				const next = Math.max(0, editingCountRef.current + delta);
				editingCountRef.current = next;
				setEditingCount(next);
			}, []);

			react.useEffect(() => {
				if (!savedKey) return undefined;
				const timer = setTimeout(() => setSavedKey(""), 2000);
				return () => clearTimeout(timer);
			}, [savedKey]);

			react.useEffect(
				() => () => {
					if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
					if (undoDoneTimerRef.current) clearTimeout(undoDoneTimerRef.current);
				},
				[],
			);

			const clearSearch = react.useCallback(() => {
				setQuery("");
				setSearchState({ status: "", results: [], error: "" });
			}, []);

			const runSearch = react.useCallback(async () => {
				const text = query.trim();
				if (!text) return;
				setSearchState({ status: "loading", results: [], error: "" });
				try {
					const data = await fetchJson(`${API.search}?q=${encodeURIComponent(text)}&limit=20`);
					const results = Array.isArray(data && data.results) ? data.results : [];
					setSearchState({ status: "done", results, error: "" });
				} catch (err) {
					setSearchState({
						status: "error",
						results: [],
						error: err && err.message ? err.message : String(err),
					});
				}
			}, [query]);

			const handleDeleted = react.useCallback(({ target, text, position }) => {
				if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
				if (undoDoneTimerRef.current) clearTimeout(undoDoneTimerRef.current);
				setUndoEntry({ target, text, position });
				setUndoState("");
				undoTimerRef.current = setTimeout(() => {
					setUndoEntry(null);
					setUndoState("");
				}, 5000);
			}, []);

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
					if (editingCountRef.current > 0) return;
					void refresh(true);
				}, 10000);
				const onFocus = () => {
					if (editingCountRef.current > 0) return;
					void refresh(true);
				};
				const onVisibilityChange = () => {
					if (editingCountRef.current > 0) return;
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
				async (promise, key = "") => {
					if (key) setBusyKey(key);
					else setBusy(true);
					if (!key) setNotice("");
					try {
						const data = await promise;
						if (data && data.ok === false) {
							const message = data.error || "写入失败";
							if (!key) setError(message);
							return { ok: false, error: message };
						}
						if (data && data.state) setState(data.state);
						else await refresh();
						if (!key) {
							setError("");
							setNotice("已保存");
						}
						return { ok: true };
					} catch (err) {
						const message = err && err.message ? err.message : String(err);
						if (!key) setError(message);
						return { ok: false, error: message };
					} finally {
						if (key) setBusyKey("");
						else setBusy(false);
					}
				},
				[refresh],
			);

			const onWrite = react.useCallback(
				async (body, key = "") => {
					const result = await applyResult(fetchJson(API.write, body), key);
					if (key && result && result.ok && body && body.action === "patch") {
						setSavedKey(`${body.target}:${body.content}`);
					}
					return result;
				},
				[applyResult],
			);

			const handleUndo = react.useCallback(async () => {
				if (!undoEntry) return;
				setUndoState("undoing");
				const result = await onWrite({
					target: undoEntry.target,
					action: "restore",
					content: undoEntry.text,
					position: undoEntry.position,
				});
				if (!result || result.ok === false) {
					setUndoState((result && result.error) || "撤销失败");
					return;
				}
				if (undoTimerRef.current) clearTimeout(undoTimerRef.current);
				if (undoDoneTimerRef.current) clearTimeout(undoDoneTimerRef.current);
				setUndoEntry(null);
				setUndoState("done");
				undoDoneTimerRef.current = setTimeout(() => setUndoState(""), 2000);
			}, [undoEntry, onWrite]);

			const onAddEntry = react.useCallback(
				async (body) => {
					try {
						const data = await fetchJson(API.write, body);
						if (data && data.ok === false) return { ok: false, error: data.error || "写入失败" };
						if (data && data.state) setState(data.state);
						else await refresh();
						return { ok: true };
					} catch (err) {
						return { ok: false, error: err && err.message ? err.message : String(err) };
					}
				},
				[refresh],
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
					{ style: { padding: `${T.space[10]} ${T.space[12]}`, opacity: 0.7 } },
					error ? `加载失败：${error}` : "加载记忆…",
				);
			}

			const tracks = TRACK_META.filter((meta) => state.targets && state.targets[meta.key]).map((meta) => {
				const view = state.targets[meta.key];
				return { key: meta.key, label: meta.label, count: view.entries.length, percent: view.percent };
			});
			const activeKey = tracks.some((track) => track.key === activeTrack) ? activeTrack : tracks[0] && tracks[0].key;
			const activeMeta = TRACK_META.find((meta) => meta.key === activeKey) || TRACK_META[0];
			const activeView = activeKey && state.targets ? state.targets[activeKey] : null;
			const pendingCount = Array.isArray(state.pending) ? state.pending.length : 0;
			const reviewCount = Array.isArray(state.reviews) ? state.reviews.length : 0;
			const writeCount = Array.isArray(state.writes) ? state.writes.length : 0;
			const conflictCount = Array.isArray(state.conflicts) ? state.conflicts.length : 0;
			const searchResults = searchState && Array.isArray(searchState.results) ? searchState.results : [];
			const totalCount = tracks.reduce((sum, track) => sum + track.count, 0);
			const injectionKeys = ["memory", "user", "key"].filter((key) => state.targets && state.targets[key]);
			const injectionDetail = ["memory", "user", "key"]
				.map((key) => {
					const view = state.targets && state.targets[key];
					return `${TARGET_LABELS[key]} ${Math.round((view && view.percent) || 0)}%`;
				})
				.join(" · ");
			const injectionMax = injectionKeys.reduce(
				(max, key) => Math.max(max, (state.targets[key] && state.targets[key].percent) || 0),
				0,
			);
			const diagnosticCount = reviewCount + writeCount + conflictCount;
			const openDrawer = () => {
				const next = reviewCount + writeCount > 0 ? "history" : conflictCount > 0 ? "conflicts" : "sync";
				setDrawerSection(next);
				setDrawerOpen(true);
			};
			const drawerBody =
				drawerSection === "conflicts"
					? conflictCount
						? h(ConflictsSection, { items: state.conflicts })
						: h("p", { style: drawerEmpty }, "暂无冲突。")
					: drawerSection === "sync"
						? h(SyncSection, { busy, onMerged: refresh })
						: reviewCount || writeCount
							? h(
									"div",
									null,
									reviewCount ? h(ReviewsSection, { items: state.reviews }) : null,
									writeCount ? h(WritesSection, { items: state.writes, busy, onWrite }) : null,
								)
							: h("p", { style: drawerEmpty }, "暂无记录。");

			return h(
				"div",
				{ "data-dsh-memory-notes-view": "", style: panel },
				h(
					"div",
					{ style: { ...row, justifyContent: "space-between", flexWrap: "wrap", gap: T.space[5], marginBottom: T.space[1] } },
					h(
						"div",
						{ style: { ...row, flexWrap: "wrap" } },
						h("span", { style: title }, "记忆"),
						h(
							"input",
							withFocus({
								type: "text",
								style: searchInput,
								placeholder: "搜索五轨记忆…",
								"aria-label": "搜索记忆",
								value: query,
								onChange: (event) => setQuery(event.target.value),
								onKeyDown: (event) => {
									if (event.key === "Enter") {
										event.preventDefault();
										void runSearch();
									}
								},
							}),
						),
						h(
							"button",
							withFocus({
								style: primaryBtn,
								disabled: !query.trim() || searchState?.status === "loading",
								"aria-label": "搜索记忆",
								onClick: () => void runSearch(),
							}),
							searchState?.status === "loading" ? "搜索中…" : "搜索",
						),
					),
					h(
						"div",
						{ style: statGroup },
						totalCount > 0 ? h("span", { style: statText }, `共 ${totalCount} 条`) : null,
						injectionKeys.length > 0
							? h(
									"span",
									{
										role: "img",
										title: injectionDetail,
										"aria-label": injectionDetail,
										style: budgetRing(injectionMax),
									},
									h("span", { style: budgetRingHole }),
								)
							: null,
						pendingCount > 0 ? h("span", { style: { ...statText, color: T.color.danger } }, `待确认 ${pendingCount}`) : null,
						h(
							"button",
							withFocus({
								style: ghostBtn,
								"aria-label": "打开诊断面板",
								title: "回顾与变更历史 · 冲突 · 同步",
								onClick: openDrawer,
							}),
							"历史 / 同步",
							diagnosticCount > 0 ? h("span", { style: statBadge }, String(diagnosticCount)) : null,
						),
						notice && !error ? h("span", { style: statText }, notice) : null,
						h(
							"button",
							withFocus({
								style: ghostBtn,
								disabled: busy,
								"aria-label": "刷新记忆面板",
								onClick: () => {
									void refresh();
								},
							}),
							busy ? "刷新中…" : "刷新",
						),
					),
				),
				h("div", { style: note }, "写入立即生效；本会话下一轮可见。"),
				error ? h("div", { style: { ...muted, color: T.color.danger, marginBottom: T.space[5] } }, error) : null,
				h(TrackTabs, { tracks, active: activeKey, onSelect: setActiveTrack }),
				searchState?.status
					? h(
							"section",
							{
								style: {
									...flatSection,
									borderBottom: `1px solid ${T.border.base}`,
									paddingBottom: T.space[5],
									marginBottom: T.space[7],
								},
							},
							h(
								"div",
								{ style: { ...muted, marginBottom: T.space[3] } },
								searchState.status === "loading" ? "搜索中…" : `搜索结果 · ${searchResults.length} 条`,
							),
							searchState.status === "loading"
								? null
								: searchState.status === "error"
									? h(
											"div",
											{ style: { color: T.color.danger, fontSize: T.font.sm, wordBreak: "break-word" } },
											searchState.error || "搜索失败",
										)
									: searchResults.length === 0
										? h("div", { style: muted }, "没有匹配的条目。")
										: searchResults.map((item, index) =>
												h(
													"button",
													withFocus({
														key: `${item.target}:${index}`,
														type: "button",
														style: searchResultRow,
														onClick: () => {
															setActiveTrack(item.target);
															clearSearch();
														},
													}),
													`${trackLabel(item.target)} · ${clipRaw(item.entry, 160)}`,
												),
											),
						)
					: null,
				activeView
					? h(TrackSection, {
							target: activeKey,
							title: activeMeta.title,
							hint: activeMeta.hint,
							view: activeView,
							busyKey,
							savedKey,
							onWrite,
							onAdd: onAddEntry,
							onEditingChange,
							onDeleted: handleDeleted,
						})
					: null,
				h(PendingSection, { items: state.pending, busy, onDecide, error: "", notice: "" }),
				h(SuggestionsSection, { items: state.suggestions, busy, onDecide: onSuggest }),
				h(DiagnosticsDrawer, {
					open: drawerOpen,
					section: drawerSection,
					onSection: setDrawerSection,
					onClose: () => setDrawerOpen(false),
					counts: { history: reviewCount + writeCount, conflicts: conflictCount },
					children: drawerBody,
				}),
				undoEntry || undoState === "done"
					? h(
							"div",
							{ style: toastBox, role: "status", "aria-live": "polite" },
							h("span", null, undoState === "done" ? "已撤销" : "已删除 · "),
							undoEntry
								? h(
										"button",
										withFocus({
											style: toastBtn,
											disabled: undoState === "undoing",
											onClick: () => void handleUndo(),
										}),
										undoState === "undoing" ? "撤销中…" : "撤销",
									)
								: null,
							undoEntry && undoState && undoState !== "undoing" && undoState !== "done"
								? h("span", { style: { color: T.color.dangerOnDark, wordBreak: "break-word" } }, undoState)
								: null,
						)
					: null,
			);
		}


		/* ----------------------------- tool call rows ---------------------------- */

		// 每次 memory / skill_manage 调用在会话流里显示一行提示（🧠 已记住 · MEMORY 82%），
		// 对应 Hermes 的 "💾 Memory updated"；点开看完整内容与结果 JSON。

		const toolRowStyle = {
			display: "flex",
			alignItems: "flex-start",
			gap: T.space[3],
			padding: `${T.space[1]} ${T.space[1]}`,
			borderRadius: T.radius.sm,
			cursor: "pointer",
			fontSize: T.font.sm,
			lineHeight: T.line.tight,
			userSelect: "none",
		};
		const toolRowBody = { display: "flex", flexDirection: "column", gap: T.space[1], minWidth: 0, flex: "1 1 auto" };
		const toolRowTail = { marginLeft: "auto", opacity: 0.5, fontSize: T.font.xs, whiteSpace: "nowrap" };
		const toolRowMeta = { opacity: 0.62, fontSize: T.font.xs };
		const toolRowDetails = {
			margin: `0 0 ${T.space[3]} ${T.space[12]}`,
			display: "flex",
			flexDirection: "column",
			gap: T.space[2],
			fontSize: T.font.sm,
			lineHeight: T.line.base,
			opacity: 0.88,
			whiteSpace: "pre-wrap",
			wordBreak: "break-word",
		};
		const errorText = { color: T.color.danger };

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
						withFocus({
							style: toolRowStyle,
							role: "button",
							tabIndex: 0,
							title: open ? "收起" : "查看详情",
							"aria-expanded": open,
							onClick: () => setOpen(!open),
							onKeyDown: (event) => {
								if (event.key === "Enter" || event.key === " ") {
									event.preventDefault();
									setOpen(!open);
								}
							},
						}),
						h("span", { style: { fontSize: T.font.md, lineHeight: T.line.pixel } }, view.icon),
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
					h("span", { key: "pending", style: { color: T.color.danger, fontWeight: 600 } }, `· 待确认 ${status.pending}`),
				);
			}
			if (commandMode) {
				children.push(h("span", { key: "hint" }, "· 命令：打开面板 / 清空输入"));
			}
			children.push(
				h("span", { key: "spacer", style: { flex: "1 1 auto" } }),
				h("button", withFocus({ key: "open", style: smallBtn, onClick: openPanel }), "打开面板"),
			);
			if (commandMode && canClear) {
				children.push(h("button", withFocus({ key: "clear", style: smallBtn, onClick: clearInput }), "清空输入"));
			}
			return h(
				"div",
				{
					"data-dsh-memory-notes-dock": "",
					style: { display: "flex", alignItems: "center", gap: T.space[4], fontSize: T.font.sm, color: T.color.textTertiary, padding: `${T.space[1]} ${T.space[1]}` },
				},
				children,
			);
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
					slots.inject("conversation.composer.dock", () => {
						try {
							return slots.register(
								{
									name: "conversation.composer.dock",
									id: "memory-notes-dock",
									order: 40,
									label: () => "记忆",
								},
								MemoryDock,
							);
						} catch (err) {
							console.warn("[dsh-memory-notes] composer dock registration failed:", err);
							return () => {};
						}
					}),
				);
			} catch {
				/* 宿主没有该 slot 时跳过 */
			}
			/* 注意：sidebar.toggle.badge 是 single slot 且被宿主占用（replaceRisk shadows-shipped-ui），
			   注册会抛 "single slot already has a registration"，曾经把 apply 整块打断、dock 都不出现。
			   待确认数量已经显示在 dock 上，这里不再注册徽标。 */
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
