'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const { executeQuery } = require('../database');
const { somenteAdmin } = require('../middlewares/autenticacao');

const router = express.Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

router.get('/', somenteAdmin, async (req, res, next) => {
  try {
    const usuarios = await executeQuery(
      `SELECT id, nome, email, permissoes, ativo, criado_em
         FROM usuarios WHERE empresa_id = $1 ORDER BY nome`,
      [req.usuario.empresa_id]
    );
    res.json({
      id: req.empresa.id,
      nome: req.empresa.nome,
      whatsapp: req.empresa.whatsapp,
      plano: req.empresa.plano,
      acesso_ate: req.empresa.acesso_ate,
      usuarios: usuarios.recordset,
    });
  } catch (err) {
    next(err);
  }
});

router.put('/', somenteAdmin, async (req, res, next) => {
  try {
    const { nome, whatsapp } = req.body || {};
    if (!nome || !String(nome).trim()) {
      return res.status(400).json({ erro: 'Informe o nome do petshop.' });
    }
    await executeQuery(
      'UPDATE empresas SET nome = $1, whatsapp = $2 WHERE id = $3',
      [String(nome).trim(), String(whatsapp || '').trim() || null, req.usuario.empresa_id]
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post('/usuarios', somenteAdmin, async (req, res, next) => {
  try {
    const { nome, email, senha, permissoes } = req.body || {};
    const emailLimpo = String(email || '').trim().toLowerCase();
    const papel = permissoes === 'ADMINISTRADOR' ? 'ADMINISTRADOR' : 'ATENDENTE';

    if (!nome || !String(nome).trim()) return res.status(400).json({ erro: 'Informe o nome.' });
    if (!EMAIL_RE.test(emailLimpo)) return res.status(400).json({ erro: 'E-mail inválido.' });
    if (!senha || String(senha).length < 8) {
      return res.status(400).json({ erro: 'A senha precisa ter pelo menos 8 caracteres.' });
    }

    const jaExiste = await executeQuery('SELECT id FROM usuarios WHERE email = $1', [emailLimpo]);
    if (jaExiste.recordset.length) {
      return res.status(409).json({ erro: 'Já existe uma conta com este e-mail.' });
    }

    const senhaHash = await bcrypt.hash(String(senha), 10);
    const r = await executeQuery(
      `INSERT INTO usuarios (empresa_id, nome, email, senha_hash, permissoes)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, nome, email, permissoes, ativo`,
      [req.usuario.empresa_id, String(nome).trim(), emailLimpo, senhaHash, papel]
    );
    res.status(201).json(r.recordset[0]);
  } catch (err) {
    next(err);
  }
});

router.put('/usuarios/:id', somenteAdmin, async (req, res, next) => {
  try {
    const usuarioId = parseInt(req.params.id, 10);
    const { permissoes, ativo, senha } = req.body || {};
    if (!Number.isInteger(usuarioId)) return res.status(404).json({ erro: 'Usuário não encontrado.' });

    if (usuarioId === req.usuario.id && (ativo === false || (permissoes && permissoes !== 'ADMINISTRADOR'))) {
      return res.status(409).json({ erro: 'Você não pode rebaixar ou desativar a si mesmo.' });
    }
    if (permissoes !== undefined && !['ADMINISTRADOR', 'ATENDENTE'].includes(permissoes)) {
      return res.status(400).json({ erro: 'Permissão inválida.' });
    }
    if (senha !== undefined && String(senha).length < 8) {
      return res.status(400).json({ erro: 'A senha precisa ter pelo menos 8 caracteres.' });
    }

    const senhaHash = senha !== undefined ? await bcrypt.hash(String(senha), 10) : null;
    const r = await executeQuery(
      `UPDATE usuarios SET
          permissoes = COALESCE($1, permissoes),
          ativo = COALESCE($2, ativo),
          senha_hash = COALESCE($3, senha_hash)
        WHERE id = $4 AND empresa_id = $5
        RETURNING id, nome, email, permissoes, ativo`,
      [permissoes || null,
       typeof ativo === 'boolean' ? ativo : null,
       senhaHash, usuarioId, req.usuario.empresa_id]
    );
    if (!r.recordset.length) return res.status(404).json({ erro: 'Usuário não encontrado.' });
    res.json(r.recordset[0]);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
