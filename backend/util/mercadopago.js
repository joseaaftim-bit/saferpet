'use strict';

// Cliente do Mercado Pago por PETSHOP: cada empresa usa o próprio access
// token, então o dinheiro cai direto na conta dela. Nada de credencial da
// SaferSoftware no meio do pagamento do cliente final.

const crypto = require('crypto');

const API = 'https://api.mercadopago.com';

async function chamarMP(caminho, accessToken, opcoes = {}) {
  const resp = await fetch(`${API}${caminho}`, {
    ...opcoes,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...(opcoes.headers || {}),
    },
    body: opcoes.body ? JSON.stringify(opcoes.body) : undefined,
  });
  const dados = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const err = new Error(dados.message || `Mercado Pago respondeu ${resp.status}.`);
    err.statusMP = resp.status;
    err.corpoMP = dados;
    throw err;
  }
  return dados;
}

/**
 * Cria a preferência de checkout. `externalReference` identifica APENAS o
 * registro de pagamento; valor e produto são conferidos no servidor depois.
 */
async function criarPreferencia(accessToken, { titulo, valorCentavos, externalReference, urlRetorno, urlWebhook, emailComprador, expiraEmMinutos }) {
  const corpo = {
    items: [{
      title: String(titulo).slice(0, 250),
      quantity: 1,
      currency_id: 'BRL',
      unit_price: Number((valorCentavos / 100).toFixed(2)),
    }],
    external_reference: externalReference,
    notification_url: urlWebhook,
    back_urls: { success: urlRetorno, failure: urlRetorno, pending: urlRetorno },
    auto_return: 'approved',
    statement_descriptor: 'SAFERPET',
  };
  if (emailComprador) corpo.payer = { email: emailComprador };

  // O link do checkout morre junto com a reserva de estoque: sem isso, o
  // cliente pode pagar horas depois de o pedido ter sido devolvido.
  if (expiraEmMinutos) {
    corpo.expires = true;
    corpo.expiration_date_to = new Date(Date.now() + expiraEmMinutos * 60 * 1000).toISOString();
  }

  return chamarMP('/checkout/preferences', accessToken, { method: 'POST', body: corpo });
}

/** Re-consulta o pagamento na API — nunca confiar no corpo do webhook. */
async function consultarPagamento(accessToken, paymentId) {
  return chamarMP(`/v1/payments/${encodeURIComponent(paymentId)}`, accessToken);
}

/**
 * Pagamentos de uma preferência. Usado na reconciliação: se o webhook se
 * perdeu, ainda achamos o pagamento aprovado pela preferência que criamos.
 */
async function buscarPagamentosDaPreferencia(accessToken, preferenceId) {
  const dados = await chamarMP(
    `/v1/payments/search?preference_id=${encodeURIComponent(preferenceId)}&sort=date_created&criteria=desc`,
    accessToken
  );
  return Array.isArray(dados.results) ? dados.results : [];
}

/**
 * Valida a assinatura HMAC do webhook. Sem segredo ou sem assinatura,
 * RECUSA — nunca "passa porque a simulação do painel não bate".
 */
function validarAssinatura({ segredo, xSignature, xRequestId, dataId }) {
  if (!segredo || !xSignature || !dataId) return false;

  const partes = {};
  String(xSignature).split(',').forEach(p => {
    const i = p.trim().indexOf('=');
    if (i > 0) partes[p.trim().slice(0, i)] = p.trim().slice(i + 1);
  });
  const { ts, v1 } = partes;
  if (!ts || !v1 || !/^[0-9a-f]+$/i.test(v1)) return false;

  const base = [
    `id:${dataId}`,
    xRequestId ? `request-id:${xRequestId}` : null,
    `ts:${ts}`,
  ].filter(Boolean).join(';');

  // Duas ambiguidades conhecidas de integração, ambas resolvidas testando
  // as variantes. Nada é afrouxado: TODAS derivam do MESMO segredo, então
  // sem ele nenhum hash pode ser forjado.
  //
  // 1. Template: a documentação mostra com ponto-e-vírgula final; parte das
  //    integrações assina sem ele.
  // 2. Chave: a documentação usa o segredo como STRING; algumas integrações
  //    da casa decodificam de hex quando ele tem 64 caracteres hex.
  const chaves = [segredo];
  if (/^[0-9a-f]{64}$/i.test(segredo)) chaves.push(Buffer.from(segredo, 'hex'));
  const esperado = Buffer.from(v1, 'hex');

  for (const chave of chaves) {
    for (const template of [base, `${base};`]) {
      const hash = crypto.createHmac('sha256', chave).update(template).digest('hex');
      const calculado = Buffer.from(hash, 'hex');
      if (esperado.length === calculado.length && crypto.timingSafeEqual(esperado, calculado)) {
        return true;
      }
    }
  }
  return false;
}

module.exports = {
  criarPreferencia, consultarPagamento, buscarPagamentosDaPreferencia, validarAssinatura,
};
