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

  // A cada 10 minutos: recupera pagamentos cujo webhook se perdeu e
  // devolve o estoque de carrinhos abandonados.
  jobs.push(
    cron.schedule('*/10 * * * *', () => {
      const pagamentos = require('../rotas/pagamentos');
      // Reconciliar ANTES de expirar: um pagamento que chegou sem webhook
      // não pode ter o pedido cancelado embaixo dele.
      const assinatura = require('../rotas/assinatura');
      pagamentos.reconciliarPendentes()
        .then(() => pagamentos.expirarPedidosAbandonados())
        .then(() => assinatura.reconciliarAssinaturas())
        .catch(err => console.error('[jobs] Falha no ciclo de pagamentos:', err.message));
    }, { timezone: 'America/Sao_Paulo' })
  );

  console.log('[jobs] Agendados: pacotes vencidos (03:15) e reconciliação de pagamentos (10 em 10 min).');

  // Roda uma vez no boot: recupera execuções perdidas do cron (deploy ou
  // queda no horário agendado).
  marcarPacotesVencidos().catch(err => console.error('[jobs] Falha ao marcar vencidos no boot:', err));
}

function pararJobs() {
  while (jobs.length) jobs.pop().stop();
}

module.exports = { iniciarJobs, pararJobs, marcarPacotesVencidos };
