'use strict';

// Autenticação do DONO DE PET — separada da do petshop.
// Duas portas levam ao mesmo lugar:
//   1. o link com token (o jeito antigo, sem senha, continua valendo)
//   2. a conta com telefone e senha (o jeito novo)
// Em ambos os casos, o que vale é o cliente resolvido do banco.

const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../config/segredos');
const { executeQuery } = require('../database');

const CAMPOS_CLIENTE = `c.id, c.nome, c.telefone, c.email, c.endereco, c.empresa_id,
            c.conta_ativa, c.conta_criada_em,
            e.nome AS petshop_nome, e.whatsapp AS petshop_whatsapp, e.slug,
            e.acesso_ate, e.ativo AS empresa_ativa, e.aceita_online,
            e.mp_access_token, e.mp_webhook_secret,
            (e.logo IS NOT NULL) AS tem_logo, e.logo_versao`;

function gerarTokenCliente(cliente) {
  return jwt.sign(
    { tipo: 'cliente', cliente_id: cliente.id, empresa_id: cliente.empresa_id },
    JWT_SECRET,
    { expiresIn: '30d' }   // o dono de pet não quer relogar toda semana
  );
}

async function carregarCliente(where, params) {
  const r = await executeQuery(
    `SELECT ${CAMPOS_CLIENTE}
       FROM clientes c
       JOIN empresas e ON e.id = c.empresa_id
      WHERE ${where} AND c.ativo`,
    params
  );
  const cliente = r.recordset[0];
  if (!cliente || !cliente.empresa_ativa) return null;
  if (new Date(cliente.acesso_ate).getTime() < Date.now()) return { indisponivel: true };
  return cliente;
}

/** Resolve pelo token do link (o caminho de sempre). */
async function porTokenDoPortal(token) {
  if (!token || token.length < 20 || token.length > 64) return null;
  return carregarCliente('c.token_portal = $1', [token]);
}

/** Só valida o crachá da sessão e devolve o payload inteiro. */
function payloadDaSessao(autorizacao) {
  const bruto = String(autorizacao || '');
  const token = bruto.startsWith('Bearer ') ? bruto.slice(7) : null;
  if (!token) return null;

  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch (_e) {
    return null;
  }
  // Um token do PAINEL não abre a conta do cliente, e vice-versa.
  if (payload.tipo !== 'cliente' || !payload.cliente_id) return null;
  return payload;
}

/** Compatível com quem só precisa do id. */
function idDaSessao(autorizacao) {
  const payload = payloadDaSessao(autorizacao);
  return payload ? payload.cliente_id : null;
}

/** Resolve pela sessão da conta (telefone e senha). */
async function porSessao(autorizacao) {
  const payload = payloadDaSessao(autorizacao);
  if (!payload) return null;

  const cliente = await carregarCliente('c.id = $1', [payload.cliente_id]);
  if (!cliente || cliente.indisponivel) return cliente;
  if (!cliente.conta_ativa) return null;   // conta desativada depois do login
  if (crachaAnteriorAConta(payload, cliente)) return null;
  return cliente;
}

/**
 * Crachá emitido ANTES da (re)criação da conta não vale. Sem isto, o
 * crachá de 30 dias de alguém desconectado voltaria a abrir a conta
 * quando ela fosse reativada por uma nova aprovação do petshop.
 * Tolerância de 60s cobre o crachá emitido no próprio cadastro.
 */
function crachaAnteriorAConta(payload, cliente) {
  if (!cliente.conta_criada_em || !payload.iat) return false;
  return payload.iat * 1000 < new Date(cliente.conta_criada_em).getTime() - 60 * 1000;
}

/**
 * Middleware das rotas do app do cliente: aceita as duas portas.
 * Popula req.cliente. Responde 404 (link inválido) ou 503 (petshop com
 * acesso vencido) — o dono de pet não pode receber erro obscuro.
 */
function autenticarCliente(req, res, next) {
  const resolver = req.params.token
    ? porTokenDoPortal(String(req.params.token))
    : porSessao(req.headers.authorization);

  resolver
    .then(cliente => {
      if (!cliente) return res.status(404).json({ erro: 'Link inválido ou sessão expirada.' });
      if (cliente.indisponivel) {
        return res.status(503).json({
          erro: 'Portal temporariamente indisponível. Fale direto com o petshop.',
        });
      }
      req.cliente = cliente;
      next();
    })
    .catch(next);
}

module.exports = {
  gerarTokenCliente, porTokenDoPortal, porSessao, idDaSessao, payloadDaSessao,
  crachaAnteriorAConta, autenticarCliente, carregarCliente,
};
