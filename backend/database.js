'use strict';

const { Pool, types } = require('pg');

// Colunas DATE chegam como string 'AAAA-MM-DD' (OID 1082), nunca como
// objeto Date — comparações de validade e o JSON do front dependem disso.
types.setTypeParser(1082, valor => valor);

let pool = null;

function getPool() {
  if (!pool) {
    if (process.env.DATABASE_URL) {
      pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
      });
    } else {
      pool = new Pool({
        host: process.env.PGHOST || 'localhost',
        port: parseInt(process.env.PGPORT || '5432', 10),
        database: process.env.PGDATABASE || 'saferpet',
        user: process.env.PGUSER || 'postgres',
        password: process.env.PGPASSWORD || 'postgres',
      });
    }
  }
  return pool;
}

// Usado pela bateria de testes locais (pg-mem) para trocar o pool.
function injetarPoolParaTestes(poolFalso) {
  pool = poolFalso;
}

/**
 * Interface padrão da casa: retorna { recordset, rowsAffected }.
 * SQL sempre parametrizado com $1, $2, ...
 */
async function executeQuery(sql, params = []) {
  const result = await getPool().query(sql, params);
  return { recordset: result.rows, rowsAffected: [result.rowCount] };
}

/**
 * Executa `fn` dentro de uma transação. `fn` recebe um `query(sql, params)`
 * amarrado ao client da transação; qualquer exceção dispara ROLLBACK.
 */
async function comTransacao(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const query = async (sql, params = []) => {
      const result = await client.query(sql, params);
      return { recordset: result.rows, rowsAffected: [result.rowCount] };
    };
    const retorno = await fn(query);
    await client.query('COMMIT');
    return retorno;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

module.exports = { getPool, executeQuery, comTransacao, closePool, injetarPoolParaTestes };
