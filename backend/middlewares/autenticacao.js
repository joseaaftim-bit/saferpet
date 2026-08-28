'use strict';

const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../config/segredos');
const { executeQuery } = require('../database');

/**
 * Valida o Bearer token e carrega usuário + empresa do banco.
 * Popula req.usuario = { id, nome, email, permissoes, empresa_id, plano }
 * e req.empresa = { id, nome, whatsapp, plano, acesso_ate }.
 *
 * O plano que viaja no token NÃO decide nada: quem manda é o que está
 * no banco agora (acesso_ate), porque o token de 12h continua válido
 * depois de um rebaixamento.
 */
async function validarJwt(req, res, next) {
  try {
    const cabecalho = req.headers.authorization || '';
    const token = cabecalho.startsWith('Bearer ') ? cabecalho.slice(7) : null;
    if (!token) return res.status(401).json({ erro: 'Não autenticado.' });

    let payload;
    try {
      payload = jwt.verify(token, JWT_SECRET);
    } catch (_e) {
      return res.status(401).json({ erro: 'Sessão expirada. Entre novamente.' });
    }

    const r = await executeQuery(
      `SELECT u.id, u.nome, u.email, u.permissoes, u.empresa_id, u.ativo,
              e.nome AS empresa_nome, e.whatsapp, e.plano, e.acesso_ate,
              (e.logo IS NOT NULL) AS tem_logo, e.logo_versao,
              e.ativo AS empresa_ativa
         FROM usuarios u
         JOIN empresas e ON e.id = u.empresa_id
        WHERE u.id = $1`,
      [payload.id]
    );
    const linha = r.recordset[0];
    if (!linha || !linha.ativo || !linha.empresa_ativa) {
      return res.status(401).json({ erro: 'Sessão inválida. Entre novamente.' });
    }

    req.usuario = {
      id: linha.id,
      nome: linha.nome,
      email: linha.email,
      permissoes: linha.permissoes,
      empresa_id: linha.empresa_id,
      plano: linha.plano,
    };
    req.empresa = {
      id: linha.empresa_id,
      nome: linha.empresa_nome,
      whatsapp: linha.whatsapp,
      tem_logo: !!linha.tem_logo,
      logo_versao: linha.logo_versao || null,
      plano: linha.plano,
      acesso_ate: linha.acesso_ate,
    };
    next();
  } catch (err) {
    next(err);
  }
}

function somenteAdmin(req, res, next) {
  if (!req.usuario || req.usuario.permissoes !== 'ADMINISTRADOR') {
    return res.status(403).json({ erro: 'Apenas administradores podem fazer isso.' });
  }
  next();
}

/**
 * Bloqueia as rotas de negócio quando o acesso do petshop venceu.
 * /api/auth/me fica de fora para o front conseguir mostrar o aviso.
 */
function exigirAcessoVigente(req, res, next) {
  const ate = req.empresa && req.empresa.acesso_ate;
  if (!ate || new Date(ate).getTime() < Date.now()) {
    return res.status(402).json({
      erro: 'O acesso do petshop ao SaferPet expirou. Fale com a SaferSoftware para renovar.',
    });
  }
  next();
}

module.exports = { validarJwt, somenteAdmin, exigirAcessoVigente };
