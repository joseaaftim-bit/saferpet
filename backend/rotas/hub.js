'use strict';

// Métricas agregadas para o Safer Hub. Cross-tenant por natureza, por
// isso fecha por padrão: sem HUB_TOKEN configurado responde 503; token
// errado responde 401. Nunca devolve dado de cliente final, só contagens.

const express = require('express');
const crypto = require('crypto');
const { executeQuery } = require('../database');
const { HUB_TOKEN } = require('../config/segredos');

const router = express.Router();

function tokenConfere(recebido) {
  if (!recebido || !HUB_TOKEN) return false;
  const a = Buffer.from(String(recebido));
  const b = Buffer.from(HUB_TOKEN);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

router.get('/metrics', async (req, res, next) => {
  try {
    if (!HUB_TOKEN) {
      return res.status(503).json({ erro: 'Hub não configurado neste ambiente.' });
    }
    const cabecalho = req.headers.authorization || '';
    const recebido = cabecalho.startsWith('Bearer ') ? cabecalho.slice(7) : null;
    if (!tokenConfere(recebido)) {
      return res.status(401).json({ erro: 'Não autorizado.' });
    }

    const [empresas, vigentes, clientes, pacotes, baixas30d] = await Promise.all([
      executeQuery('SELECT COUNT(*)::int AS total FROM empresas WHERE ativo'),
      executeQuery('SELECT COUNT(*)::int AS total FROM empresas WHERE ativo AND acesso_ate >= NOW()'),
      executeQuery('SELECT COUNT(*)::int AS total FROM clientes WHERE ativo'),
      executeQuery(`SELECT COUNT(*)::int AS total FROM pacotes WHERE status = 'ATIVO'`),
      executeQuery(
        'SELECT COUNT(*)::int AS total FROM baixas WHERE estornada = FALSE AND registrado_em >= $1',
        [new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()]
      ),
    ]);

    res.json({
      produto: 'SaferPet',
      empresas: empresas.recordset[0].total,
      empresas_com_acesso_vigente: vigentes.recordset[0].total,
      clientes: clientes.recordset[0].total,
      pacotes_ativos: pacotes.recordset[0].total,
      banhos_30_dias: baixas30d.recordset[0].total,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
