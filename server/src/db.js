import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, '..', 'data');
const file = path.join(dataDir, 'database.json');

const empty = {
  users: [],
  championships: [],
  teams: [],
  matches: [],
  submissions: [],
  notifications: [],
  celebrationViews: []
};

fs.mkdirSync(dataDir, { recursive: true });
if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(empty, null, 2));

export function readDb() {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function writeDb(db) {
  fs.writeFileSync(file, JSON.stringify(db, null, 2));
  return db;
}

export function id(prefix='id') {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
}
