import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';
import pg from 'pg';

const { Pool } = pg;

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

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

let dbCache = null;
let writeQueue = Promise.resolve();

fs.mkdirSync(dataDir, { recursive: true });

if (!fs.existsSync(file)) {
  fs.writeFileSync(file, JSON.stringify(empty, null, 2));
}

function localDb() {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return structuredClone(empty);
  }
}

export async function initializeDb() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL não foi configurada no arquivo .env');
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS champions_amigos_state (
      id INTEGER PRIMARY KEY,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const result = await pool.query(
    'SELECT data FROM champions_amigos_state WHERE id = 1'
  );

  if (result.rows.length === 0) {
    dbCache = localDb();

    await pool.query(
      `INSERT INTO champions_amigos_state (id, data)
       VALUES (1, $1::jsonb)`,
      [JSON.stringify(dbCache)]
    );

    console.log('Banco Neon inicializado com os dados locais.');
  } else {
    dbCache = result.rows[0].data;
    console.log('Banco Neon conectado com sucesso.');
  }

  return dbCache;
}

export function readDb() {
  if (!dbCache) {
    throw new Error('Banco ainda não foi inicializado.');
  }

  return dbCache;
}

export async function writeDb(db) {
  dbCache = db;

  fs.writeFileSync(file, JSON.stringify(dbCache, null, 2));

  const dataToSave = JSON.stringify(dbCache);

  writeQueue = writeQueue
    .then(() =>
      pool.query(
        `INSERT INTO champions_amigos_state (id, data, updated_at)
         VALUES (1, $1::jsonb, NOW())
         ON CONFLICT (id)
         DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
        [dataToSave]
      )
    )
    .catch(err => {
      console.error('Erro ao salvar no PostgreSQL:', err.message);
      throw err;
    });

  return writeQueue;
}

export async function flushDb() {
  await writeQueue;
}

export function id(prefix = 'id') {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}