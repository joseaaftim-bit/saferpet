'use strict';

const express = require('express');
const { executeQuery } = require('../database');

const router = express.Router();

router.post('/', async (req, res, next) => {
  try {
    const { cliente_id, nome, raca, porte, observacoes } = req.body || {};
    const clienteId = parseInt(cliente_id, 10);
    if (!Number.isInteger(clienteId) || !nome || !String(nome).trim()) {
      return res.status(400).json({ erro: 'Informe o cliente e o nome do pet.' });
    }

    const dono = await executeQuery(
      'SELECT id FROM clientes WHERE id = $1 AND empresa_id = $2 AND ativo',
      [clienteId, req.usuario.empresa_id]
    );
    if (!dono.recordset.length) return res.status(404).json({ erro: 'Cliente não encontrado.' });

    const r = await executeQuery(
      `INSERT INTO pets (empresa_id, cliente_id, nome, raca, porte, observacoes)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, cliente_id, nome, raca, porte, observacoes`,
      [
        req.usuario.empresa_id,
        clienteId,
        String(nome).trim(),
        String(raca || '').trim() || null,
        String(porte || '').trim() || null,
        String(observacoes || '').trim() || null,
      ]
    );
    res.status(201).json(r.recordset[0]);
  } catch (err) {
    next(err);
  }
});

router.put('/:id', async (req, res, next) => {
  try {
    const petId = parseInt(req.params.id, 10);
    const { nome, raca, porte, observacoes } = req.body || {};
    if (!Number.isInteger(petId) || !nome || !String(nome).trim()) {
      return res.status(400).json({ erro: 'Dados inválidos.' });
    }
    const r = await executeQuery(
      `UPDATE pets SET nome = $1, raca = $2, porte = $3, observacoes = $4
        WHERE id = $5 AND empresa_id = $6 AND ativo RETURNING id`,
      [
        String(nome).trim(),
        String(raca || '').trim() || null,
        String(porte || '').trim() || null,
        String(observacoes || '').trim() || null,
        petId,
        req.usuario.empresa_id,
      ]
    );
    if (!r.recordset.length) return res.status(404).json({ erro: 'Pet não encontrado.' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const petId = parseInt(req.params.id, 10);
    if (!Number.isInteger(petId)) return res.status(404).json({ erro: 'Pet não encontrado.' });
    const r = await executeQuery(
      'UPDATE pets SET ativo = FALSE WHERE id = $1 AND empresa_id = $2 RETURNING id',
      [petId, req.usuario.empresa_id]
    );
    if (!r.recordset.length) return res.status(404).json({ erro: 'Pet não encontrado.' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
