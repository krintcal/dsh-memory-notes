import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';

import { createCurator } from '../src/curator.js';
import { createReviewLog } from '../src/review-log.js';
import { createSkillLibrary } from '../src/skills.js';

const DAY = 24 * 60 * 60 * 1000;

function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-curator-'));
  const skillsDir = path.join(root, 'skills');
  const stateDir = path.join(root, 'memories');
  fs.mkdirSync(skillsDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  const library = createSkillLibrary({ dir: skillsDir, usageFile: path.join(stateDir, 'skill-usage.json') });
  return { root, skillsDir, stateDir, library };
}

function ageSkill(library, name, days, now) {
  library.setUsage(name, { last_used_at: new Date(now - days * DAY).toISOString() });
}

test('due：没有历史就绪，跑过一次后要等到间隔期满', () => {
  const { library, stateDir } = makeWorkspace();
  const curator = createCurator({ library, stateDir, config: { intervalHours: 168 } });
  const now = Date.parse('2026-10-24T12:00:00Z');

  assert.equal(curator.due(now), true);
  curator.run({ now });
  assert.equal(curator.due(now + 60_000), false);
  assert.equal(curator.due(now + 168 * 60 * 60 * 1000), true);
});

test('run：14 天标 stale，30 天进 .archive，pinned 不动，账本留痕', () => {
  const { library, skillsDir, stateDir } = makeWorkspace();
  const now = Date.parse('2026-10-24T12:00:00Z');

  for (const name of ['fresh-skill', 'stale-skill', 'old-skill', 'pinned-skill']) {
    library.create({ name, description: `${name} demo`, body: '## steps\n1. do it' });
  }
  ageSkill(library, 'stale-skill', 20, now);
  ageSkill(library, 'old-skill', 40, now);
  ageSkill(library, 'pinned-skill', 400, now);
  library.pin('pinned-skill', true);

  const curator = createCurator({ library, stateDir, config: { intervalHours: 168 } });
  const summary = curator.run({ now });

  assert.deepEqual(summary.stale.map((s) => s.name), ['stale-skill']);
  assert.deepEqual(summary.archived.map((s) => s.name), ['old-skill']);
  assert.deepEqual(summary.skipped, [{ name: 'pinned-skill', why: 'pinned' }]);

  // 归档是移动而不是删除，最后仍可找回
  assert.equal(fs.existsSync(path.join(skillsDir, 'old-skill')), false);
  assert.equal(fs.existsSync(path.join(skillsDir, '.archive', 'old-skill', 'SKILL.md')), true);
  assert.equal(fs.existsSync(path.join(skillsDir, 'pinned-skill', 'SKILL.md')), true);
  assert.equal(fs.existsSync(path.join(skillsDir, 'fresh-skill', 'SKILL.md')), true);

  // 遥测状态
  const usage = library.usage();
  assert.equal(usage['stale-skill'].state, 'stale');
  assert.equal(usage['old-skill'].state, 'archived');
  assert.equal(usage['pinned-skill'].pinned, true);

  // 快照 + 账本
  const backups = fs.readdirSync(path.join(skillsDir, '.curator_backups'));
  assert.equal(backups.length >= 1, true);
  const ledger = fs
    .readFileSync(path.join(skillsDir, '.curator_ledger.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(ledger.some((row) => row.action === 'mark-stale' && row.name === 'stale-skill'), true);
  assert.equal(ledger.some((row) => row.action === 'archive' && row.name === 'old-skill' && row.before_sha256), true);

  // 状态文件记下跑过一次
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, 'curator-state.json'), 'utf8'));
  assert.equal(state.run_count, 1);
});

test('maybeRun：不到点不产生任何写，跑过一次后立刻返回 undefined', () => {
  const { library, skillsDir, stateDir } = makeWorkspace();
  library.create({ name: 'keep-me', description: 'demo', body: 'x' });
  const curator = createCurator({ library, stateDir, config: { intervalHours: 168 } });

  const first = curator.maybeRun({ now: Date.now() });
  assert.equal(first !== undefined, true);
  const stateAfter = fs.readFileSync(path.join(stateDir, 'curator-state.json'), 'utf8');
  const backupsAfter = fs.readdirSync(path.join(skillsDir, '.curator_backups')).length;

  assert.equal(curator.maybeRun({ now: Date.now() }), undefined);
  assert.equal(fs.readFileSync(path.join(stateDir, 'curator-state.json'), 'utf8'), stateAfter);
  assert.equal(fs.readdirSync(path.join(skillsDir, '.curator_backups')).length, backupsAfter);
});

test('paused 时不触发', () => {
  const { library, stateDir } = makeWorkspace();
  const curator = createCurator({ library, stateDir, config: { paused: true } });
  assert.equal(curator.due(), false);
  assert.equal(curator.maybeRun(), undefined);
});

test('同名技能二次归档不覆盖上一份（只归档不删）', () => {
  const { library, skillsDir, stateDir } = makeWorkspace();
  const now = Date.parse('2026-10-24T12:00:00Z');
  const curator = createCurator({ library, stateDir, config: { intervalHours: 1 } });

  library.create({ name: 'temp-skill', description: 'demo', body: 'v1' });
  ageSkill(library, 'temp-skill', 40, now);
  curator.run({ now });

  library.create({ name: 'temp-skill', description: 'demo', body: 'v2' });
  ageSkill(library, 'temp-skill', 40, now);
  curator.run({ now: now + 2 * 60 * 60 * 1000 });

  const archived = fs.readdirSync(path.join(skillsDir, '.archive'));
  assert.equal(archived.length, 2, `expected two archives, got ${archived.join(', ')}`);
  assert.equal(archived.includes('temp-skill'), true);
});

test('快照不把自己包进去（排除 .curator_backups / .archive）', () => {
  const { library, skillsDir, stateDir } = makeWorkspace();
  const now = Date.parse('2026-10-24T12:00:00Z');
  library.create({ name: 'keep-me', description: 'demo', body: 'x' });
  ageSkill(library, 'keep-me', 40, now);

  const curator = createCurator({ library, stateDir, config: {} });
  curator.run({ now });
  // 再跑一次，此时 .curator_backups 里已有内容
  curator.run({ now: now + 1000 });

  const snapshot = curator.paths.backupDir;
  const entries = fs.readdirSync(snapshot);
  assert.equal(entries.length >= 1, true);
  const tar = entries.find((name) => name.endsWith('.tar.gz'));
  assert.ok(tar, `expected a tar.gz snapshot, got ${entries.join(', ')}`);
  const listing = spawnSync('tar', ['-tzf', tar], { cwd: snapshot, encoding: 'utf8' });
  assert.equal(listing.status, 0, listing.stderr);
  const names = listing.stdout.split(/\r?\n/).filter(Boolean);
  assert.equal(names.some((n) => n.includes('.curator_backups')), false, listing.stdout);
  assert.equal(names.some((n) => n.includes('.archive')), false, listing.stdout);
  assert.equal(names.some((n) => n.startsWith('keep-me/')), true, listing.stdout);
});

test('state 文件写不进去时 still 不会每回合重跑（内存时间戳兜底）', () => {
  const { library, stateDir } = makeWorkspace();
  const now = Date.parse('2026-10-24T12:00:00Z');
  const curator = createCurator({ library, stateDir, config: { intervalHours: 168 } });

  // 把 stateDir 变成不可写：用一个同名文件占位
  const blocked = path.join(stateDir, 'blocked');
  fs.mkdirSync(blocked, { recursive: true });
  const blockedCurator = createCurator({ library, stateDir: blocked, config: { intervalHours: 168 } });
  fs.rmSync(path.join(blocked, 'curator-state.json'), { force: true });
  fs.mkdirSync(path.join(blocked, 'curator-state.json'), { recursive: true });

  blockedCurator.run({ now });
  assert.equal(blockedCurator.due(now + 60_000), false, 'state 写失败后应凭内存时间戳抑制重跑');
  assert.equal(curator.due(now), true);
});

/* ------------------------- Phase 4：curator 建议制（suggest） ------------------------- */

function curatorCtx(registrations = []) {
  return {
    ctx: {
      get(name) {
        if (name === "subagents") {
          return {
            startActivation(spec) {
              registrations.push(spec);
              return { childId: "curator-child", result: Promise.resolve() };
            },
          };
        }
        if (name === "agents") {
          return { get: (id) => (id === "session-curator" ? { id, session: { id } } : undefined) };
        }
        return undefined;
      },
    },
    registrations,
  };
}

function staleWorkspace(now) {
  const workspace = makeWorkspace();
  workspace.library.create({ name: "stale-skill", description: "demo", body: "## steps" });
  ageSkill(workspace.library, "stale-skill", 20, now);
  return workspace;
}

test("consolidate: 'suggest' 且有 stale 条目时起一个 fork，提示词要求 stage", async () => {
  const now = Date.parse("2026-10-24T12:00:00Z");
  const { library, stateDir } = staleWorkspace(now);
  const reviewLog = createReviewLog(fs.mkdtempSync(path.join(os.tmpdir(), "mem-curator-log-")));
  const { ctx, registrations } = curatorCtx();

  const curator = createCurator({
    library,
    stateDir,
    ctx,
    reviewLog,
    config: { intervalHours: 1, consolidate: "suggest" },
  });
  curator.run({ now, session: { id: "session-curator" } });

  assert.equal(registrations.length, 1, "应起一个后台 fork");
  const prompt = registrations[0].request.prompt[0].text;
  assert.match(prompt, /stage/);
  assert.match(prompt, /operations/);
  assert.equal(registrations[0].provider, "fork");

  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reviewLog.count(), 1);
  assert.equal(reviewLog.recent(1)[0].channel, "curator");
});

test("consolidate: 'off'（默认）不起子会话", () => {
  const now = Date.parse("2026-10-24T12:00:00Z");
  const { library, stateDir } = staleWorkspace(now);
  const { ctx, registrations } = curatorCtx();

  const curator = createCurator({ library, stateDir, ctx, config: { intervalHours: 1 } });
  curator.run({ now, session: { id: "session-curator" } });

  assert.equal(registrations.length, 0);
});

test("suggest 但拿不到 subagents/agents 时只降级，不抛错", () => {
  const now = Date.parse("2026-10-24T12:00:00Z");
  const { library, stateDir } = staleWorkspace(now);
  const curator = createCurator({
    library,
    stateDir,
    ctx: { get: () => undefined },
    config: { intervalHours: 1, consolidate: "suggest" },
  });
  assert.doesNotThrow(() => curator.run({ now, session: { id: "session-curator" } }));
});

/* --------------- 0.8.0：consolidate 'suggest' 真实触发路径 --------------- */

function consolidationFixture(config = {}) {
  const { library, stateDir, root } = makeWorkspace();
  const now = Date.parse('2026-10-24T12:00:00Z');
  library.create({ name: 'stale-skill', description: 'demo', body: '## steps\n1. do it' });
  ageSkill(library, 'stale-skill', 20, now);

  const calls = [];
  const reviewLog = createReviewLog(path.join(stateDir));
  let childCounter = 0;
  const ctx = {
    get(name) {
      if (name === 'subagents') {
        return {
          startActivation(options) {
            calls.push(options);
            childCounter += 1;
            return Promise.resolve({ childId: `curator-child-${childCounter}`, result: Promise.resolve() });
          },
        };
      }
      if (name === 'agents') {
        return { get: (id) => ({ id, kind: 'fake-agent' }) };
      }
      return undefined;
    },
  };
  const curator = createCurator({
    library,
    stateDir,
    ctx,
    reviewLog,
    config: { intervalHours: 168, consolidate: 'suggest', ...config },
  });
  return { curator, calls, reviewLog, stateDir, root, now };
}

test("consolidate:'suggest' 且存在 stale 技能时起一个 memory-curator fork", async () => {
  const { curator, calls, reviewLog, now } = consolidationFixture();
  curator.run({ session: { id: 'session-1' }, now });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].provider, 'fork');
  assert.equal(calls[0].label, 'memory-curator');
  assert.equal(calls[0].delivery, 'caller');
  assert.match(calls[0].request.prompt[0].text, /stage/);

  // 等 activation 的 promise 链跑完，再断言 review-log
  await new Promise((resolve) => setTimeout(resolve, 20));
  const entry = reviewLog.recent(5).find((item) => item.channel === 'curator');
  assert.ok(entry, 'review-log 里应有 curator 记录');
  assert.equal(entry.child_id, 'curator-child-1');
  assert.equal(entry.session_id, 'session-1');
});

test("consolidate:'off' 时不启动 fork", () => {
  const { curator, calls, now } = consolidationFixture({ consolidate: 'off' });
  curator.run({ session: { id: 'session-1' }, now });
  assert.equal(calls.length, 0);
});

test('缺 subagents/agents 服务时跳过并保持可运行', () => {
  const { library, stateDir } = makeWorkspace();
  const now = Date.parse('2026-10-24T12:00:00Z');
  library.create({ name: 'stale-skill', description: 'demo', body: 'x' });
  ageSkill(library, 'stale-skill', 20, now);
  const curator = createCurator({ library, stateDir, config: { consolidate: 'suggest' } });
  const summary = curator.run({ session: { id: 'session-1' }, now });
  assert.deepEqual(summary.stale.map((s) => s.name), ['stale-skill']);
});
