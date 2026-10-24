/**
 * `skill_manage` 工具的 DSH 定义（Phase 3 的「自我进化」半边）。
 *
 * 技能写到 `<skillsDir>/<name>/SKILL.md`，DSH 自带的 skills 提供方会在下一次
 * 目录失效后读到它们；本工具只负责「写」，读的技能索引仍归 DSH。
 */
import { MemoryError } from './store.js';

const DESCRIPTION = `Create and maintain reusable skills (procedural memory). A skill is a SKILL.md file with YAML frontmatter (name, description) plus instructions for a recurring task.

Use it when a workflow you just used will be needed again, when an existing skill turned out to be wrong, or when the user asks you to remember how to do something.

Rules:
1. Prefer patch over create: fix the skill you just used instead of adding a near-duplicate.
2. name must be kebab-case and unique; description must be short (<= 60 chars) — it is the only part shown in the skill index.
3. patch requires the exact old_string from the current file: read the skill first.
4. delete requires absorbed_into — name the skill that now covers this one.
5. pin a skill you rely on: pinned skills are never archived by the curator; status shows curator state.`;

const PARAMETERS = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['list', 'read', 'create', 'patch', 'delete', 'write_file', 'pin', 'unpin', 'status'],
      description: 'list = index of skills; read = full SKILL.md; create/patch/delete/write_file = edits; pin/unpin = protect from archiving; status = usage + curator state.',
    },
    name: { type: 'string', description: 'Skill name (kebab-case).' },
    description: { type: 'string', description: 'One-line description shown in the skill index (<= 60 chars).' },
    body: { type: 'string', description: 'SKILL.md body (markdown instructions) for create.' },
    old_string: { type: 'string', description: 'Exact text to replace (patch).' },
    new_string: { type: 'string', description: 'Replacement text (patch).' },
    absorbed_into: { type: 'string', description: 'Skill that now covers this one (required for delete).' },
    file_path: { type: 'string', description: 'Relative path inside the skill directory (write_file).' },
    file_content: { type: 'string', description: 'File content (write_file).' },
  },
  required: ['action'],
  additionalProperties: false,
};

function render(value) {
  return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }];
}

export function skillToolDefinition({ library, curator } = {}) {
  if (!library) throw new Error('skillToolDefinition requires a library');

  return {
    name: 'skill_manage',
    description: DESCRIPTION,
    parameters: PARAMETERS,
    output: { schema: { type: 'object' }, render: (_args, value) => render(value) },
    execute(args) {
      const input = args ?? {};
      try {
        switch (input.action) {
          case 'list': {
            const skills = library.list();
            return { success: true, count: skills.length, skills };
          }
          case 'read': {
            const skill = library.read(input.name);
            if (!skill) return { success: false, error: `skill ${input.name} not found` };
            return { success: true, ...skill };
          }
          case 'create':
            return library.create({ name: input.name, description: input.description, body: input.body });
          case 'patch':
            return library.patch({
              name: input.name,
              oldString: input.old_string,
              newString: input.new_string,
              description: input.description,
            });
          case 'delete':
            return library.remove({ name: input.name, absorbedInto: input.absorbed_into });
          case 'write_file':
            return library.writeFile({ name: input.name, filePath: input.file_path, content: input.file_content });
          case 'pin':
            return library.pin(input.name, true);
          case 'unpin':
            return library.pin(input.name, false);
          case 'status':
            return {
              success: true,
              dir: library.dir,
              usage: library.usage(),
              curator: curator?.state?.() ?? { available: false },
            };
          default:
            return {
              success: false,
              error: `Unknown action '${input.action}'. Use: list, read, create, patch, delete, write_file, pin, unpin, status.`,
            };
        }
      } catch (err) {
        if (err instanceof MemoryError) return { success: false, error: err.message, ...err.detail };
        return { success: false, error: err?.message ?? String(err) };
      }
    },
  };
}
