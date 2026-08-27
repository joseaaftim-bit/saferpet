// Sobe o SaferPet com Postgres em memória (pg-mem) para desenvolvimento
// e teste visual local, SEM banco instalado: node scripts/dev-memoria.mjs
// Nada é persistido — ao derrubar o processo, os dados somem.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'segredo-dev-memoria';
process.env.APP_URL = 'http://localhost:4600';

import { createRequire } from 'module';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { newDb } from 'pg-mem';

const require = createRequire(import.meta.url);
const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const db = newDb();
db.public.interceptQueries((sql) => {
  const m = /^([\s\S]*?)\s+FOR\s+UPDATE(\s+OF\s+[\w,\s]+)?\s*;?\s*$/i.exec(sql);
  if (m) return db.public.query(m[1]).rows;
  return null;
});

const { Pool } = db.adapters.createPg();
const database = require(path.join(raiz, 'backend', 'database.js'));
database.injetarPoolParaTestes(new Pool());

const esquema = readFileSync(path.join(raiz, 'migrations', '001-esquema.sql'), 'utf-8')
  .split('\n')
  .filter(linha => !/^\s*CREATE INDEX/i.test(linha))
  .join('\n');
await database.getPool().query(esquema);

const { app } = require(path.join(raiz, 'backend', 'server.js'));
const porta = parseInt(process.env.PORT || '4600', 10);
app.listen(porta, () => console.log(`[dev] SaferPet em memória na porta ${porta}.`));
