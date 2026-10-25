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

function fakeCtx(registrations, cleanups) {
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

	assert.equal(cleanups.length, 1);
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
