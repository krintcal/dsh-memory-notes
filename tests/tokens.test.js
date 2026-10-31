import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const CLIENT = fs.readFileSync(path.join(import.meta.dirname, "..", "client.js"), "utf8");

/** 截出 `const T = {...};` 这一段（大括号配平），返回 [block, rest]。 */
function splitTokenBlock(source) {
	const start = source.indexOf("const T = {");
	assert.notEqual(start, -1, "client.js 必须包含 const T = { 设计 token 块");
	let depth = 0;
	let end = -1;
	for (let i = source.indexOf("{", start); i < source.length; i += 1) {
		if (source[i] === "{") depth += 1;
		else if (source[i] === "}") {
			depth -= 1;
			if (depth === 0) {
				end = i + 1;
				break;
			}
		}
	}
	assert.notEqual(end, -1, "token 块大括号必须配平");
	return [source.slice(start, end), source.slice(0, start) + source.slice(end)];
}

const [TOKENS, REST] = splitTokenBlock(CLIENT);

test("token 块覆盖字号/圆角/间距/颜色/边框/行高六类", () => {
	for (const group of ["font:", "radius:", "space:", "color:", "border:", "shadow:", "line:"]) {
		assert.ok(TOKENS.includes(group), `token 块缺少 ${group}`);
	}
	assert.match(TOKENS, /xs: "11px"/);
	assert.match(TOKENS, /sm: "12px"/);
	assert.match(TOKENS, /md: "13px"/);
	assert.match(TOKENS, /pill: "999px"/);
});

test("token 块以外不再有颜色字面量", () => {
	const hits = [];
	REST.split("\n").forEach((line, index) => {
		if (/#[0-9a-fA-F]{3,8}\b/.test(line) || /\brgba?\(/.test(line)) hits.push(`${index + 1}: ${line.trim()}`);
	});
	assert.deepEqual(hits, [], `以下行仍有裸颜色，应改用 T.color / T.border：\n${hits.join("\n")}`);
});

test("token 块以外不再有裸 px 字号与圆角", () => {
	const hits = [];
	REST.split("\n").forEach((line, index) => {
		if (/fontSize:\s*"[^"]+"/.test(line) || /borderRadius:\s*"[^"]+"/.test(line)) hits.push(`${index + 1}: ${line.trim()}`);
	});
	assert.deepEqual(hits, [], `以下行仍写死字号/圆角：\n${hits.join("\n")}`);
});

test("颜色 token 引用宿主主题变量并带 fallback", () => {
	const colorBlock = TOKENS.slice(TOKENS.indexOf("color: {"), TOKENS.indexOf("border: {"));
	const entries = [...colorBlock.matchAll(/(\w+):\s*"([^"]+)"/g)].map((m) => [m[1], m[2]]);
	assert.ok(entries.length >= 18, `颜色 token 太少：${entries.length}`);
	const allowedRaw = new Set(["dangerOnDark"]);
	for (const [name, value] of entries) {
		if (allowedRaw.has(name)) continue;
		assert.match(value, /^var\(--dsw-alias-[\w-]+, .+\)$/, `${name} 必须是 var(--dsw-alias-…, fallback)，实际为 ${value}`);
	}
	assert.ok(!entries.some(([name]) => name === "successOnDark"), "successOnDark 已被 T.color.success 取代，不应留在 token 表里");
});

test("边框 token 引用 DSH 边框层级变量", () => {
	for (const level of ["border-l1", "border-l2", "border-l3", "border-l4"]) {
		assert.ok(TOKENS.includes(`var(--dsw-alias-${level}`), `缺少 ${level} 级边框 token`);
	}
});

test("间距 token 是 px 字符串，键即 2px 网格的档位", () => {
	const spaceBlock = TOKENS.slice(TOKENS.indexOf("space: {"), TOKENS.indexOf("color: {"));
	const entries = [...spaceBlock.matchAll(/(\d+):\s*"(\d+px)"/g)].map((m) => [Number(m[1]), m[2]]);
	assert.ok(entries.length >= 12, `间距 token 太少：${entries.length}`);
	const pxValues = new Map();
	for (const [step, value] of entries) {
		assert.equal(value, `${step * 2}px`, `space[${step}] 应为 ${step * 2}px，实际 ${value}`);
		pxValues.set(Number(value.slice(0, -2)), step);
	}
	for (const baseline of [0, 4, 8, 12, 16, 20, 24]) {
		assert.ok(pxValues.has(baseline), `间距 token 缺少 ${baseline}px 档（space[${baseline / 2}]）`);
	}
});
