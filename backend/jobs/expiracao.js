'use strict';

const cron = require('node-cron');
const { executeQuery } = require('../database');
const { hojeSaoPaulo } = require('../util/datas');

// Guardar referência de TODOS os jobs para poder pará-los (regra da casa).
const jobs = [];

// Marca como VENCIDO todo pacote ATIVO com validade estourada — de TODAS
// as empresas, sem filtro de plano (armadilha conhecida do cron que nasce
// olhando um plano só).
async function marcarPacotesVencidos() {
  const r = await executeQuery(
    `UPDATE pacotes SET status = 'VENCIDO'
      WHERE status = 'ATIVO' AND validade_ate IS NOT NULL AND validade_ate < $1`,
    [hojeSaoPaulo()]
  );
  const total = r.rowsAffected[0] || 0;
  if (total > 0) console.log(`[jobs] ${total} pacote(s) marcados como vencidos.`);
}

function iniciarJobs() {
  pararJobs();
  jobs.push(
    cron.schedule('15 3 * * *', () => {
      marcarPacotesVencidos().catch(err => console.error('[jobs] Falha ao marcar vencidos:', err));
    }, { timezone: 'America/Sao_Paulo' })
  );
  console.log('[jobs] Agendado: pacotes vencidos (03:15 America/Sao_Paulo).');

  // Roda uma vez no boot: recupera execuções perdidas do cron (deploy ou
  // queda no horário agendado).
  marcarPacotesVencidos().catch(err => console.error('[jobs] Falha ao marcar vencidos no boot:', err));
}

function pararJobs() {
  while (jobs.length) jobs.pop().stop();
}

module.exports = { iniciarJobs, pararJobs, marcarPacotesVencidos };
