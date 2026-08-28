'use strict';

const express = require('express');
const { executeQuery } = require('../database');

const router = express.Router();

// Limites do dia no fuso de São Paulo, em UTC, calculados no JS para o
// SQL ficar portátil (registrado_em >= $2 AND registrado_em < $3).
function limitesDeHoje() {
  const fmt = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Sao_Paulo' });
  const hoje = fmt.format(new Date()); // AAAA-MM-DD

  // Offset atual do fuso em relação ao UTC (ex.: -03:00 / -02:00).
  const partes = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Sao_Paulo', timeZoneName: 'longOffset',
  }).formatToParts(new Date());
  const offset = (partes.find(p => p.type === 'timeZoneName') || {}).value || 'GMT-03:00';
  const m = offset.match(/GMT([+-]\d{2}):(\d{2})/);
  const offsetTexto = m ? `${m[1]}:${m[2]}` : '-03:00';

  const inicio = new Date(`${hoje}T00:00:00${offsetTexto}`);
  const fim = new Date(inicio.getTime() + 24 * 60 * 60 * 1000);
  return { inicio: inicio.toISOString(), fim: fim.toISOString() };
}

router.get('/', async (req, res, next) => {
  try {
    const { inicio, fim } = limitesDeHoje();
    const empresaId = req.usuario.empresa_id;

    const hoje = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Sao_Paulo' }).format(new Date());

    const [banhosHoje, agendadosHoje, retiradasHoje, pacotesAtivos, acabando, clientes] = await Promise.all([
      executeQuery(
        `SELECT COUNT(*)::int AS total FROM baixas
          WHERE empresa_id = $1 AND estornada = FALSE
            AND registrado_em >= $2 AND registrado_em < $3`,
        [empresaId, inicio, fim]
      ),
      executeQuery(
        `SELECT COUNT(*)::int AS total FROM agendamentos
          WHERE empresa_id = $1 AND data = $2 AND tipo = 'SERVICO'
            AND status IN ('AGENDADO', 'CONCLUIDO')`,
        [empresaId, hoje]
      ),
      executeQuery(
        `SELECT COUNT(*)::int AS total FROM agendamentos
          WHERE empresa_id = $1 AND data = $2 AND tipo IN ('BUSCA', 'ENTREGA')
            AND status = 'AGENDADO'`,
        [empresaId, hoje]
      ),
      executeQuery(
        `SELECT COUNT(*)::int AS total FROM pacotes
          WHERE empresa_id = $1 AND status = 'ATIVO'`,
        [empresaId]
      ),
      executeQuery(
        `SELECT COUNT(*)::int AS total FROM pacotes
          WHERE empresa_id = $1 AND status = 'ATIVO' AND saldo <= 3`,
        [empresaId]
      ),
      executeQuery(
        `SELECT COUNT(*)::int AS total FROM clientes
          WHERE empresa_id = $1 AND ativo`,
        [empresaId]
      ),
    ]);

    res.json({
      banhos_hoje: banhosHoje.recordset[0].total,
      agendados_hoje: agendadosHoje.recordset[0].total,
      retiradas_hoje: retiradasHoje.recordset[0].total,
      pacotes_ativos: pacotesAtivos.recordset[0].total,
      saldos_acabando: acabando.recordset[0].total,
      clientes_ativos: clientes.recordset[0].total,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
