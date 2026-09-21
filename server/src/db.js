import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, '..', 'data');
const file = path.join(dataDir, 'database.json');

export const emptyDb = {
  schemaVersion: 6,
  users: [],
  players: [],
  championships: [],
  participations: [],
  teams: [],
  phases: [],
  matches: [],
  submissions: [],
  titles: [],
  notifications: [],
  celebrationViews: []
};

fs.mkdirSync(dataDir, { recursive: true });
if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(emptyDb, null, 2));

function normalize(db) {
  const base = structuredClone(emptyDb);
  const out = { ...base, ...(db || {}) };
  for (const key of Object.keys(base)) if (!Array.isArray(base[key]) && out[key] == null) out[key] = base[key];
  for (const key of Object.keys(base)) if (Array.isArray(base[key]) && !Array.isArray(out[key])) out[key] = [];
  out.schemaVersion = 6;
  return out;
}

export function readDb() {
  try { return normalize(JSON.parse(fs.readFileSync(file, 'utf8'))); }
  catch { return structuredClone(emptyDb); }
}

export function writeDb(db) {
  const normalized = normalize(db);
  fs.writeFileSync(file, JSON.stringify(normalized, null, 2));
  return normalized;
}

export function id(prefix='id') {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
}
