import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { apply } from '../index.js';

function freshDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mem-plugin-'));
}

function fakeCtx() {
  const tools = [];
  const sections = [];
  const listeners = [];
  const disposers = [];
  return {
    tools,
    sections,
    listeners,
    ctx: {
      tools: { register: (def) => tools.push(def) },
      systemPrompt: { section: (def) => sections.push(def) },
      on: (event, handler) => {
        listeners.push({ event, handler });
        const dispose = () => {};
        disposers.push(dispose);
        return dispose;
      },
      // 真正执行回调，才能覆盖 index.js 里 curator 的 turn/end 接线。
      effect: (run) => {
        const dispose = run();
        if (typeof dispose === 'function') disposers.push(dispose);
      },
    },
  };
}

function setup(config = {}) {
  const dir = config.dir ?? freshDir();
  const { ctx, tools, sections, listeners } = fakeCtx();
  apply(ctx, { dir, skillsDir: config.skillsDir ?? path.join(dir, 'skills'), ...config });
  return { dir, tool: tools[0], tools, section: sections[0], listeners };
}

test('apply 注册 memory 工具与 order 9000 的 memory 提示词段', () => {
  const { tool, section } = setup();
  assert.equal(tool.name, 'memory');
  assert.ok(tool.parameters.required.includes('target'));
  assert.equal(typeof tool.output.render, 'function');
  assert.equal(section.name, 'memory');
  assert.equal(section.order, 9000);
  assert.equal(typeof section.text, 'function');
});

test('happy path：add 落盘且结果不回显条目内容', () => {
  const { dir, tool } = setup();
  const res = tool.execute({ target: 'memory', action: 'add', content: 'secret-ish fact' }, {});
  assert.equal(res.success, true);
  assert.equal(res.done, true);
  assert.equal(res.target, 'memory');
  assert.equal(res.entry_count, 1);
  assert.equal(typeof res.usage, 'string');
  assert.equal(fs.existsSync(path.join(dir, 'MEMORY.md')), true);
  assert.doesNotMatch(JSON.stringify(res), /secret-ish fact/);
});

test('超限返回 success:false 与 current_entries', () => {
  const { tool } = setup({ memoryCharLimit: 30 });
  tool.execute({ target: 'memory', action: 'add', content: 'aaaaaaaaaa' }, {});
  const res = tool.execute({ target: 'memory', action: 'add', content: 'b'.repeat(30) }, {});
  assert.equal(res.success, false);
  assert.match(res.error, /would exceed the limit/);
  assert.ok(Array.isArray(res.current_entries));
  assert.equal(res.usage, '10/30 chars');
});

test('batch：先删后加通过，中途失败则磁盘不变', () => {
  const { dir, tool } = setup({ memoryCharLimit: 30 });
  tool.execute({ target: 'memory', action: 'add', content: 'a'.repeat(28) }, {});

  const ok = tool.execute(
    {
      target: 'memory',
      operations: [
        { action: 'remove', old_text: 'aaa' },
        { action: 'add', content: 'bbbb' },
      ],
    },
    {},
  );
  assert.equal(ok.success, true);
  assert.equal(fs.readFileSync(path.join(dir, 'MEMORY.md'), 'utf8'), 'bbbb');

  const bad = tool.execute(
    {
      target: 'memory',
      operations: [
        { action: 'add', content: 'temporary' },
        { action: 'remove', old_text: 'not-there' },
      ],
    },
    {},
  );
  assert.equal(bad.success, false);
  assert.equal(fs.readFileSync(path.join(dir, 'MEMORY.md'), 'utf8'), 'bbbb');
});

test('既无 action 也无 operations 时返回 success:false', () => {
  const { tool } = setup();
  const res = tool.execute({ target: 'memory' }, {});
  assert.equal(res.success, false);
  assert.match(res.error, /action.*operations/);
});

test('冻结快照：同会话不变，换会话才看到新条目', () => {
  const { tool, section } = setup();
  const a = { scope: { id: 'session-a' } };
  const before = section.text(a);
  assert.equal(typeof before, 'string');

  tool.execute({ target: 'memory', action: 'add', content: 'fresh note' }, {});
  assert.equal(section.text(a), before, '同一会话应冻结');
  assert.doesNotMatch(before, /fresh note/);

  const other = section.text({ scope: { id: 'session-b' } });
  assert.match(other, /fresh note/);
  assert.match(other, /Persistent memory loaded at session start/);
});

test('store 不可读时 text 返回字符串而不是抛错', () => {
  const broken = path.join(freshDir(), 'not-a-dir');
  fs.writeFileSync(broken, 'x', 'utf8');
  const { section } = setup({ dir: broken });
  const out = section.text({ scope: { id: 's1' } });
  assert.equal(typeof out, 'string');

  const gone = freshDir();
  fs.rmSync(gone, { recursive: true, force: true });
  const second = setup({ dir: gone });
  assert.equal(typeof second.section.text({ scope: { id: 's2' } }), 'string');
  assert.doesNotThrow(() => second.section.text());
});

test('skill_manage：snake_case 参数映射与 pin/status 分发', () => {
  const { tools } = setup();
  const skill = tools.find((t) => t.name === 'skill_manage');
  assert.ok(skill, 'skill_manage should be registered');

  const created = skill.execute({ action: 'create', name: 'demo-skill', description: '演示', body: '## 步骤' });
  assert.equal(created.success, true);

  const patched = skill.execute({
    action: 'patch',
    name: 'demo-skill',
    old_string: '## 步骤',
    new_string: '## 步骤（改）',
  });
  assert.equal(patched.success, true, JSON.stringify(patched));

  const pinned = skill.execute({ action: 'pin', name: 'demo-skill' });
  assert.equal(pinned.success, true);
  assert.equal(pinned.pinned, true);

  const status = skill.execute({ action: 'status' });
  assert.equal(status.success, true);
  assert.equal(status.usage['demo-skill'].pinned, true);
});

test('curator turn/end 接线：turn/end 才触发，其他事件不写盘', async () => {
  const dir = freshDir();
  const skillsDir = path.join(dir, 'skills');
  const { listeners } = setup({ dir, skillsDir });
  const turnEnd = listeners.find((l) => l.event === 'session/event');

  // 非 turn/end 事件不产生任何状态文件
  turnEnd.handler({}, { type: 'assistant/chunk' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fs.existsSync(path.join(dir, 'curator-state.json')), false);

  turnEnd.handler({}, { type: 'turn/end' });
  // curator 被推到下一拍执行，避免卡住回合收尾
  await new Promise((resolve) => setImmediate(resolve));
  const state = JSON.parse(fs.readFileSync(path.join(dir, 'curator-state.json'), 'utf8'));
  assert.equal(state.run_count, 1);
});
