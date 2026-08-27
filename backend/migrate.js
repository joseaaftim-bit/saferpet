'use strict';

const fs = require('fs');
const path = require('path');

// Runner de migrations com tabela de controle: cada arquivo roda uma única
// vez, dentro de uma transação, e fica registrado em schema_migrations.

const DIR = path.join(__dirname, '..', 'migrations');

async function garantirTabelaControle(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      versao      VARCHAR(255) PRIMARY KEY,
      aplicada_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function jaAplicadas(pool) {
  const r = await pool.query('SELECT versao FROM schema_migrations');
  return new Set(r.rows.map(x => x.versao));
}

function listarMigrations() {
  return fs.readdirSync(DIR)
    .filter(f => f.endsWith('.sql'))
    .sort();
}

async function migrar(pool) {
  await garantirTabelaControle(pool);
  const aplicadas = await jaAplicadas(pool);
  const pendentes = listarMigrations().filter(f => !aplicadas.has(f));

  if (!pendentes.length) {
    console.log('[migrate] Schema atualizado — nenhuma migration pendente.');
    return;
  }

  console.log(`[migrate] ${pendentes.length} migration(s) pendente(s).`);

  for (const arquivo of pendentes) {
    const sql = fs.readFileSync(path.join(DIR, arquivo), 'utf-8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query(
        'INSERT INTO schema_migrations (versao) VALUES ($1) ON CONFLICT DO NOTHING',
        [arquivo]
      );
      await client.query('COMMIT');
      console.log(`[migrate] OK ${arquivo}`);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error(`[migrate] FALHA ${arquivo}: ${err.message}`);
      throw err;
    } finally {
      client.release();
    }
  }

  console.log('[migrate] Migrations concluídas.');
}

module.exports = { migrar };

// Permite rodar como passo separado: `node backend/migrate.js`
if (require.main === module) {
  require('dotenv').config({ path: path.resolve(__dirname, 'config', '.env') });
  const { getPool, closePool } = require('./database');

  Promise.resolve(getPool())
    .then(migrar)
    .then(() => closePool())
    .then(() => process.exit(0))
    .catch(err => {
      console.error('[migrate] Falha:', err.message);
      process.exit(1);
    });
}
