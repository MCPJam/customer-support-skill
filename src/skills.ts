/**
 * SEP-2640 "Skills Extension" server-side implementation.
 *
 * Implemented against modelcontextprotocol#2640 at commit
 * a3e147ca2710f68214247aecc729731ee1ae8d03 (see README).
 *
 * The MCP TypeScript SDK (1.30.0) has no high-level helper for this extension,
 * so the three methods are wired as low-level request handlers while keeping the
 * exact schemas from the SEP text.
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SKILLS_EXTENSION_ID = 'io.modelcontextprotocol/skills';

/** A file of a skill, as it appears in a skill entry's `resources` array. */
export interface SkillResourceEntry {
  uri: string;
  digest: string;
  size: number;
}

/** A skill entry, the shared shape of `skills/list[]` and `skills/get.skill`. */
export interface SkillEntry {
  uri: string;
  frontmatter: Record<string, unknown>;
  resources: SkillResourceEntry[];
}

interface SkillFile {
  uri: string;
  /** Path relative to the skill root, `/`-separated. */
  relativePath: string;
  absolutePath: string;
  bytes: Buffer;
  digest: string;
  size: number;
  mimeType: string;
}

interface LoadedSkill {
  name: string;
  skillPath: string;
  entry: SkillEntry;
  files: Map<string, SkillFile>;
  /** Directory URI -> direct children URIs. */
  directories: Map<string, string[]>;
  frontmatterDescription: string;
}

const MIME_TYPES: Record<string, string> = {
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.txt': 'text/plain',
  '.json': 'application/json',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.py': 'text/x-python',
  '.js': 'text/javascript',
  '.ts': 'text/plain',
  '.csv': 'text/csv'
};

export const DIRECTORY_MIME_TYPE = 'inode/directory';

function mimeTypeFor(relativePath: string): string {
  const dot = relativePath.lastIndexOf('.');
  if (dot === -1) return 'application/octet-stream';
  return MIME_TYPES[relativePath.slice(dot).toLowerCase()] ?? 'application/octet-stream';
}

function sha256(bytes: Buffer): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

/**
 * Minimal YAML frontmatter reader.
 *
 * Supports the subset the Agent Skills specification needs for this demo:
 * top-level scalars and one level of nested mapping (`metadata:`). It is
 * deliberately strict — anything it cannot parse throws rather than silently
 * producing frontmatter that would differ from the file, which the SEP forbids.
 */
export function parseFrontmatter(source: string): { frontmatter: Record<string, unknown>; body: string } {
  const normalized = source.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) {
    throw new Error('SKILL.md must begin with YAML frontmatter delimited by ---');
  }
  const end = normalized.indexOf('\n---\n', 3);
  if (end === -1) {
    throw new Error('Unterminated YAML frontmatter in SKILL.md');
  }
  const block = normalized.slice(4, end + 1);
  const body = normalized.slice(end + 5);

  const frontmatter: Record<string, unknown> = {};
  let currentNested: Record<string, unknown> | null = null;

  for (const rawLine of block.split('\n')) {
    if (rawLine.trim() === '' || rawLine.trimStart().startsWith('#')) continue;
    const indented = /^\s/.test(rawLine);
    const match = /^(\s*)([A-Za-z0-9_.\/-]+):\s*(.*)$/.exec(rawLine);
    if (!match) {
      throw new Error(`Unsupported YAML frontmatter line: ${rawLine}`);
    }
    const key = match[2]!;
    const value = match[3]!.trim();

    if (indented) {
      if (!currentNested) throw new Error(`Unexpected indented frontmatter line: ${rawLine}`);
      currentNested[key] = coerceScalar(value);
      continue;
    }

    if (value === '') {
      currentNested = {};
      frontmatter[key] = currentNested;
    } else {
      currentNested = null;
      frontmatter[key] = coerceScalar(value);
    }
  }
  return { frontmatter, body };
}

function coerceScalar(value: string): unknown {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null' || value === '~') return null;
  if (/^-?\d+$/.test(value)) return Number(value);
  return value;
}

/** Recursively collect files under `root`, returning `/`-separated relative paths. */
function walk(root: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const dirent of readdirSync(join(root, prefix), { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name)
  )) {
    if (dirent.name.startsWith('.')) continue;
    const relative = prefix === '' ? dirent.name : `${prefix}/${dirent.name}`;
    if (dirent.isDirectory()) {
      out.push(...walk(root, relative));
    } else if (dirent.isFile()) {
      out.push(relative);
    }
  }
  return out;
}

function loadSkill(skillDir: string): LoadedSkill {
  const skillMdPath = join(skillDir, 'SKILL.md');
  const skillMd = readFileSync(skillMdPath, 'utf8');
  const { frontmatter } = parseFrontmatter(skillMd);

  const name = frontmatter['name'];
  const description = frontmatter['description'];
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error(`${skillMdPath}: frontmatter is missing a string "name"`);
  }
  if (typeof description !== 'string' || description.length === 0) {
    throw new Error(`${skillMdPath}: frontmatter is missing a string "description"`);
  }

  // SEP-2640: the final <skill-path> segment MUST equal frontmatter.name.
  const skillPath = name;
  const base = `skill://${skillPath}`;

  const files = new Map<string, SkillFile>();
  const directories = new Map<string, string[]>([[base, []]]);

  for (const relativePath of walk(skillDir)) {
    const absolutePath = join(skillDir, relativePath);
    const bytes = readFileSync(absolutePath);
    const uri = `${base}/${relativePath}`;
    files.set(uri, {
      uri,
      relativePath,
      absolutePath,
      bytes,
      digest: sha256(bytes),
      size: bytes.byteLength,
      mimeType: mimeTypeFor(relativePath)
    });

    // Register the file and every intermediate directory as directory children.
    const segments = relativePath.split('/');
    let parent = base;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const childDir = `${parent}/${segments[i]}`;
      const siblings = directories.get(parent)!;
      if (!siblings.includes(childDir)) siblings.push(childDir);
      if (!directories.has(childDir)) directories.set(childDir, []);
      parent = childDir;
    }
    directories.get(parent)!.push(uri);
  }

  if (!files.has(`${base}/SKILL.md`)) {
    throw new Error(`${skillDir}: skill has no SKILL.md`);
  }

  // `resources` MUST be complete and MUST include the SKILL.md entry itself.
  const resources: SkillResourceEntry[] = [...files.values()]
    .sort((a, b) => (a.relativePath === 'SKILL.md' ? -1 : b.relativePath === 'SKILL.md' ? 1 : a.uri.localeCompare(b.uri)))
    .map(file => ({ uri: file.uri, digest: file.digest, size: file.size }));

  return {
    name,
    skillPath,
    frontmatterDescription: description,
    entry: { uri: `${base}/SKILL.md`, frontmatter, resources },
    files,
    directories
  };
}

/** Locate the repository's `skills/` directory from the compiled or source location. */
export function defaultSkillsRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i += 1) {
    const candidate = join(dir, 'skills');
    try {
      if (statSync(candidate).isDirectory() && statSync(join(candidate, 'handle-refund-request')).isDirectory()) {
        return candidate;
      }
    } catch {
      /* keep walking up */
    }
    dir = dirname(dir);
  }
  throw new Error('Could not locate the skills/ directory');
}

export class SkillRegistry {
  private skills: LoadedSkill[] = [];
  private byUri = new Map<string, LoadedSkill>();
  private fileIndex = new Map<string, SkillFile>();
  private directoryIndex = new Map<string, { uri: string; children: string[] }>();

  constructor(skillsRoot: string = defaultSkillsRoot()) {
    const root = resolve(skillsRoot);
    for (const dirent of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!dirent.isDirectory() || dirent.name.startsWith('.')) continue;
      const skill = loadSkill(join(root, dirent.name));
      if (skill.name !== dirent.name) {
        throw new Error(
          `${dirent.name}: frontmatter name "${skill.name}" must match the skill directory name (Agent Skills spec)`
        );
      }
      this.skills.push(skill);
      this.byUri.set(skill.entry.uri, skill);
      for (const [uri, file] of skill.files) this.fileIndex.set(uri, file);
      for (const [uri, children] of skill.directories) this.directoryIndex.set(uri, { uri, children });
    }
  }

  /** `skills/list`, with the base protocol's opaque-cursor pagination contract. */
  list(cursor: string | undefined, pageSize = 25): { skills: SkillEntry[]; nextCursor?: string } {
    let start = 0;
    if (cursor !== undefined) {
      const decoded = Number.parseInt(Buffer.from(cursor, 'base64url').toString('utf8'), 10);
      if (!Number.isInteger(decoded) || decoded < 0 || decoded > this.skills.length) {
        throw new InvalidSkillParams(`Invalid cursor: ${cursor}`);
      }
      start = decoded;
    }
    const page = this.skills.slice(start, start + pageSize);
    const end = start + page.length;
    const result: { skills: SkillEntry[]; nextCursor?: string } = {
      skills: page.map(skill => skill.entry)
    };
    if (end < this.skills.length) {
      result.nextCursor = Buffer.from(String(end), 'utf8').toString('base64url');
    }
    return result;
  }

  /** `skills/get`. Throws InvalidSkillParams when the URI is not a skill we serve. */
  get(uri: string): SkillEntry {
    const skill = this.byUri.get(uri);
    if (!skill) {
      throw new InvalidSkillParams(`No skill is served at ${uri}`);
    }
    return skill.entry;
  }

  /**
   * Resolve a readable resource URI.
   *
   * Only URIs present in a skill manifest resolve. Anything else — an undeclared
   * file, an absolute path, a `../` traversal attempt — misses the map and is
   * rejected, so no filesystem path is ever constructed from client input.
   */
  readFile(uri: string): SkillFile {
    const file = this.fileIndex.get(uri);
    if (!file) {
      throw new InvalidSkillParams(`Resource not found: ${uri}`);
    }
    return file;
  }

  /** Resource metadata for every skill file, for `resources/list`. */
  listResources(): Array<{ uri: string; name: string; title?: string; description?: string; mimeType: string }> {
    const out: Array<{ uri: string; name: string; title?: string; description?: string; mimeType: string }> = [];
    for (const skill of this.skills) {
      for (const file of skill.files.values()) {
        const isSkillMd = file.relativePath === 'SKILL.md';
        out.push({
          uri: file.uri,
          // SEP-2640 Resource Metadata: SKILL.md takes its name/description from frontmatter.
          name: isSkillMd ? skill.name : file.relativePath,
          ...(isSkillMd ? { description: skill.frontmatterDescription } : {}),
          mimeType: file.mimeType
        });
      }
    }
    return out;
  }

  /** `resources/directory/read`. */
  readDirectory(uri: string): Array<{ uri: string; name: string; mimeType: string }> {
    const dir = this.directoryIndex.get(uri);
    if (!dir) {
      throw new InvalidSkillParams(`Not a directory resource: ${uri}`);
    }
    return dir.children.map(childUri => {
      const name = childUri.slice(uri.length + 1);
      const file = this.fileIndex.get(childUri);
      return { uri: childUri, name, mimeType: file ? file.mimeType : DIRECTORY_MIME_TYPE };
    });
  }

  get size(): number {
    return this.skills.length;
  }
}

/** Maps to JSON-RPC -32602, the code the SEP requires for unknown skills/resources. */
export class InvalidSkillParams extends Error {}
