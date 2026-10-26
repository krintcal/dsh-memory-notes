import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { MemoryStore, MemoryError } from '../src/store.js';
import {
  createTracks,
  currentBranch,
  dateStamp,
  ensureProjectMeta,
  filterKeyEntries,
  parseBranchTag,
  projectInfo,
  workspaceHash,
} from '../src/tracks.js';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-tracks-'));
}

function storeFor(dir, overrides = {}) {
  const tracks = createTracks({ dir, cwd: overrides.cwd ?? path.join(dir, 'workspace'), limits: overrides.limits });
  return {
    tracks,
    store: new MemoryStore({
      dir,
      ...tracks.limits,
      files: tracks.files,
      targets: tracks.targets,
    }),
  };
}

test('workspaceHash：sha256 前 12 位，无 cwd 用 global', () => {
  const hash = workspaceHash('E:\\dsh\\work\\dsh-memory');
  assert.match(hash, /^[0-9a-f]{12}$/);
  assert.equal(hash.length, 12);
  assert.equal(workspaceHash(undefined), 'global');
  assert.equal(workspaceHash(''), 'global');
  assert.notEqual(hash, workspaceHash('E:\\dsh\\work\\other'));
});

test('五轨布局：key/project/daily 落到各自文件，meta.json 只写一次', () => {
  const dir = tempDir();
  const cwd = path.join(dir, 'my-workspace');
  const { store, tracks } = storeFor(dir, { cwd });
  assert.deepEqual(tracks.targets, ['memory', 'user', 'key', 'project', 'daily']);

  store.add('key', 'deploy uses pnpm');
  store.add('project', 'Wired the new endpoint');
  store.add('daily', 'Today: moved memory to tracks');

  const info = projectInfo(dir, cwd);
  assert.equal(fs.readFileSync(info.keyFile, 'utf8'), 'deploy uses pnpm');
  assert.equal(fs.readFileSync(info.projectFile, 'utf8'), 'Wired the new endpoint');
  assert.equal(fs.readFileSync(path.join(dir, 'daily', `${dateStamp()}.md`), 'utf8'), 'Today: moved memory to tracks');

  const meta = JSON.parse(fs.readFileSync(info.metaFile, 'utf8'));
  assert.equal(meta.cwd, cwd);
  assert.equal(meta.label, 'my-workspace');
  assert.ok(meta.updated_at);

  const first = ensureProjectMeta(dir, cwd);
  assert.equal(first.updated_at, meta.updated_at, '同 cwd 不重写 meta');
});

test('无 cwd 时项目轨落到 projects/global', () => {
  const dir = tempDir();
  const tracks = createTracks({ dir, cwd: undefined });
  assert.equal(tracks.project.hash, 'global');
  assert.equal(tracks.project.label, 'global');
  assert.match(tracks.files.key, /projects[\\/]global[\\/]KEY\.md$/);
  const meta = JSON.parse(fs.readFileSync(tracks.project.metaFile, 'utf8'));
  assert.equal(meta.cwd, null);
});

test('currentBranch：非 git 目录安静返回 undefined，不抛错', async () => {
  const dir = tempDir();
  assert.equal(await currentBranch(dir), undefined);
  assert.equal(await currentBranch(undefined), undefined);
  assert.doesNotThrow(() => currentBranch(path.join(dir, 'does-not-exist')));
});

test('parseBranchTag / filterKeyEntries：无标签全注入，分支未知绝不隐藏', () => {
  const entries = [
    'general fact',
    'main only [branch:main]',
    'release or main [branch:main, release]',
    'feature only [branch:feature/x]',
  ];

  assert.equal(parseBranchTag('general fact').branches, null);
  assert.deepEqual(parseBranchTag('main only [branch:main]').branches, ['main']);
  assert.deepEqual(parseBranchTag('x [branch:main, release]').branches, ['main', 'release']);

  assert.deepEqual(filterKeyEntries(entries, undefined), entries);
  assert.deepEqual(filterKeyEntries(entries, 'main'), [
    'general fact',
    'main only [branch:main]',
    'release or main [branch:main, release]',
  ]);
  assert.deepEqual(filterKeyEntries(entries, 'feature/x'), ['general fact', 'feature only [branch:feature/x]']);
  assert.deepEqual(filterKeyEntries(entries, 'missing'), ['general fact']);
});

test('配额按 track 分开：key/project/daily 用各自的 limit', () => {
  const dir = tempDir();
  const { store } = storeFor(dir, { limits: { keyCharLimit: 20, projectLogCharLimit: 30, dailyLogCharLimit: 15 } });
  store.add('key', 'k'.repeat(10));
  assert.throws(() => store.add('key', 'x'.repeat(20)), /would exceed the limit/);
  store.add('project', 'p'.repeat(10));
  assert.throws(() => store.add('project', 'x'.repeat(30)), /would exceed the limit/);
  store.add('daily', 'd'.repeat(5));
  assert.throws(() => store.add('daily', 'x'.repeat(20)), /would exceed the limit/);
});

test('target 校验：分层模式接受五轨，layeredTargets:false 退回两轨', () => {
  const dir = tempDir();
  const layered = storeFor(dir);
  for (const target of ['memory', 'user', 'key', 'project', 'daily']) {
    assert.doesNotThrow(() => layered.store.assertTarget(target));
  }

  const flatTracks = createTracks({ dir, cwd: dir, layered: false });
  const flat = new MemoryStore({ dir, files: flatTracks.files, targets: flatTracks.targets });
  assert.deepEqual(flat.targets, ['memory', 'user']);
  assert.throws(() => flat.assertTarget('key'), MemoryError);
  assert.match(flat.fileFor('memory'), /MEMORY\.md$/);
});

test('§ 校验对新增轨同样生效', () => {
  const dir = tempDir();
  const { store } = storeFor(dir);
  assert.throws(() => store.add('key', 'bad\n§\nentry'), MemoryError);
  assert.throws(() => store.add('project', 'bad\n§\nentry'), MemoryError);
  assert.throws(() => store.add('daily', 'bad\n§\nentry'), MemoryError);
});
