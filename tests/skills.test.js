import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createSkillLibrary, parseFrontmatter, validateSkill } from '../src/skills.js';

function makeLibrary() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-skills-'));
  const usageFile = path.join(dir, '..', `usage-${path.basename(dir)}.json`);
  return { dir, usageFile, lib: createSkillLibrary({ dir, usageFile }) };
}

test('frontmatter 解析与描述长度校验', () => {
  const parsed = parseFrontmatter('---\nname: demo\ndescription: 一句话\n---\n\n正文\n');
  assert.equal(parsed.meta.name, 'demo');
  assert.equal(parsed.meta.description, '一句话');
  assert.equal(parsed.body.trim(), '正文');
  assert.equal(validateSkill({ name: 'demo', description: 'ok' }), undefined);
  assert.match(validateSkill({ name: 'Bad Name', description: 'ok' }), /name must match/);
  assert.match(validateSkill({ name: 'demo', description: 'x'.repeat(61) }), /at most 60/);
});

test('create 落盘带 frontmatter，重复创建被拒', () => {
  const { dir, lib } = makeLibrary();
  const created = lib.create({ name: 'deploy-check', description: '上线前自检', body: '## 步骤\n1. 跑测试' });
  assert.equal(created.success, true);
  const text = fs.readFileSync(path.join(dir, 'deploy-check', 'SKILL.md'), 'utf8');
  assert.match(text, /^---\nname: "deploy-check"\ndescription: "上线前自检"\n---/);
  assert.match(text, /## 步骤/);
  const again = lib.create({ name: 'deploy-check', description: '重复', body: 'x' });
  assert.equal(again.success, false);
  assert.match(again.error, /already exists/);
});

test('patch 要求 old_string 精确存在，改完 description 仍合法', () => {
  const { lib } = makeLibrary();
  lib.create({ name: 'deploy-check', description: '上线前自检', body: '步骤一' });
  const miss = lib.patch({ name: 'deploy-check', oldString: '不存在的文本', newString: 'x' });
  assert.equal(miss.success, false);
  assert.match(miss.error, /not found/);
  const hit = lib.patch({ name: 'deploy-check', oldString: '步骤一', newString: '步骤一（含回滚）' });
  assert.equal(hit.success, true);
  const after = lib.read('deploy-check').text;
  assert.match(after, /含回滚/);
});

test('delete 必须给 absorbed_into，给了才真删', () => {
  const { dir, lib } = makeLibrary();
  lib.create({ name: 'old-way', description: '老办法', body: 'x' });
  const refused = lib.remove({ name: 'old-way' });
  assert.equal(refused.success, false);
  assert.match(refused.error, /absorbed_into/);
  const ok = lib.remove({ name: 'old-way', absorbedInto: 'new-way' });
  assert.equal(ok.success, true);
  assert.equal(fs.existsSync(path.join(dir, 'old-way')), false);
});

test('list 只列出有 SKILL.md 的目录，并带描述', () => {
  const { dir, lib } = makeLibrary();
  lib.create({ name: 'a-skill', description: 'A', body: '' });
  lib.create({ name: 'b-skill', description: 'B', body: '' });
  fs.mkdirSync(path.join(dir, 'not-a-skill'), { recursive: true });
  const names = lib.list().map((s) => s.name);
  assert.deepEqual(names, ['a-skill', 'b-skill']);
});

test('路径穿越被拒绝，write_file 只能落在技能目录内', () => {
  const { lib } = makeLibrary();
  lib.create({ name: 'guard', description: 'G', body: '' });
  assert.throws(() => lib.writeFile({ name: 'guard', filePath: '../../escape.md', content: 'x' }), /outside/);
  const ok = lib.writeFile({ name: 'guard', filePath: 'references/api.md', content: '# api' });
  assert.equal(ok.success, true);
  assert.ok(fs.existsSync(ok.path));
});

test('view/patch/use 计入 usage 文件', () => {
  const { lib, usageFile } = makeLibrary();
  lib.create({ name: 'counter', description: 'C', body: 'x' });
  lib.read('counter');
  lib.patch({ name: 'counter', oldString: 'x', newString: 'y' });
  const usage = JSON.parse(fs.readFileSync(usageFile, 'utf8'));
  assert.equal(usage.counter.use_count, 1);
  assert.equal(usage.counter.view_count, 1);
  assert.equal(usage.counter.patch_count, 1);
  assert.ok(usage.counter.last_patched_at);
});

test('description 写成 YAML 双引号标量：冒号/井号/引号不会让宿主解析失败', () => {
  const { dir, lib } = makeLibrary();
  const tricky = 'Use when: the user asks about $HOME and #tags "quoted"';
  const created = lib.create({ name: 'yaml-safe', description: tricky, body: 'body' });
  assert.equal(created.success, true);

  const text = fs.readFileSync(path.join(dir, 'yaml-safe', 'SKILL.md'), 'utf8');
  assert.match(text, /^---\nname: "yaml-safe"\ndescription: "Use when: .*#tags \\"quoted\\""\n---/);
  // 插件自己的 parser 必须能读回原值
  assert.equal(parseFrontmatter(text).meta.description, tricky);
});

test('description 里的换行被拒绝（会打断 frontmatter）', () => {
  const { lib } = makeLibrary();
  const result = lib.create({ name: 'multi-line', description: 'first line\nsecond line', body: 'x' });
  assert.equal(result.success, false);
  assert.match(result.error, /single line/);
});

test('技能名对齐宿主规则：下划线/点号/连续短横线一律拒绝', () => {
  const { lib } = makeLibrary();
  for (const bad of ['my_skill', 'foo.bar', 'a--b', 'Trailing-']) {
    const result = lib.create({ name: bad, description: 'x', body: '' });
    assert.equal(result.success, false, `${bad} should be rejected`);
  }
  assert.equal(lib.create({ name: 'deploy-check', description: 'x', body: '' }).success, true);
});

test('patch 的 $& / $$ / $1 不被当成替换模式', () => {
  const { dir, lib } = makeLibrary();
  lib.create({ name: 'shell-skill', description: 'S', body: 'run: __CMD__' });
  const result = lib.patch({ name: 'shell-skill', oldString: '__CMD__', newString: 'echo "$1" && $$ $& done' });
  assert.equal(result.success, true);
  const text = fs.readFileSync(path.join(dir, 'shell-skill', 'SKILL.md'), 'utf8');
  assert.match(text, /run: echo "\$1" && \$\$ \$& done/);
});

test('patch 命中多处时要求 replace_all', () => {
  const { lib } = makeLibrary();
  lib.create({ name: 'dupes', description: 'D', body: 'line\nsame\nline\nsame\n' });

  const refused = lib.patch({ name: 'dupes', oldString: 'same', newString: 'other' });
  assert.equal(refused.success, false);
  assert.match(refused.error, /occurs 2 times/);

  const all = lib.patch({ name: 'dupes', oldString: 'same', newString: 'other', replaceAll: true });
  assert.equal(all.success, true);
  assert.equal(all.replaced, 2);
});


test('read-before-write：没读就 patch / delete / write_file 一律拒绝', () => {
  const { dir, lib } = makeLibrary();
  // 直接落盘模拟「别人的技能」：create 会记下作者自写的摘要，这里不能走 create。
  fs.mkdirSync(path.join(dir, 'guarded'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'guarded', 'SKILL.md'),
    '---\nname: "guarded"\ndescription: "受保护"\n---\n\n## 原始\n',
    'utf8',
  );

  const blind = lib.patch({ name: 'guarded', oldString: '## 原始', newString: '## 改' });
  assert.equal(blind.success, false);
  assert.match(blind.error, /read the skill first/);

  const blindDelete = lib.remove({ name: 'guarded', absorbedInto: 'other' });
  assert.equal(blindDelete.success, false);
  assert.match(blindDelete.error, /read the skill first/);

  const blindFile = lib.writeFile({ name: 'guarded', filePath: 'notes.md', content: 'x' });
  assert.equal(blindFile.success, false);
  assert.match(blindFile.error, /read the skill first/);
});

test('read-before-write：读后可写；读完之后被外部改过则拒绝', () => {
  const { dir, lib } = makeLibrary();
  lib.create({ name: 'guarded', description: '受保护', body: '## 原始' });
  lib.read('guarded');
  const ok = lib.patch({ name: 'guarded', oldString: '## 原始', newString: '## 改' });
  assert.equal(ok.success, true, JSON.stringify(ok));

  // 模拟别的进程改了文件
  const file = path.join(dir, 'guarded', 'SKILL.md');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8') + '\n外部追加\n', 'utf8');
  const stale = lib.patch({ name: 'guarded', oldString: '## 改', newString: '## 再改' });
  assert.equal(stale.success, false);
  assert.match(stale.error, /changed on disk since you read it/);

  // 重新读一次就恢复
  lib.read('guarded');
  const again = lib.patch({ name: 'guarded', oldString: '## 改', newString: '## 再改' });
  assert.equal(again.success, true, JSON.stringify(again));
});

test('read-before-write 可关闭（strictReadBeforeWrite: false）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-skills-lax-'));
  const lib = createSkillLibrary({ dir, usageFile: path.join(dir, 'usage.json'), strictReadBeforeWrite: false });
  lib.create({ name: 'lax', description: '宽松', body: '## 原始' });
  const res = lib.patch({ name: 'lax', oldString: '## 原始', newString: '## 改' });
  assert.equal(res.success, true, JSON.stringify(res));
});
