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
