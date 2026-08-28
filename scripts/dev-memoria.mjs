// Sobe o SaferPet com Postgres em memória (pg-mem) para desenvolvimento
// e teste visual local, SEM banco instalado: node scripts/dev-memoria.mjs
// Nada é persistido — ao derrubar o processo, os dados somem.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'segredo-dev-memoria';
process.env.APP_URL = 'http://localhost:4600';

import { createRequire } from 'module';
import { readFileSync, readdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { newDb } from 'pg-mem';

const require = createRequire(import.meta.url);
const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const db = newDb();

// pg-mem não entende FOR UPDATE: remove no MESMO client (interceptQueries
// executaria fora da transação e quebraria o ROLLBACK).
function removerForUpdate(sql) {
  const m = /^([\s\S]*?)\s+FOR\s+UPDATE(\s+OF\s+[\w,\s]+)?\s*;?\s*$/i.exec(sql);
  return m ? m[1] : sql;
}
// O adaptador ignora ROLLBACK: emulamos com backup/restore do pg-mem.
function embrulharPool(poolReal) {
  return {
    query: (sql, params) => poolReal.query(removerForUpdate(sql), params),
    connect: async () => {
      const cliente = await poolReal.connect();
      let snapshot = null;
      return {
        query: (sql, params) => {
          const comando = String(sql).trim().toUpperCase();
          if (comando === 'BEGIN') { snapshot = db.backup(); return Promise.resolve({ rows: [], rowCount: 0 }); }
          if (comando === 'ROLLBACK') {
            if (snapshot) { snapshot.restore(); snapshot = null; }
            return Promise.resolve({ rows: [], rowCount: 0 });
          }
          if (comando === 'COMMIT') { snapshot = null; return Promise.resolve({ rows: [], rowCount: 0 }); }
          return cliente.query(removerForUpdate(sql), params);
        },
        release: () => cliente.release(),
      };
    },
    end: () => poolReal.end(),
  };
}

const { Pool } = db.adapters.createPg();
const database = require(path.join(raiz, 'backend', 'database.js'));
database.injetarPoolParaTestes(embrulharPool(new Pool()));

for (const arquivo of readdirSync(path.join(raiz, 'migrations')).filter(f => f.endsWith('.sql')).sort()) {
  const sql = readFileSync(path.join(raiz, 'migrations', arquivo), 'utf-8')
    .split('Migração de dados existentes')[0]
    .split('\n').filter(linha => !/^\s*CREATE INDEX/i.test(linha)).join('\n')
    .replace(/ADD COLUMN IF NOT EXISTS/gi, 'ADD COLUMN');
  await database.getPool().query(sql);
}

const { app } = require(path.join(raiz, 'backend', 'server.js'));
const porta = parseInt(process.env.PORT || '4600', 10);
app.listen(porta, () => console.log(`[dev] SaferPet em memória na porta ${porta}.`));
