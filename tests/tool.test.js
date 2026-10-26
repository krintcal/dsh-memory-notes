import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { apply } from '../index.js';
import { clearReviewSession, markReviewSession } from '../src/review-registry.js';

function freshDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mem-plugin-'));
}

function fakeCtx(services) {
  const tools = [];
  const sections = [];
  const listeners = [];
  const disposers = [];
  const ctx = {
    tools: { register: (def) => tools.push(def) },
    systemPrompt: {
      section: (def) => sections.push(def),
      context: (def) => sections.push(def),
    },
    on: (event, handler) => {
      listeners.push({ event, handler });
      const dispose = () => {
        const index = listeners.findIndex((item) => item.handler === handler);
        if (index >= 0) listeners.splice(index, 1);
      };
      disposers.push(dispose);
      return dispose;
    },
    // 真正执行回调，才能覆盖 index.js 里 curator 的 turn/end 接线。
    effect: (run) => {
      const dispose = run();
      if (typeof dispose === 'function') disposers.push(dispose);
    },
  };
  // 只有显式注入 services 才提供 ctx.get：老用例因此保持「没有审批服务」的直写语义。
  if (services !== undefined) ctx.get = (name) => services[name];
  return { tools, sections, listeners, ctx };
}

function setup(config = {}, services) {
  const dir = config.dir ?? freshDir();
  const { ctx, tools, sections, listeners } = fakeCtx(services);
  apply(ctx, { dir, skillsDir: config.skillsDir ?? path.join(dir, 'skills'), ...config });
  return { dir, tool: tools[0], tools, section: sections[0], listeners };
}

function approvalStub(outcome, { policy } = {}) {
  const calls = [];
  return {
    calls,
    effectivePolicy: policy === undefined ? undefined : () => policy,
    request(spec) {
      calls.push(spec);
      if (outcome instanceof Error) return Promise.reject(outcome);
      return Promise.resolve(outcome);
    },
  };
}

const approvalExec = { session: { id: 'main-session' }, agent: { session: { id: 'main-session' } } };

test('apply 注册 memory 工具与 order 9000 的实时 context', () => {
  const { tool, section } = setup();
  assert.equal(tool.name, 'memory');
  assert.deepEqual(tool.parameters.properties.target.enum, ['memory', 'user', 'key', 'project', 'daily']);
  assert.ok(Array.isArray(tool.parameters.required));
  assert.equal(typeof tool.output.render, 'function');
  assert.equal(section.name, 'memory:snapshot');
  assert.equal(section.order, 9000);
  assert.equal(typeof section.text, 'function');
});

test('layeredTargets:false：target enum 退回 memory/user', () => {
  const { tool } = setup({ layeredTargets: false });
  assert.deepEqual(tool.parameters.properties.target.enum, ['memory', 'user']);
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
  assert.equal(res.usage, '10/30');
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

test('实时快照：同一份数据逐字节稳定，写入下一轮即可见', () => {
  const { tool, section } = setup();
  const before = section.text({ scope: { id: 'session-a' } });
  assert.equal(typeof before, 'string');
  assert.match(before, /runtime context message/);
  assert.match(before, /每回合收尾/);
  // 数据没变 → 文本必须逐字节一致（否则宿主会反复 append）
  assert.equal(section.text({ scope: { id: 'session-a' } }), before);
  assert.equal(section.text({ scope: { id: 'session-b' } }), before);

  tool.execute({ target: 'memory', action: 'add', content: 'fresh note' }, {});
  const after = section.text({ scope: { id: 'session-a' } });
  assert.notEqual(after, before);
  assert.match(after, /fresh note/);
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

  skill.execute({ action: 'read', name: 'demo-skill' });
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
  const emit = (event) => {
    for (const listener of listeners.filter((l) => l.event === 'session/event')) {
      listener.handler({}, event);
    }
  };

  // 非 turn/end 事件不产生任何状态文件
  emit({ type: 'assistant/chunk' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fs.existsSync(path.join(dir, 'curator-state.json')), false);

  emit({ type: 'turn/end' });
  // curator 被推到下一拍执行，避免卡住回合收尾
  await new Promise((resolve) => setImmediate(resolve));
  const state = JSON.parse(fs.readFileSync(path.join(dir, 'curator-state.json'), 'utf8'));
  assert.equal(state.run_count, 1);
});

test('stage → list_pending → apply_pending：后台只排队，主会话才落盘', () => {
  const { dir, tool } = setup();
  tool.execute({ target: 'memory', action: 'add', content: '旧的事实' }, {});

  const staged = tool.execute(
    { target: 'memory', action: 'stage', op: 'replace', old_text: '旧的事实', content: '新的事实' },
    {},
  );
  assert.equal(staged.success, true, JSON.stringify(staged));
  assert.equal(staged.staged, true);
  assert.match(staged.pending_id, /^[a-z0-9-]+$/);
  // 排队期间磁盘完全没变
  assert.match(fs.readFileSync(path.join(dir, 'MEMORY.md'), 'utf8'), /旧的事实/);

  const listed = tool.execute({ action: 'list_pending' }, {});
  assert.equal(listed.success, true);
  assert.equal(listed.pending_count, 1);
  assert.equal(listed.pending[0].action, 'replace');
  assert.equal(listed.pending[0].old_text, '旧的事实');

  const applied = tool.execute({ action: 'apply_pending', pending_id: staged.pending_id }, {});
  assert.equal(applied.success, true, JSON.stringify(applied));
  assert.equal(fs.readFileSync(path.join(dir, 'MEMORY.md'), 'utf8'), '新的事实');
  assert.equal(tool.execute({ action: 'list_pending' }, {}).pending_count, 0);
});

test('stage 参数不全 / apply 不存在的 id 都返回错误而不是抛异常', () => {
  const { tool } = setup();
  assert.equal(tool.execute({ action: 'stage', target: 'memory', old_text: 'x' }, {}).success, false);
  assert.equal(tool.execute({ action: 'stage', target: 'memory', op: 'remove' }, {}).success, false);
  const missing = tool.execute({ action: 'apply_pending', pending_id: 'nope-123' }, {});
  assert.equal(missing.success, false);
  assert.match(missing.error, /no pending entry/);
  const traversal = tool.execute({ action: 'apply_pending', pending_id: '../etc/passwd' }, {});
  assert.equal(traversal.success, false);
});

test('replace 已下线：模型面改用 patch，报错指向 patch', () => {
  const { dir, tool } = setup();
  tool.execute({ target: 'user', action: 'add', content: '喜欢简短回答' }, {});
  const res = tool.execute({ target: 'user', action: 'replace', old_text: '简短', content: '极简短' }, {});
  assert.equal(res.success, false);
  assert.match(res.error, /not available; use 'patch'/);
  assert.match(fs.readFileSync(path.join(dir, 'USER.md'), 'utf8'), /喜欢简短回答/, '拒绝时不落盘');
});

test('patch 只换条目内的一个 span，其余保留', () => {
  const { dir, tool } = setup();
  tool.execute({ target: 'user', action: 'add', content: '喜欢简短回答，不要寒暄' }, {});
  const res = tool.execute({ target: 'user', action: 'patch', old_text: '简短', content: '极简短' }, {});
  assert.equal(res.success, true, JSON.stringify(res));
  assert.equal(fs.readFileSync(path.join(dir, 'USER.md'), 'utf8'), '喜欢极简短回答，不要寒暄');
  assert.equal(res.patched_entry_after, '喜欢极简短回答，不要寒暄');
  // span 在条目内出现多次 → 拒绝并提示加长
  tool.execute({ target: 'memory', action: 'add', content: 'aa aa' }, {});
  const dup = tool.execute({ target: 'memory', action: 'patch', old_text: 'a', content: 'b' }, {});
  assert.equal(dup.success, false);
  assert.match(dup.error, /appears 4 times/);
  // content 为空 → 指向 remove
  const empty = tool.execute({ target: 'memory', action: 'patch', old_text: 'aa aa', content: '' }, {});
  assert.equal(empty.success, false);
  assert.match(empty.error, /'remove' deletes the whole entry/);
});

test('batch 里的 patch 与 add 一起原子提交', () => {
  const { dir, tool } = setup({ memoryCharLimit: 60 });
  tool.execute({ target: 'memory', action: 'add', content: 'aaa bbb ccc' }, {});
  const res = tool.execute(
    { target: 'memory', operations: [{ action: 'patch', old_text: 'bbb', content: 'ddd' }, { action: 'add', content: 'more' }] },
    {},
  );
  assert.equal(res.success, true, JSON.stringify(res));
  assert.match(fs.readFileSync(path.join(dir, 'MEMORY.md'), 'utf8'), /aaa ddd ccc/);
});

test('后台 review（unattended）的破坏性写入自动转 stage，add 仍直写', () => {
  const { dir, tool } = setup();
  tool.execute({ target: 'memory', action: 'add', content: 'old fact' }, {});
  const exec = { session: { id: 'review-child' } };
  markReviewSession('review-child');
  try {
    const added = tool.execute({ target: 'memory', action: 'add', content: 'background note' }, exec);
    assert.equal(added.success, true, 'add 在后台仍然直写');

    const staged = tool.execute({ target: 'memory', action: 'patch', old_text: 'old fact', content: 'new fact' }, exec);
    assert.equal(staged.success, true, JSON.stringify(staged));
    assert.equal(staged.proposal_staged, true);
    assert.match(staged.pending_id, /^[a-z0-9-]+$/);
    const before = fs.readFileSync(path.join(dir, 'MEMORY.md'), 'utf8');
    assert.match(before, /old fact/);
    assert.doesNotMatch(before, /new fact/);

    assert.equal(tool.execute({ action: 'list_pending' }, {}).pending_count, 1);

    // 审阅期间条目被主会话改掉 → 批准时 stale 拒绝，pending 记录保留
    tool.execute({ target: 'memory', action: 'patch', old_text: 'old fact', content: 'changed fact' }, {});
    const applied = tool.execute({ action: 'apply_pending', pending_id: staged.pending_id }, {});
    assert.equal(applied.success, false);
    assert.match(applied.error, /changed since it was staged/);
    assert.equal(tool.execute({ action: 'list_pending' }, {}).pending_count, 1, 'stale 后记录不丢');

    const discarded = tool.execute({ action: 'discard_pending', pending_id: staged.pending_id }, {});
    assert.equal(discarded.success, true);
    assert.equal(tool.execute({ action: 'list_pending' }, {}).pending_count, 0);
  } finally {
    clearReviewSession('review-child');
  }
  // 解除登记后主会话直写
  const direct = tool.execute({ target: 'memory', action: 'patch', old_text: 'changed fact', content: 'final' }, exec);
  assert.equal(direct.success, true);
  assert.match(fs.readFileSync(path.join(dir, 'MEMORY.md'), 'utf8'), /final/);
});

/* ------------------------- Phase 2：ctx.approval 审批 ------------------------- */

test("approval 'allowed-once'：破坏性写入放行", async () => {
  const stub = approvalStub('allowed-once');
  const { dir, tool } = setup({}, { approval: stub });
  tool.execute({ target: 'memory', action: 'add', content: 'old fact' }, {});
  const res = await tool.execute(
    { target: 'memory', action: 'patch', old_text: 'old fact', content: 'new fact' },
    approvalExec,
  );
  assert.equal(res.success, true, JSON.stringify(res));
  assert.equal(stub.calls.length, 1);
  assert.equal(stub.calls[0].toolName, 'memory');
  assert.match(stub.calls[0].reason, /修改记忆（memory）：old fact/);
  assert.match(fs.readFileSync(path.join(dir, 'MEMORY.md'), 'utf8'), /new fact/);
});

test("approval 'rejected'：不写盘并返回拒绝文案", async () => {
  const stub = approvalStub('rejected');
  const { dir, tool } = setup({}, { approval: stub });
  tool.execute({ target: 'memory', action: 'add', content: 'old fact' }, {});
  const res = await tool.execute(
    { target: 'memory', action: 'patch', old_text: 'old fact', content: 'new fact' },
    approvalExec,
  );
  assert.equal(res.success, false);
  assert.match(res.error, /rejected by the user/);
  assert.equal(res.note, 'Nothing was written.');
  assert.equal(fs.readFileSync(path.join(dir, 'MEMORY.md'), 'utf8'), 'old fact');
});

test("approval 'cancelled'：同样不写盘", async () => {
  const stub = approvalStub('cancelled');
  const { dir, tool } = setup({}, { approval: stub });
  tool.execute({ target: 'memory', action: 'add', content: 'keep me' }, {});
  const res = await tool.execute({ target: 'memory', action: 'remove', old_text: 'keep me' }, approvalExec);
  assert.equal(res.success, false);
  assert.equal(fs.readFileSync(path.join(dir, 'MEMORY.md'), 'utf8'), 'keep me');
});

test("approval 'unavailable'：转 pending，磁盘不变", async () => {
  const stub = approvalStub('unavailable');
  const { dir, tool } = setup({}, { approval: stub });
  tool.execute({ target: 'memory', action: 'add', content: 'old fact' }, {});
  const res = await tool.execute(
    { target: 'memory', action: 'patch', old_text: 'old fact', content: 'new fact' },
    approvalExec,
  );
  assert.equal(res.success, true, JSON.stringify(res));
  assert.equal(res.staged, true);
  assert.match(res.message, /审批通道不可用/);
  assert.equal(fs.readFileSync(path.join(dir, 'MEMORY.md'), 'utf8'), 'old fact');
  const listed = tool.execute({ action: 'list_pending' }, {});
  assert.equal(listed.pending_count, 1);
  assert.equal(listed.pending[0].action, 'patch');
});

test('审批调用抛错按 unavailable 处理（降级为 stage）', async () => {
  const stub = approvalStub(new Error('approval service exploded'));
  const { tool } = setup({}, { approval: stub });
  tool.execute({ target: 'memory', action: 'add', content: 'old fact' }, {});
  const res = await tool.execute(
    { target: 'memory', action: 'patch', old_text: 'old fact', content: 'new fact' },
    approvalExec,
  );
  assert.equal(res.success, true);
  assert.equal(res.staged, true);
});

test("policy 'never'：不问审批，直接写", async () => {
  const stub = approvalStub('rejected', { policy: 'never' });
  const { dir, tool } = setup({}, { approval: stub });
  tool.execute({ target: 'memory', action: 'add', content: 'old fact' }, {});
  const res = await tool.execute(
    { target: 'memory', action: 'patch', old_text: 'old fact', content: 'new fact' },
    approvalExec,
  );
  assert.equal(res.success, true);
  assert.equal(stub.calls.length, 0, 'never 策略下不发起 request');
  assert.match(fs.readFileSync(path.join(dir, 'MEMORY.md'), 'utf8'), /new fact/);
});

test('纯 add 不需要审批', async () => {
  const stub = approvalStub('rejected');
  const { tool } = setup({}, { approval: stub });
  const res = await tool.execute({ target: 'memory', action: 'add', content: 'fresh fact' }, approvalExec);
  assert.equal(res.success, true);
  assert.equal(stub.calls.length, 0);
});

test("approvalMode: 'auto'：不问审批，直接写", async () => {
  const stub = approvalStub('rejected');
  const { dir, tool } = setup({ approvalMode: 'auto' }, { approval: stub });
  tool.execute({ target: 'memory', action: 'add', content: 'old fact' }, {});
  const res = await tool.execute(
    { target: 'memory', action: 'patch', old_text: 'old fact', content: 'new fact' },
    approvalExec,
  );
  assert.equal(res.success, true);
  assert.equal(stub.calls.length, 0);
  assert.match(fs.readFileSync(path.join(dir, 'MEMORY.md'), 'utf8'), /new fact/);
});

test('batch 含破坏性操作也要审批，reason 说明是批量', async () => {
  const stub = approvalStub('allowed-once');
  const { tool } = setup({}, { approval: stub });
  tool.execute({ target: 'memory', action: 'add', content: 'aaa bbb' }, {});
  const res = await tool.execute(
    { target: 'memory', operations: [{ action: 'patch', old_text: 'bbb', content: 'ccc' }, { action: 'add', content: 'more' }] },
    approvalExec,
  );
  assert.equal(res.success, true, JSON.stringify(res));
  assert.equal(stub.calls.length, 1);
  assert.match(stub.calls[0].reason, /批量修改记忆（memory）：2 项/);
});

/* -------------------------- 0.7.0：建议队列与五轨 -------------------------- */

test("suggest：memory/user/key 入队且幂等，project/daily 拒绝", () => {
  const { dir, tool } = setup();
  const first = tool.execute({ target: 'memory', action: 'suggest', content: 'pnpm only after sync' }, {});
  assert.equal(first.success, true, JSON.stringify(first));
  assert.equal(first.staged, true);
  assert.match(first.pending_id, /^[a-z0-9]+$/);
  assert.match(first.message, /建议队列/);

  const again = tool.execute({ target: 'memory', action: 'suggest', content: 'pnpm only after sync' }, {});
  assert.equal(again.pending_id, first.pending_id, '相同内容幂等');

  const file = path.join(dir, 'SUGGESTIONS.jsonl');
  assert.match(fs.readFileSync(file, 'utf8'), /pnpm only after sync/);

  for (const target of ['project', 'daily']) {
    const res = tool.execute({ target, action: 'suggest', content: 'nope' }, {});
    assert.equal(res.success, false);
    assert.match(res.error, /only supports target/);
  }
});

test("suggest：缺 content / 缺 target 都返回 success:false", () => {
  const { tool } = setup();
  assert.equal(tool.execute({ target: 'memory', action: 'suggest' }, {}).success, false);
  const missing = tool.execute({ action: 'suggest', content: 'x' }, {});
  assert.equal(missing.success, false);
  assert.match(missing.error, /Missing required target/);
});

test('五轨写入：key/project/daily 走同一套 add/patch/remove 语义', () => {
  const { dir, tool } = setup({ projectLogCharLimit: 200, dailyLogCharLimit: 200 });
  const key = tool.execute({ target: 'key', action: 'add', content: 'uses pnpm [branch:main]' }, {});
  assert.equal(key.success, true);
  assert.equal(key.target, 'key');
  assert.match(key.usage, /chars$/);

  const patched = tool.execute({ target: 'project', action: 'add', content: 'step one' }, {});
  assert.equal(patched.success, true);
  tool.execute({ target: 'project', action: 'patch', old_text: 'one', content: 'two' }, {});

  const daily = tool.execute({ target: 'daily', action: 'add', content: 'today summary' }, {});
  assert.equal(daily.success, true);

  const projectDirs = fs.readdirSync(path.join(dir, 'projects'));
  assert.ok(projectDirs.length >= 1, '应创建 projects/<hash> 目录');
  const projectFile = path.join(dir, 'projects', projectDirs[0], 'PROJECT.md');
  assert.match(fs.readFileSync(projectFile, 'utf8'), /step two/);
  const dailyFiles = fs.readdirSync(path.join(dir, 'daily'));
  assert.equal(dailyFiles.length, 1);
  assert.match(fs.readFileSync(path.join(dir, 'daily', dailyFiles[0]), 'utf8'), /today summary/);
  const keyFile = path.join(dir, 'projects', projectDirs[0], 'KEY.md');
  assert.match(fs.readFileSync(keyFile, 'utf8'), /\[branch:main\]/);
});
