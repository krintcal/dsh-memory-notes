import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const CLIENT_ENTRY = pathToFileURL(path.join(import.meta.dirname, "..", "client.js")).href;

function fakeReact() {
	function createElement(type, props, ...children) {
		const flat = [];
		for (const child of children) {
			if (Array.isArray(child)) flat.push(...child);
			else if (child !== null && child !== undefined && child !== false) flat.push(child);
		}
		return { type, props: props ?? {}, children: flat };
	}
	return {
		createElement,
		useState: (initial) => [initial, () => {}],
		useEffect: (fn) => {
			void fn;
		},
		useMemo: (fn) => fn(),
		useCallback: (fn) => fn,
		useRef: (value) => ({ current: value }),
	};
}

function requireStub(react) {
	return (name) => {
		if (name === "react") return react;
		if (name === "react/jsx-runtime") return { jsx: react.createElement, jsxs: react.createElement, Fragment: "Fragment" };
		throw new Error(`unexpected require: ${name}`);
	};
}

let cachedBundle = null;

async function loadBundle() {
	if (cachedBundle) return cachedBundle;
	const loaded = [];
	globalThis.window = { __ModuleLoader__: { load: (bundle) => loaded.push(bundle) } };
	await import(CLIENT_ENTRY);
	assert.equal(loaded.length, 1, "client bundle must call __ModuleLoader__.load once");
	cachedBundle = loaded[0];
	return cachedBundle;
}

function fakeCtx(registrations, cleanups, extra = {}) {
	const ctx = {
		slots: {
			inject: (_name, fn) => fn(),
			register: (definition, component) => {
				registrations.push({ definition, component });
				return () => {};
			},
		},
		effect: (fn) => {
			cleanups.push(fn());
		},
		get: () => undefined,
		...extra,
	};
	return ctx;
}



function textOf(node) {
	if (node === null || node === undefined || node === false) return "";
	if (typeof node === "string" || typeof node === "number") return String(node);
	if (Array.isArray(node)) return node.map(textOf).join(" ");
	if (typeof node === "object" && Array.isArray(node.children)) return textOf(node.children);
	return "";
}

test("client bundle registers panel and per-tool rows, and cleans them up", async () => {
	const bundle = await loadBundle();
	assert.equal(bundle.id, "dsh-memory-notes");

	const exportsObject = bundle.factory(requireStub(fakeReact()));
	assert.equal(exportsObject.inject[0], "slots");
	assert.ok(exportsObject.inject.includes("layout"), "client must inject the layout service to open the panel");

	const registrations = [];
	const cleanups = [];
	exportsObject.apply(fakeCtx(registrations, cleanups));

	const panel = registrations.find((entry) => entry.definition.name === "sidebar.panellist");
	assert.ok(panel, "sidebar.panellist must be registered");
	assert.equal(panel.definition.id, "memory-notes");

	const main = registrations.find((entry) => entry.definition.name === "main");
	assert.ok(main, "main panel must be registered");
	assert.equal(main.definition.key, "memory-notes");

	const rows = registrations.filter((entry) => entry.definition.name === "tool.call.toolview");
	assert.deepEqual(
		rows.map((entry) => entry.definition.key).sort(),
		["memory", "skill_manage"],
	);

	const dock = registrations.find((entry) => entry.definition.name === "conversation.composer.dock");
	assert.ok(dock, "conversation.composer.dock must be registered");
	assert.equal(dock.definition.id, "memory-notes-dock");

	assert.equal(
		registrations.find((entry) => entry.definition.name === "sidebar.toggle.badge"),
		undefined,
		"sidebar.toggle.badge is a single host-owned slot and must not be registered",
	);

	assert.equal(cleanups.length, 1);
	assert.doesNotThrow(() => cleanups[0]());
});

test("输入框 dock 在命令模式下提示命令，缺省时只显示入口", async () => {
	const bundle = await loadBundle();
	const exportsObject = bundle.factory(requireStub(fakeReact()));
	const registrations = [];
	exportsObject.apply(fakeCtx(registrations, []));
	const Dock = registrations.find((entry) => entry.definition.name === "conversation.composer.dock").component;

	const commandText = textOf(Dock({ useInput: (selector) => selector({ text: "/memory pending" }) }));
	assert.match(commandText, /记忆/);
	assert.match(commandText, /命令/);

	const plainText = textOf(Dock({}));
	assert.match(plainText, /记忆/);
});

test("dock 的「打开面板」调用 layout.selectPanel，且懒解析晚到的 layout 服务", async () => {
	const bundle = await loadBundle();
	const exportsObject = bundle.factory(requireStub(fakeReact()));
	const calls = [];
	const registrations = [];
	const cleanups = [];
	exportsObject.apply(
		fakeCtx(registrations, cleanups, { layout: { selectPanel: (id) => calls.push(id) } }),
	);
	const Dock = registrations.find((entry) => entry.definition.name === "conversation.composer.dock").component;

	const row = Dock({});
	const button = row.children.find((child) => child.type === "button" && textOf(child) === "打开面板");
	assert.ok(button, "dock must render the 打开面板 button");
	button.props.onClick();
	assert.deepEqual(calls, ["memory-notes"]);
	assert.doesNotThrow(() => cleanups[0]());
});

test("memory tool row renders add, patch, running and failure states", async () => {
	const bundle = await loadBundle();
	const exportsObject = bundle.factory(requireStub(fakeReact()));
	const registrations = [];
	exportsObject.apply(fakeCtx(registrations, []));
	const MemoryRow = registrations.find(
		(entry) => entry.definition.name === "tool.call.toolview" && entry.definition.key === "memory",
	).component;

	const addRow = MemoryRow({
		block: {
			kind: "ok",
			args: { action: "add", target: "memory", content: "pnpm 只在 sync 后生效" },
			content: [{ type: "text", text: JSON.stringify({ success: true, usage: "82% — 1,800/2,200 chars" }) }],
			isError: false,
		},
	});
	const addText = textOf(addRow);
	assert.match(addText, /已记住/);
	assert.match(addText, /MEMORY/);
	assert.match(addText, /82%/);

	const patchRow = MemoryRow({
		block: {
			kind: "ok",
			args: { action: "patch", target: "memory", old_text: "old fact", content: "new fact" },
			content: [{ type: "text", text: JSON.stringify({ success: true }) }],
			isError: false,
		},
	});
	const patchText = textOf(patchRow);
	assert.match(patchText, /已更新一条记忆/);
	assert.match(patchText, /old fact → new fact/);

	const runningRow = MemoryRow({
		block: { phase: "start", args: { action: "add", target: "memory", content: "x" }, argsRaw: "{}" },
	});
	assert.match(textOf(runningRow), /正在记住一条新记忆/);

	const failedRow = MemoryRow({
		block: {
			kind: "ok",
			args: { action: "add", target: "memory", content: "x" },
			content: [
				{
					type: "text",
					text: JSON.stringify({ success: false, error: "Memory at 2,200/2,200 chars; adding this entry would exceed the limit" }),
				},
			],
			isError: false,
		},
	});
	const failedText = textOf(failedRow);
	assert.match(failedText, /记忆写入失败/);
	assert.match(failedText, /exceed the limit/);
});

test("skill tool row renders its own labels", async () => {
	const bundle = await loadBundle();
	const exportsObject = bundle.factory(requireStub(fakeReact()));
	const registrations = [];
	exportsObject.apply(fakeCtx(registrations, []));
	const SkillRow = registrations.find(
		(entry) => entry.definition.name === "tool.call.toolview" && entry.definition.key === "skill_manage",
	).component;

	const row = SkillRow({
		block: {
			kind: "ok",
			args: { action: "patch", name: "dsh-cordis-plugin" },
			content: [{ type: "text", text: JSON.stringify({ success: true, name: "dsh-cordis-plugin" }) }],
			isError: false,
		},
	});
	assert.match(textOf(row), /已更新技能/);
	assert.match(textOf(row), /dsh-cordis-plugin/);
});

/* ---------------------- Phase 1 / 4：面板的 review 与变更区块 ---------------------- */

function panelReact(values) {
	const react = fakeReact();
	let index = 0;
	react.useState = (initial) => [index < values.length ? values[index++] : initial, () => {}];
	return react;
}

function renderText(node) {
	if (node === null || node === undefined || node === false) return "";
	if (typeof node === "string" || typeof node === "number") return String(node);
	if (Array.isArray(node)) return node.map(renderText).join(" ");
	if (typeof node === "object") {
		if (typeof node.type === "function") return renderText(node.type(node.props));
		if (Array.isArray(node.children)) return renderText(node.children);
	}
	return "";
}

function panelState(overrides = {}) {
	return {
		ok: true,
		targets: {
			memory: { entries: [], used: 0, limit: 2200, percent: 0, usage: "0% — 0/2,200 chars" },
			user: { entries: [], used: 0, limit: 1375, percent: 0, usage: "0% — 0/1,375 chars" },
		},
		pending: [],
		reviews: [],
		writes: [],
		...overrides,
	};
}

async function renderPanel(state) {
	const bundle = await loadBundle();
	const exportsObject = bundle.factory(requireStub(panelReact([state, "", false, ""])));
	const registrations = [];
	exportsObject.apply(fakeCtx(registrations, []));
	const main = registrations.find((entry) => entry.definition.name === "main");
	assert.ok(main, "main panel must be registered");
	return renderText(main.component());
}

test("面板在 state 带 reviews 时渲染「最近 review」", async () => {
	const now = Date.now();
	const text = await renderPanel(
		panelState({
			reviews: [{ id: "r1", summary: "MEMORY +1 ~0 -0 · USER +0 ~0 -0", finished_at: now }],
		}),
	);
	assert.match(text, /最近 review/);
	assert.match(text, /MEMORY \+1/);
	assert.match(text, /\d{2}:\d{2}/);
});

test("面板的「最近变更」：单条有撤销按钮，batch 提示不可撤销", async () => {
	const now = Date.now();
	const text = await renderPanel(
		panelState({
			writes: [
				{ ts: now, action: "add", target: "memory", before: null, after: "fresh note" },
				{ ts: now, action: "patch", target: "memory", before: "old", after: "new" },
				{ ts: now, action: "remove", target: "user", before: "gone", after: null },
				{ ts: now, action: "patch", target: "memory", before: "a", after: "b", batch: true },
			],
		}),
	);
	assert.match(text, /最近变更/);
	assert.match(text, /fresh note/);
	assert.match(text, /撤销/);
	assert.match(text, /批量操作不可撤销/);
});

test("面板用标签页一次只展示一条轨，并显示各轨条数", async () => {
	const text = await renderPanel(panelState());
	assert.match(text, /记忆/);
	assert.match(text, /用户/);
	assert.match(text, /MEMORY · 我的工作笔记/);
	assert.doesNotMatch(text, /USER PROFILE · 用户是谁/);
});
test("面板没有 review / 变更记录时隐藏这两个区块，只留同步入口", async () => {
	const text = await renderPanel(panelState());
	assert.doesNotMatch(text, /最近 review/);
	assert.doesNotMatch(text, /最近变更/);
	assert.match(text, /更多/);
	assert.match(text, /同步/);
});

test("过期的 pending 不再渲染「批准」，只留「丢弃这条过期提案」", async () => {
	const now = Date.now();
	const text = await renderPanel(
		panelState({
			pending: [
				{
					id: "p-stale",
					created_at: now,
					target: "memory",
					action: "batch",
					operation_count: 2,
					stale: true,
					stale_reason: "条目自提案后已变：opencode 本机…",
				},
				{ id: "p-fresh", created_at: now, target: "memory", action: "patch", old_text: "old", content: "new" },
			],
		}),
	);
	assert.match(text, /丢弃这条过期提案/);
	assert.match(text, /条目自提案后已变/);
	const approveCount = (text.match(/批准/g) || []).length;
	// one 批准 in the section description, one on the fresh record — none on the stale one
	assert.equal(approveCount, 2, "only the fresh pending may offer 批准");
});

test("面板在 state 带 suggestions 时渲染建议区块与采纳/丢弃按钮", async () => {
	const now = Date.now();
	const text = await renderPanel(
		panelState({
			suggestions: [
				{ id: "s1", created_at: now, target: "memory", text: "pnpm only after sync" },
			],
		}),
	);
	assert.match(text, /建议/);
	assert.match(text, /memory/);
	assert.match(text, /pnpm only after sync/);
	assert.match(text, /采纳/);
	assert.match(text, /丢弃/);
});

test("面板 suggestions 为空时不渲染建议区块", async () => {
	const text = await renderPanel(panelState());
	assert.doesNotMatch(text, /采纳/);
});

/* ---------------------- 0.14.0：交互质量 P0 ---------------------- */

function expandTree(node) {
	if (node === null || node === undefined || node === false) return null;
	if (Array.isArray(node)) return node.map(expandTree).filter(Boolean);
	if (typeof node === "object" && typeof node.type === "function") return expandTree(node.type(node.props));
	if (typeof node === "object" && Array.isArray(node.children)) {
		return { ...node, children: node.children.map(expandTree).filter(Boolean) };
	}
	return node;
}

function collectNodes(node, predicate, out = []) {
	if (node === null || node === undefined || node === false) return out;
	if (Array.isArray(node)) {
		for (const child of node) collectNodes(child, predicate, out);
		return out;
	}
	if (typeof node === "object") {
		if (predicate(node)) out.push(node);
		if (Array.isArray(node.children)) for (const child of node.children) collectNodes(child, predicate, out);
	}
	return out;
}

async function renderPanelTree(state) {
	const bundle = await loadBundle();
	const exportsObject = bundle.factory(requireStub(panelReact([state, "", false, ""])));
	const registrations = [];
	exportsObject.apply(fakeCtx(registrations, []));
	const main = registrations.find((entry) => entry.definition.name === "main");
	return expandTree(main.component());
}

test("空态显示对应轨道的 hint，而不是「还没有条目」", async () => {
	const text = await renderPanel(panelState());
	assert.match(text, /记环境事实与踩坑结论/);
	assert.match(text, /pnpm 12\.x 与桌面端不匹配/);
	assert.doesNotMatch(text, /还没有条目/);
});

test("轨道标签页暴露 tablist/tab、aria-selected 与 roving tabIndex", async () => {
	const tree = await renderPanelTree(panelState());
	const tablist = collectNodes(tree, (node) => node.props && node.props.role === "tablist")[0];
	assert.ok(tablist, "tabs container must have role=tablist");
	const tabs = collectNodes(tablist, (node) => node.props && node.props.role === "tab");
	assert.equal(tabs.length, 2);
	assert.equal(tabs[0].props["aria-selected"], true);
	assert.equal(tabs[0].props.tabIndex, 0);
	assert.equal(tabs[1].props["aria-selected"], false);
	assert.equal(tabs[1].props.tabIndex, -1);
});

test("条目文本可键盘进入编辑，新增输入框有 aria-label", async () => {
	const tree = await renderPanelTree(
		panelState({
			targets: {
				memory: { entries: ["alpha"], used: 5, limit: 2200, percent: 0, usage: "0% — 5/2,200 chars" },
				user: { entries: [], used: 0, limit: 1375, percent: 0, usage: "0% — 0/1,375 chars" },
			},
		}),
	);
	const editable = collectNodes(
		tree,
		(node) => node.props && node.props.role === "button" && node.props["aria-label"] === "编辑这条记忆",
	);
	assert.ok(editable.length >= 1, "entry text must expose a keyboard-editable button");
	assert.equal(editable[0].props.tabIndex, 0);
	assert.equal(typeof editable[0].props.onKeyDown, "function");
	const addBox = collectNodes(tree, (node) => node.props && node.props["aria-label"] === "新增记忆条目")[0];
	assert.ok(addBox, "add entry textarea must have an aria-label");
	assert.equal(addBox.type, "textarea");
});

function expandUntil(node, stopName) {
	if (node === null || node === undefined || node === false) return null;
	if (Array.isArray(node)) return node.map((child) => expandUntil(child, stopName)).filter(Boolean);
	if (typeof node === "object" && typeof node.type === "function") {
		if (node.type.name === stopName) return node;
		return expandUntil(node.type(node.props), stopName);
	}
	if (typeof node === "object" && Array.isArray(node.children)) {
		return { ...node, children: node.children.map((child) => expandUntil(child, stopName)).filter(Boolean) };
	}
	return node;
}

test("条目 key 以内容为准，重复内容追加出现序号", async () => {
	const bundle = await loadBundle();
	const exportsObject = bundle.factory(
		requireStub(
			panelReact([
				panelState({
					targets: {
						memory: { entries: ["dup", "dup", "unique"], used: 9, limit: 2200, percent: 0, usage: "0% — 9/2,200 chars" },
						user: { entries: [], used: 0, limit: 1375, percent: 0, usage: "0% — 0/1,375 chars" },
					},
				}),
				"",
				false,
				"",
			]),
		),
	);
	const registrations = [];
	exportsObject.apply(fakeCtx(registrations, []));
	const main = registrations.find((entry) => entry.definition.name === "main");
	const cards = collectNodes(
		expandUntil(main.component(), "EntryCard"),
		(node) => typeof node.type === "function" && node.type.name === "EntryCard",
	);
	assert.deepEqual(
		cards.map((card) => card.props.key),
		["memory:dup", "memory:dup:1", "memory:unique"],
	);
});

test("按条目 busy：只有 key 匹配的条目被禁用，其他条目仍可编辑", async () => {
	const bundle = await loadBundle();
	const exportsObject = bundle.factory(
		requireStub(
			panelReact([
				panelState({
					targets: {
						memory: { entries: ["alpha", "beta"], used: 10, limit: 2200, percent: 0, usage: "0% — 10/2,200 chars" },
						user: { entries: [], used: 0, limit: 1375, percent: 0, usage: "0% — 0/1,375 chars" },
					},
				}),
				"",
				false,
				"memory:alpha",
			]),
		),
	);
	const registrations = [];
	exportsObject.apply(fakeCtx(registrations, []));
	const main = registrations.find((entry) => entry.definition.name === "main");
	const cards = collectNodes(
		expandUntil(main.component(), "EntryCard"),
		(node) => typeof node.type === "function" && node.type.name === "EntryCard",
	);
	const byEntry = Object.fromEntries(cards.map((card) => [card.props.entry, card.props]));
	assert.equal(byEntry.alpha.busy, true);
	assert.equal(byEntry.beta.busy, false);
});

/* ---------------------- 0.14.0：交互质量 P1 ---------------------- */

function panelHookValues(state, overrides = {}) {
	return [
		state,
		overrides.error ?? "",
		overrides.busy ?? false,
		overrides.busyKey ?? "",
		overrides.notice ?? "",
		overrides.activeTrack ?? null,
		overrides.editingCount ?? 0,
		overrides.savedKey ?? "",
		overrides.query ?? "",
		overrides.searchState ?? { status: "", results: [], error: "" },
		overrides.undoEntry ?? null,
		overrides.undoState ?? "",
	];
}

async function renderPanelElement(values) {
	const bundle = await loadBundle();
	const exportsObject = bundle.factory(requireStub(panelReact(values)));
	const registrations = [];
	exportsObject.apply(fakeCtx(registrations, []));
	const main = registrations.find((entry) => entry.definition.name === "main");
	assert.ok(main, "main panel must be registered");
	return main.component();
}

test("面板头部提供搜索框与搜索按钮，空输入时按钮禁用", async () => {
	const tree = expandTree(await renderPanelElement(panelHookValues(panelState())));
	const input = collectNodes(tree, (node) => node.type === "input")[0];
	assert.ok(input, "header must render a search input");
	assert.equal(input.props["aria-label"], "搜索记忆");
	assert.equal(input.props.placeholder, "搜索五轨记忆…");
	const button = collectNodes(tree, (node) => node.type === "button" && textOf(node) === "搜索")[0];
	assert.ok(button, "header must render a 搜索 button");
	assert.equal(button.props.disabled, true);
});

test("搜索结果显示在标签栏下方，按轨道标签 + 条目渲染并截断长条目", async () => {
	const searchState = {
		status: "done",
		results: [
			{ target: "memory", entry: "pnpm 12.x 与桌面端不匹配", score: 2 },
			{ target: "daily", entry: "d".repeat(200), score: 1 },
		],
		error: "",
	};
	const tree = expandTree(
		await renderPanelElement(panelHookValues(panelState(), { query: "pnpm", searchState })),
	);
	const text = textOf(tree);
	assert.match(text, /记忆 · pnpm 12\.x 与桌面端不匹配/);
	assert.match(text, /每日 · d{100}/);
	assert.match(text, /…/);
	assert.doesNotMatch(text, /没有匹配的条目/);
});

test("搜索无结果与请求失败分别给出空态和红字原因", async () => {
	const emptyTree = expandTree(
		await renderPanelElement(
			panelHookValues(panelState(), {
				query: "nothing",
				searchState: { status: "done", results: [], error: "" },
			}),
		),
	);
	assert.match(textOf(emptyTree), /没有匹配的条目。/);

	const errorTree = expandTree(
		await renderPanelElement(
			panelHookValues(panelState(), {
				query: "boom",
				searchState: { status: "error", results: [], error: "检索服务挂了" },
			}),
		),
	);
	assert.match(textOf(errorTree), /检索服务挂了/);
});

test("pending 用 diff 风格展示删除行与新增行，批量 ops 也逐行展示", async () => {
	const longOld = "o".repeat(300);
	const text = await renderPanel(
		panelState({
			pending: [
				{ id: "p-diff", target: "memory", action: "patch", old_text: longOld, content: "new fact" },
				{
					id: "p-batch",
					target: "memory",
					action: "batch",
					operation_count: 2,
					operations: [
						{ action: "patch", old_text: "a", content: "b" },
						{ action: "remove", old_text: "c" },
					],
				},
			],
		}),
	);
	assert.match(text, /− o{50}/);
	assert.match(text, /\+ new fact/);
	assert.match(text, /…/);
	assert.match(text, /· patch/);
	assert.match(text, /− a/);
	assert.match(text, /\+ b/);
	assert.match(text, /− c/);
	assert.doesNotMatch(text, /old:/);
	assert.doesNotMatch(text, /new:/);
});

test("删除成功后 TrackSection 回调 onDeleted，带轨道与原条目文本", async () => {
	const element = await renderPanelElement(
		panelHookValues(
			panelState({
				targets: {
					memory: { entries: ["alpha"], used: 5, limit: 2200, percent: 0, usage: "0% — 5/2,200 chars" },
					user: { entries: [], used: 0, limit: 1375, percent: 0, usage: "0% — 0/1,375 chars" },
				},
			}),
		),
	);
	const trackNode = collectNodes(
		element,
		(node) => typeof node.type === "function" && node.type.name === "TrackSection",
	)[0];
	assert.ok(trackNode, "TrackSection must be rendered");
	const deleted = [];
	const rendered = trackNode.type({
		...trackNode.props,
		onWrite: async () => ({ ok: true }),
		onDeleted: (payload) => deleted.push(payload),
	});
	const card = collectNodes(
		expandUntil(rendered, "EntryCard"),
		(node) => typeof node.type === "function" && node.type.name === "EntryCard",
	)[0];
	const result = await card.props.onRemove("alpha");
	assert.deepEqual(result, { ok: true });
	assert.deepEqual(deleted, [{ target: "memory", text: "alpha", position: 0 }]);
});

test("删除后底部悬浮提示「已删除 · 撤销」，撤销成功显示「已撤销」", async () => {
	const pendingTree = expandTree(
		await renderPanelElement(
			panelHookValues(panelState(), { undoEntry: { target: "memory", text: "gone" } }),
		),
	);
	const pendingText = textOf(pendingTree);
	assert.match(pendingText, /已删除/);
	assert.match(pendingText, /撤销/);
	const undoButton = collectNodes(
		pendingTree,
		(node) => node.type === "button" && textOf(node) === "撤销",
	)[0];
	assert.ok(undoButton, "toast must render a 撤销 button");

	const doneTree = expandTree(
		await renderPanelElement(panelHookValues(panelState(), { undoState: "done" })),
	);
	assert.match(textOf(doneTree), /已撤销/);
});

test("撤销失败时在 toast 里显示红字原因", async () => {
	const tree = expandTree(
		await renderPanelElement(
			panelHookValues(panelState(), {
				undoEntry: { target: "memory", text: "gone" },
				undoState: "写回失败：磁盘只读",
			}),
		),
	);
	assert.match(textOf(tree), /写回失败：磁盘只读/);
});
