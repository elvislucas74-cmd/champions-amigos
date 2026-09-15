import bcrypt from 'bcryptjs';
import { readDb, writeDb, id } from './db.js';

const db = readDb();
if (!db.users.some(u => u.username === 'admin')) {
  db.users.push({
    id: id('usr'),
    name: 'Administrador',
    username: 'admin',
    passwordHash: await bcrypt.hash('admin123', 10),
    role: 'admin',
    teamId: null,
    createdAt: new Date().toISOString(),
    mustChangeCredentials: true,
    displayName: 'Administrador'
  });
  writeDb(db);
  console.log('Administrador criado: admin / admin123');
} else {
  console.log('Administrador já existe.');
}
