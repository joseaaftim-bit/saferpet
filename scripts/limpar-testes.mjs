// Apaga os petshops criados por scripts/testar-api.mjs --completo
// (nome contém "(TESTE)"). Precisa da DATABASE_URL do ambiente:
//
//   DATABASE_URL="postgres://..." node scripts/limpar-testes.mjs
//   DATABASE_URL="postgres://..." node scripts/limpar-testes.mjs --aplicar
//
// Sem --aplicar só LISTA o que seria apagado.

import pg from 'pg';

const aplicar = process.argv.includes('--aplicar');
const url = process.env.DATABASE_URL;

if (!url) {
  console.error('Defina DATABASE_URL (pegue no serviço Postgres do Railway).');
  process.exit(1);
}

const pool = new pg.Pool({
  connectionString: url,
  ssl: url.includes('localhost') ? undefined : { rejectUnauthorized: false },
});

const alvos = await pool.query(
  `SELECT id, nome, criado_em FROM empresas WHERE nome LIKE '%(TESTE)%' ORDER BY id`
);

if (!alvos.rows.length) {
  console.log('Nenhum petshop de teste encontrado.');
  await pool.end();
  process.exit(0);
}

console.log(`${alvos.rows.length} petshop(s) de teste:`);
for (const e of alvos.rows) {
  console.log(`  [${e.id}] ${e.nome} — criado em ${new Date(e.criado_em).toLocaleString('pt-BR')}`);
}

if (!aplicar) {
  console.log('\nNada foi apagado. Rode com --aplicar para remover.');
  await pool.end();
  process.exit(0);
}

const ids = alvos.rows.map(e => e.id);
const cliente = await pool.connect();
try {
  await cliente.query('BEGIN');
  // Ordem respeita as chaves estrangeiras.
  for (const tabela of ['baixas', 'agendamentos', 'pacotes_itens', 'pacotes',
                        'pacotes_modelo_itens', 'pacotes_modelo', 'agenda_excecoes',
                        'agenda_horarios', 'recursos', 'servicos', 'pets',
                        'clientes', 'usuarios']) {
    const r = await cliente.query(`DELETE FROM ${tabela} WHERE empresa_id = ANY($1::int[])`, [ids]);
    if (r.rowCount) console.log(`  ${tabela}: ${r.rowCount} linha(s)`);
  }
  const r = await cliente.query('DELETE FROM empresas WHERE id = ANY($1::int[])', [ids]);
  console.log(`  empresas: ${r.rowCount} linha(s)`);
  await cliente.query('COMMIT');
  console.log('\nLimpeza concluída.');
} catch (err) {
  await cliente.query('ROLLBACK').catch(() => {});
  console.error('Falha na limpeza:', err.message);
  process.exitCode = 1;
} finally {
  cliente.release();
  await pool.end();
}
