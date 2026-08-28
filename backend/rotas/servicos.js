'use strict';

const express = require('express');
const { executeQuery } = require('../database');
const { somenteAdmin } = require('../middlewares/autenticacao');

const router = express.Router();

function validarCorpo(corpo) {
  const nome = String((corpo || {}).nome || '').trim();
  const duracao = parseInt((corpo || {}).duracao_minutos, 10);
  const preco = parseInt((corpo || {}).preco_centavos, 10);
  if (!nome || !Number.isInteger(duracao) || duracao <= 0 || duracao > 8 * 60 ||
      !Number.isInteger(preco) || preco < 0) {
    return null;
  }
  return { nome, duracao, preco };
}

router.get('/', async (req, res, next) => {
  try {
    const r = await executeQuery(
      `SELECT id, nome, duracao_minutos, preco_centavos, ativo
         FROM servicos WHERE empresa_id = $1 ORDER BY nome`,
      [req.usuario.empresa_id]
    );
    res.json(r.recordset);
  } catch (err) {
    next(err);
  }
});

router.post('/', somenteAdmin, async (req, res, next) => {
  try {
    const dados = validarCorpo(req.body);
    if (!dados) return res.status(400).json({ erro: 'Dados do serviço inválidos.' });
    const r = await executeQuery(
      `INSERT INTO servicos (empresa_id, nome, duracao_minutos, preco_centavos)
       VALUES ($1, $2, $3, $4)
       RETURNING id, nome, duracao_minutos, preco_centavos, ativo`,
      [req.usuario.empresa_id, dados.nome, dados.duracao, dados.preco]
    );
    res.status(201).json(r.recordset[0]);
  } catch (err) {
    next(err);
  }
});

router.put('/:id', somenteAdmin, async (req, res, next) => {
  try {
    const servicoId = parseInt(req.params.id, 10);
    const dados = validarCorpo(req.body);
    if (!Number.isInteger(servicoId) || !dados) {
      return res.status(400).json({ erro: 'Dados do serviço inválidos.' });
    }
    const ativo = typeof (req.body || {}).ativo === 'boolean' ? req.body.ativo : null;
    const r = await executeQuery(
      `UPDATE servicos SET nome = $1, duracao_minutos = $2, preco_centavos = $3,
              ativo = COALESCE($4, ativo)
        WHERE id = $5 AND empresa_id = $6
        RETURNING id, nome, duracao_minutos, preco_centavos, ativo`,
      [dados.nome, dados.duracao, dados.preco, ativo, servicoId, req.usuario.empresa_id]
    );
    if (!r.recordset.length) return res.status(404).json({ erro: 'Serviço não encontrado.' });
    res.json(r.recordset[0]);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
