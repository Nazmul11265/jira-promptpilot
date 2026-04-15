/**
 * Workspace Tools
 * ───────────────
 * search_workspace  — full-text search across project files
 * read_file         — read a specific file (with optional line range)
 *
 * Security: all paths are resolved and validated to stay within workspaceRoot.
 */

import { readFileSync, existsSync, statSync } from 'fs';
import { resolve, extname, sep } from 'path';
import { glob } from 'glob';

// ─── Constants ────────────────────────────────────────────────────────────────

const IGNORED_PATTERNS = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/build/**',
  '**/.next/**',
  '**/coverage/**',
  '**/.vscode/**',
  '**/*.min.js',
  '**/*.map',
];

const TEXT_EXTENSIONS = new Set([
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs',
  '.py', '.java', '.go', '.rs', '.rb', '.php', '.cs', '.cpp', '.c', '.h',
  '.css', '.scss', '.sass', '.less',
  '.html', '.htm', '.vue', '.svelte',
  '.json', '.yaml', '.yml', '.toml', '.env',
  '.md', '.mdx', '.txt', '.sh', '.bash',
  '.graphql', '.gql', '.prisma', '.sql',
]);

const MAX_FILE_SIZE_BYTES = 512 * 1024; // 512 KB
const MAX_SEARCH_RESULTS = 10;
const MAX_MATCHES_PER_FILE = 8;

// ─── search_workspace ─────────────────────────────────────────────────────────

export async function searchWorkspace(query, filePattern, workspaceRoot) {
  const resolvedRoot = resolve(workspaceRoot);
  const pattern = filePattern || '**/*';
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 1);

  if (terms.length === 0) {
    return { error: 'Query must contain at least one term with 2+ characters.', results: [] };
  }

  let allFiles;
  try {
    allFiles = await glob(pattern, {
      cwd: resolvedRoot,
      ignore: IGNORED_PATTERNS,
      nodir: true,
      dot: false,
    });
  } catch (err) {
    return { error: `Glob error: ${err.message}`, results: [] };
  }

  // Restrict to text files
  const files = allFiles.filter((f) => {
    const ext = extname(f).toLowerCase();
    return TEXT_EXTENSIONS.has(ext) || ext === '';
  });

  const results = [];

  for (const relPath of files) {
    if (results.length >= MAX_SEARCH_RESULTS) break;

    const fullPath = resolve(resolvedRoot, relPath);

    try {
      const stat = statSync(fullPath);
      if (stat.size > MAX_FILE_SIZE_BYTES) continue;

      const content = readFileSync(fullPath, 'utf-8');
      const lines = content.split('\n');

      const matchingLines = [];
      for (let i = 0; i < lines.length; i++) {
        const lower = lines[i].toLowerCase();
        if (terms.some((t) => lower.includes(t))) {
          matchingLines.push({ line: i + 1, content: lines[i].trimEnd() });
          if (matchingLines.length >= MAX_MATCHES_PER_FILE) break;
        }
      }

      if (matchingLines.length > 0) {
        results.push({ file: relPath, matches: matchingLines });
      }
    } catch {
      // skip unreadable files silently
    }
  }

  return {
    query,
    total_files_searched: files.length,
    results,
  };
}

// ─── read_file ────────────────────────────────────────────────────────────────

export function readWorkspaceFile(filePath, workspaceRoot, startLine, endLine) {
  const resolvedRoot = resolve(workspaceRoot);
  const fullPath = resolve(resolvedRoot, filePath);

  // Security: block path traversal
  if (!fullPath.startsWith(resolvedRoot + sep) && fullPath !== resolvedRoot) {
    throw new Error('Access denied: path must remain within the workspace root.');
  }

  if (!existsSync(fullPath)) {
    return { error: `File not found: ${filePath}` };
  }

  const stat = statSync(fullPath);

  if (stat.size > MAX_FILE_SIZE_BYTES) {
    return {
      error:
        `File is ${Math.round(stat.size / 1024)} KB — too large to read in full. ` +
        `Use start_line and end_line to read a specific section.`,
      total_size_kb: Math.round(stat.size / 1024),
    };
  }

  const content = readFileSync(fullPath, 'utf-8');
  const lines = content.split('\n');

  const start = startLine != null ? Math.max(0, startLine - 1) : 0;
  const end = endLine != null ? Math.min(lines.length, endLine) : lines.length;

  return {
    file: filePath,
    total_lines: lines.length,
    shown_range: `${start + 1}-${end}`,
    content: lines.slice(start, end).join('\n'),
  };
}
