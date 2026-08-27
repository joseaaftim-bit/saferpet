'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { JWT_SECRET, TRIAL_DIAS } = require('../config/segredos');
const { executeQuery, comTransacao } = require('../database');
const { validarJwt } = require('../middlewares/autenticacao');

const router = express.Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Hash sacrificial: o login roda bcrypt mesmo quando o e-mail não existe,
// para a resposta demorar o mesmo tanto (sem enumerar e-mails pelo relógio).
const HASH_DUMMY = bcrypt.hashSync('senha-dummy-para-tempo-constante', 10);

// Força bruta e criação de conta em massa. O server.js tem trust proxy 1,
// então req.ip é o cliente real atrás do proxy do Railway.
const limiteLogin = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  keyGenerator: req => `${req.ip}|${String((req.body || {}).email || '').trim().toLowerCase()}`,
  message: { erro: 'Muitas tentativas. Aguarde alguns minutos.' },
  standardHeaders: false,
  legacyHeaders: false,
  validate: false,
});
const limiteRegistrar = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  message: { erro: 'Muitas contas criadas deste endereço. Aguarde uma hora.' },
  standardHeaders: false,
  legacyHeaders: false,
  validate: false,
});

function gerarToken(usuario) {
  return jwt.sign(
    {
      id: usuario.id,
      nome: usuario.nome,
      email: usuario.email,
      permissoes: usuario.permissoes,
      empresa_id: usuario.empresa_id,
      plano: usuario.plano,
    },
    JWT_SECRET,
    { expiresIn: '12h' }
  );
}

// Cria o petshop (empresa) + primeiro usuário administrador, em transação.
router.post('/registrar', limiteRegistrar, async (req, res, next) => {
  try {
    const { empresa_nome, whatsapp, nome, email, senha } = req.body || {};

    if (!empresa_nome || !String(empresa_nome).trim()) {
      return res.status(400).json({ erro: 'Informe o nome do petshop.' });
    }
    if (!nome || !String(nome).trim()) {
      return res.status(400).json({ erro: 'Informe o seu nome.' });
    }
    const emailLimpo = String(email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(emailLimpo)) {
      return res.status(400).json({ erro: 'E-mail inválido.' });
    }
    if (!senha || String(senha).length < 8) {
      return res.status(400).json({ erro: 'A senha precisa ter pelo menos 8 caracteres.' });
    }

    const jaExiste = await executeQuery('SELECT id FROM usuarios WHERE email = $1', [emailLimpo]);
    if (jaExiste.recordset.length) {
      return res.status(409).json({ erro: 'Já existe uma conta com este e-mail.' });
    }

    const senhaHash = await bcrypt.hash(String(senha), 10);
    const acessoAte = new Date(Date.now() + TRIAL_DIAS * 24 * 60 * 60 * 1000).toISOString();

    const usuario = await comTransacao(async (query) => {
      const emp = await query(
        `INSERT INTO empresas (nome, whatsapp, plano, acesso_ate)
         VALUES ($1, $2, 'TRIAL', $3) RETURNING id, plano`,
        [String(empresa_nome).trim(), String(whatsapp || '').trim() || null, acessoAte]
      );
      const empresaId = emp.recordset[0].id;

      const usr = await query(
        `INSERT INTO usuarios (empresa_id, nome, email, senha_hash, permissoes)
         VALUES ($1, $2, $3, $4, 'ADMINISTRADOR')
         RETURNING id, nome, email, permissoes, empresa_id`,
        [empresaId, String(nome).trim(), emailLimpo, senhaHash]
      );
      return { ...usr.recordset[0], plano: emp.recordset[0].plano };
    });

    res.status(201).json({
      token: gerarToken(usuario),
      usuario: {
        id: usuario.id,
        nome: usuario.nome,
        email: usuario.email,
        permissoes: usuario.permissoes,
      },
    });
  } catch (err) {
    next(err);
  }
});

router.post('/login', limiteLogin, async (req, res, next) => {
  try {
    const emailLimpo = String((req.body || {}).email || '').trim().toLowerCase();
    const senha = String((req.body || {}).senha || '');

    const r = await executeQuery(
      `SELECT u.id, u.nome, u.email, u.senha_hash, u.permissoes, u.empresa_id, u.ativo,
              e.plano, e.ativo AS empresa_ativa
         FROM usuarios u
         JOIN empresas e ON e.id = u.empresa_id
        WHERE u.email = $1`,
      [emailLimpo]
    );
    const usuario = r.recordset[0];

    // bcrypt roda sempre — e-mail inexistente responde no mesmo tempo.
    const senhaOk = await bcrypt.compare(senha, usuario ? usuario.senha_hash : HASH_DUMMY);
    if (!usuario || !senhaOk || !usuario.ativo || !usuario.empresa_ativa) {
      return res.status(401).json({ erro: 'E-mail ou senha inválidos.' });
    }

    res.json({
      token: gerarToken(usuario),
      usuario: {
        id: usuario.id,
        nome: usuario.nome,
        email: usuario.email,
        permissoes: usuario.permissoes,
      },
    });
  } catch (err) {
    next(err);
  }
});

// Sem exigirAcessoVigente de propósito: o front usa esta rota para saber
// que o acesso venceu e mostrar o aviso de renovação.
router.get('/me', validarJwt, (req, res) => {
  res.json({
    usuario: req.usuario,
    empresa: {
      id: req.empresa.id,
      nome: req.empresa.nome,
      whatsapp: req.empresa.whatsapp,
      plano: req.empresa.plano,
      acesso_ate: req.empresa.acesso_ate,
      acesso_vigente: new Date(req.empresa.acesso_ate).getTime() >= Date.now(),
    },
  });
});

module.exports = router;
