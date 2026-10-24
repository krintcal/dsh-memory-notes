/**
 * Phase 3：把「自我进化」里最小的那一半搬过来——让 agent 能写技能文件。
 *
 * Hermes 的做法（agent/tools/skill_manager_tool.py）：
 *   - 布局 `<skills>/<category>/<name>/SKILL.md`
 *   - frontmatter 必须有 name + description，description 要短（进系统提示时只截前 60 字）
 *   - create / patch / delete / write_file / remove_file，read-before-write 强制
 *   - 删除要求 absorbed_into（说清被谁吸收），避免悄悄丢知识
 * 这里只做 DSH 需要的部分：同样的目录布局、同样的 frontmatter 校验、
 * 同样的 read-before-write 与「删除必须有去处」，只是不分 category（DSH 的技能目录是平的）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

// 与宿主 dsh-skill 完全一致（/^[a-z0-9]+(?:-[a-z0-9]+)*$/）：比宿主宽松的名字写出去
// 会被宿主 warn 后整条忽略，插件自己却列得出来 —— 那种「静默无效」最难查。
const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_BODY = 100_000;
const MAX_DESCRIPTION = 60;

/** 读取 frontmatter（只支持简单 key: value，刻意不引入 YAML 依赖）。 */
export function parseFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!match) return { meta: {}, body: text, hasFrontmatter: false };
  const meta = {};
  for (const line of match[1].split(/\r?\n/)) {
    const pair = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (!pair) continue;
    const raw = pair[2].trim();
    // 我们写出去的是 JSON 字符串（YAML 的 double-quoted flow scalar），读回来按同样转义还原。
    const quoted = /^"((?:[^"\\]|\\.)*)"$/.exec(raw);
    if (quoted) {
      try {
        meta[pair[1]] = JSON.parse(`"${quoted[1]}"`);
      } catch {
        meta[pair[1]] = quoted[1];
      }
      continue;
    }
    meta[pair[1]] = raw.replace(/^['"]|['"]$/g, '');
  }
  return { meta, body: match[2], hasFrontmatter: true };
}

/** 按 Hermes 的规则校验一份待写入的技能。 */
export function validateSkill({ name, description, body, allowMissingBody = false }) {
  if (!NAME_RE.test(name)) return `name must match ${NAME_RE} (got ${JSON.stringify(name)})`;
  if (name.length > 64) return 'name must be at most 64 characters';
  if (!description || !description.trim()) return 'description is required';
  // 换行会把 frontmatter 的 --- 结构打断，宿主那边整条技能就废了。
  if (/[\r\n]/.test(description)) return 'description must be a single line (no newlines)';
  if (description.length > MAX_DESCRIPTION) {
    return `description must be at most ${MAX_DESCRIPTION} characters (got ${description.length})`;
  }
  if (!allowMissingBody && body !== undefined && body.length > MAX_BODY) {
    return `SKILL.md body must be at most ${MAX_BODY} characters (got ${body.length})`;
  }
  return undefined;
}

/**
 * frontmatter 的 description 一律写成 YAML double-quoted 标量：`:` `#` `$` 引号、以及
 * 「看起来像嵌套 map」的文本都会让宿主的 yaml 解析器报错，而插件自己的正则读回来却正常。
 */
function renderSkill({ name, description, body }) {
  return `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n---\n\n${(body ?? '').trim()}\n`;
}

/** 技能库：所有写操作都落在这里，路径一律限制在根目录内。 */
export function createSkillLibrary({ dir, usageFile }) {
  const root = path.resolve(dir);

  function inside(target) {
    const resolved = path.resolve(target);
    const prefix = root.endsWith(path.sep) ? root : root + path.sep;
    if (resolved !== root && !resolved.startsWith(prefix)) throw new Error(`refusing path outside ${root}`);
    return resolved;
  }

  function skillDir(name) {
    if (!NAME_RE.test(name)) throw new Error('invalid skill name');
    return inside(path.join(root, name));
  }

  function skillPath(name) {
    return path.join(skillDir(name), 'SKILL.md');
  }

  function readUsage() {
    if (!usageFile) return {};
    try {
      return JSON.parse(fs.readFileSync(usageFile, 'utf8'));
    } catch {
      return {};
    }
  }

  function bumpUsage(name, field) {
    if (!usageFile) return;
    const usage = readUsage();
    const entry = (usage[name] ??= { created_at: new Date().toISOString(), use_count: 0, view_count: 0, patch_count: 0 });
    entry[field] = (entry[field] ?? 0) + 1;
    entry[field === 'view_count' ? 'last_viewed_at' : field === 'patch_count' ? 'last_patched_at' : 'last_used_at'] = new Date().toISOString();
    try {
      fs.mkdirSync(path.dirname(usageFile), { recursive: true });
      fs.writeFileSync(usageFile, JSON.stringify(usage, null, 2), 'utf8');
    } catch {
      /* 遥测失败不该影响主流程 */
    }
  }

  function list() {
    if (!fs.existsSync(root)) return [];
    const entries = [];
    for (const dirent of fs.readdirSync(root, { withFileTypes: true })) {
      if (!dirent.isDirectory()) continue;
      if (dirent.name === '.archive' || dirent.name === '.curator_backups') continue;
      const file = path.join(root, dirent.name, 'SKILL.md');
      if (!fs.existsSync(file)) continue;
      const { meta } = parseFrontmatter(fs.readFileSync(file, 'utf8'));
      entries.push({ name: dirent.name, description: meta.description ?? '', path: file });
    }
    return entries.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** 补一条使用记录（curator 的 pin / state 也用这里写）。 */
  function patchUsage(name, patch) {
    if (!usageFile) return;
    const usage = readUsage();
    const entry = (usage[name] ??= { created_at: new Date().toISOString(), use_count: 0, view_count: 0, patch_count: 0 });
    Object.assign(entry, patch);
    try {
      fs.mkdirSync(path.dirname(usageFile), { recursive: true });
      fs.writeFileSync(usageFile, JSON.stringify(usage, null, 2), 'utf8');
    } catch {
      /* ignore */
    }
  }

  function pin(name, pinned = true) {
    if (!fs.existsSync(skillPath(name))) return { success: false, error: `skill ${name} not found` };
    patchUsage(name, { pinned: Boolean(pinned) });
    return { success: true, name, pinned: Boolean(pinned) };
  }

  /** 每个技能最近一次「被用/被看/被改」的时间，curator 用它判 stale。 */
  function activity() {
    const usage = readUsage();
    const entries = [];
    for (const skill of list()) {
      const entry = usage[skill.name] ?? {};
      const candidates = [entry.last_used_at, entry.last_viewed_at, entry.last_patched_at].filter(Boolean);
      let fallback;
      try {
        fallback = fs.statSync(skill.path).mtime.toISOString();
      } catch {
        fallback = new Date(0).toISOString();
      }
      const stamps = candidates.length > 0 ? candidates : [entry.created_at ?? fallback];
      const lastActivity = stamps.sort().at(-1) ?? fallback;
      entries.push({
        name: skill.name,
        path: skill.path,
        dir: path.dirname(skill.path),
        pinned: entry.pinned === true,
        state: entry.state ?? 'active',
        lastActivity,
        use_count: entry.use_count ?? 0,
        patch_count: entry.patch_count ?? 0,
      });
    }
    return entries;
  }

  function read(name) {
    const file = skillPath(name);
    if (!fs.existsSync(file)) return undefined;
    bumpUsage(name, 'view_count');
    return { name, path: file, text: fs.readFileSync(file, 'utf8') };
  }

  function create({ name, description, body }) {
    const problem = validateSkill({ name, description, body });
    if (problem) return { success: false, error: problem };
    const file = skillPath(name);
    if (fs.existsSync(file)) return { success: false, error: `skill ${name} already exists; use patch to edit it` };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, renderSkill({ name, description, body }), 'utf8');
    bumpUsage(name, 'use_count');
    return { success: true, name, path: file, note: 'Skill created. Edit with patch when it turns out to be wrong.' };
  }

  function patch({ name, oldString, newString, description, replaceAll = false }) {
    const file = skillPath(name);
    // 刻意不走 read()：改技能不该把 view_count 也算一次「看」。
    if (!fs.existsSync(file)) return { success: false, error: `skill ${name} not found; call skill_manage(action="create") first` };
    const current = { name, path: file, text: fs.readFileSync(file, 'utf8') };
    if (typeof oldString !== 'string' || oldString.length === 0) {
      return { success: false, error: 'old_string is required for patch (read the skill first, then copy the exact text)' };
    }
    const hits = current.text.split(oldString).length - 1;
    if (hits === 0) {
      return { success: false, error: 'old_string not found in SKILL.md; read the skill again and copy the exact text' };
    }
    if (hits > 1 && !replaceAll) {
      return {
        success: false,
        error: `old_string occurs ${hits} times; include more surrounding context to make it unique, or pass replace_all=true`,
      };
    }
    // 必须用函数式替换：字符串替换会把 new_string 里的 $& / $$ / $1 当成替换模式解释，
    // 技能正文里写 shell 片段（$1、$$）时会被静默写坏。
    const replacement = newString ?? '';
    const replaced = replaceAll
      ? current.text.split(oldString).join(replacement)
      : current.text.replace(oldString, () => replacement);
    const { meta, body } = parseFrontmatter(replaced);
    const nextDescription = description ?? meta.description;
    const problem = validateSkill({ name, description: nextDescription, body });
    if (problem) return { success: false, error: problem };
    fs.writeFileSync(current.path, replaced, 'utf8');
    bumpUsage(name, 'patch_count');
    return { success: true, name, path: current.path, replaced: hits };
  }

  function remove({ name, absorbedInto }) {
    const file = skillPath(name);
    if (!fs.existsSync(file)) return { success: false, error: `skill ${name} not found` };
    if (!absorbedInto || !absorbedInto.trim()) {
      return { success: false, error: 'absorbed_into is required: name the skill that now covers this one, or patch it instead of deleting' };
    }
    fs.rmSync(skillDir(name), { recursive: true, force: true });
    bumpUsage(name, 'use_count');
    return { success: true, name, absorbed_into: absorbedInto };
  }

  function writeFile({ name, filePath, content }) {
    const dir = skillDir(name);
    if (!fs.existsSync(path.join(dir, 'SKILL.md'))) {
      return { success: false, error: `skill ${name} not found; create it before adding files` };
    }
    const target = inside(path.join(dir, filePath));
    if (Buffer.byteLength(content ?? '', 'utf8') > 1024 * 1024) return { success: false, error: 'file must be at most 1 MiB' };
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content ?? '', 'utf8');
    return { success: true, name, path: target };
  }

  return {
    dir: root,
    list,
    read,
    create,
    patch,
    remove,
    writeFile,
    pin,
    activity,
    usage: readUsage,
    setUsage: patchUsage,
    hashFile: (target) => {
      try {
        return createHash('sha256').update(fs.readFileSync(target)).digest('hex');
      } catch {
        return undefined;
      }
    },
  };
}
