import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, '..', '..');
const skillsDir = path.join(packageRoot, 'skills');
const agentsDir = path.join(packageRoot, 'agents');

export const PolygraphPlugin = async () => {
  const agents = loadAgents();

  return {
    config: async (cfg) => {
      cfg.skills ??= {};
      cfg.skills.paths ??= [];
      if (!cfg.skills.paths.includes(skillsDir)) {
        cfg.skills.paths.push(skillsDir);
      }

      cfg.agent ??= {};
      for (const [name, agent] of Object.entries(agents)) {
        cfg.agent[name] = agent;
      }
    },
  };
};

export default PolygraphPlugin;

function loadAgents() {
  if (!existsSync(agentsDir)) {
    return {};
  }

  const result = {};
  for (const entry of readdirSync(agentsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;

    const name = path.basename(entry.name, '.md');
    const raw = readFileSync(path.join(agentsDir, entry.name), 'utf8');
    const { data, content } = parseFrontmatter(raw);
    const description = stringValue(data.description);
    if (!description) {
      throw new Error(`OpenCode agent ${entry.name} must define a description`);
    }

    result[name] = {
      mode: stringValue(data.mode) || 'subagent',
      description,
      prompt: content.trim(),
      ...(stringValue(data.color) ? { color: stringValue(data.color) } : {}),
      ...(booleanValue(data.hidden) === undefined ? {} : { hidden: booleanValue(data.hidden) }),
      ...(numberValue(data.steps) === undefined ? {} : { steps: numberValue(data.steps) }),
      ...(recordValue(data.permission) ? { permission: recordValue(data.permission) } : {}),
    };
  }

  return result;
}

function parseFrontmatter(raw) {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) {
    return { data: {}, content: raw };
  }

  return {
    data: parseSimpleYaml(match[1]),
    content: match[2],
  };
}

function parseSimpleYaml(raw) {
  const root = {};
  const stack = [{ indent: -1, value: root }];

  for (const line of raw.split('\n')) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;

    const indent = line.match(/^\s*/)[0].length;
    const trimmed = line.trim();
    const separatorIndex = trimmed.indexOf(':');
    if (separatorIndex === -1) continue;

    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const valueText = trimmed.slice(separatorIndex + 1).trim();
    const parent = stack[stack.length - 1].value;

    if (!valueText) {
      const child = {};
      parent[key] = child;
      stack.push({ indent, value: child });
      continue;
    }

    parent[key] = parseScalar(valueText);
  }

  return root;
}

function parseScalar(value) {
  const unquoted = value.replace(/^['"]|['"]$/g, '');
  if (unquoted === 'true') return true;
  if (unquoted === 'false') return false;
  if (/^-?\d+$/.test(unquoted)) return Number(unquoted);
  return unquoted;
}

function stringValue(value) {
  return typeof value === 'string' ? value : undefined;
}

function booleanValue(value) {
  return typeof value === 'boolean' ? value : undefined;
}

function numberValue(value) {
  return Number.isSafeInteger(value) ? value : undefined;
}

function recordValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}
