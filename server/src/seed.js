import bcrypt from 'bcryptjs';
import { readDb, writeDb, id } from './db.js';

const db = readDb();
if (!db.users.some(u => u.role === 'admin')) {
  db.users.push({
    id: id('usr'), name:'Administrador', role:'admin', username:'admin',
    passwordHash:await bcrypt.hash('admin123',10), recoveryKeyHash:null,
    createdAt:new Date().toISOString(), mustChangeCredentials:true,
    displayName:'Administrador', teamId:null, playerId:null
  });
  writeDb(db);
  console.log('Administrador criado: admin / admin123');
} else console.log('Administrador já existe.');
