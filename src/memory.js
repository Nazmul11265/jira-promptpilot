/**
 * Cross-run Memory
 * ────────────────
 * Persists per-ticket investigation findings to
 * {workspaceRoot}/.promptpilot/memory.json so the agent can
 * recall what it already discovered across separate runs.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { resolve, join } from 'path';

const MEMORY_DIR  = '.promptpilot';
const MEMORY_FILE = 'memory.json';

function memoryPath(workspaceRoot) {
  return join(resolve(workspaceRoot), MEMORY_DIR, MEMORY_FILE);
}

function readAll(workspaceRoot) {
  const p = memoryPath(workspaceRoot);
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, 'utf-8'));
  } catch {
    return {};
  }
}

/** Returns the stored findings for ticketId, or null if never investigated. */
export function loadTicketMemory(ticketId, workspaceRoot) {
  return readAll(workspaceRoot)[ticketId] ?? null;
}

/** Persists investigation data for ticketId to disk. */
export function saveTicketMemory(ticketId, data, workspaceRoot) {
  try {
    const dir = join(resolve(workspaceRoot), MEMORY_DIR);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const all = readAll(workspaceRoot);
    all[ticketId] = { ...data, lastUpdated: new Date().toISOString() };
    writeFileSync(memoryPath(workspaceRoot), JSON.stringify(all, null, 2), 'utf-8');
    console.error(`[Memory] Saved findings for ${ticketId}`);
  } catch (err) {
    console.error(`[Memory] Could not save: ${err.message}`);
  }
}
