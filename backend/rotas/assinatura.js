'use strict';

// Cobrança da assinatura do petshop para a SaferSoftware.
// Usa as credenciais GLOBAIS (MP_ACCESS_TOKEN/MP_WEBHOOK_SECRET) — nada a
// ver com as credenciais de cada petshop, que cobram o cliente final.

const express = require('express');
const { executeQuery, comTransacao } = require('../database');
const { somenteAdmin, validarJwt } = require('../middlewares/autenticacao');
const { MP_ACCESS_TOKEN, MP_WEBHOOK_SECRET, APP_URL } = require('../config/segredos');
const { planoDe, listarPlanos } = require('../config/planos');
const {
  criarPreferencia, consultarPagamento, buscarPagamentosDaPreferencia, validarAssinatura,
} = require('../util/mercadopago');

const router = express.Router();

function cobrancaDisponivel() {
  return !!MP_ACCESS_TOKEN && !!MP_WEBHOOK_SECRET;
}

// ─── Situação da assinatura e planos ───────────────────────────────

router.get('/', validarJwt, somenteAdmin, async (req, res, next) => {
  try {
    const historico = await executeQuery(
      `SELECT id, plano, periodo, valor_centavos, status, acesso_de, acesso_ate,
              criado_em, aprovado_em
         FROM assinaturas WHERE empresa_id = $1
        ORDER BY criado_em DESC LIMIT 12`,
      [req.usuario.empresa_id]
    );

    const ate = new Date(req.empresa.acesso_ate);
    const diasRestantes = Math.ceil((ate.getTime() - Date.now()) / (24 * 60 * 60 * 1000));

    res.json({
      plano: req.empresa.plano,
      acesso_ate: req.empresa.acesso_ate,
      dias_restantes: diasRestantes,
      vigente: ate.getTime() >= Date.now(),
      cobranca_disponivel: cobrancaDisponivel(),
      planos: listarPlanos(),
      historico: historico.recordset,
    });
  } catch (err) {
    next(err);
  }
});

// ─── Petshop inicia o pagamento da assinatura ──────────────────────

router.post('/pagar', validarJwt, somenteAdmin, async (req, res, next) => {
  try {
    if (!cobrancaDisponivel()) {
      return res.status(503).json({
        erro: 'A renovação online ainda não está disponível. Fale com a SaferSoftware.',
      });
    }

    const plano = planoDe((req.body || {}).periodo);
    if (!plano) return res.status(400).json({ erro: 'Escolha um plano.' });

    const empresaId = req.usuario.empresa_id;

    // Um pagamento aberto por vez: evita duas cobranças simultâneas.
    const abertas = await executeQuery(
      `SELECT COUNT(*)::int AS total FROM assinaturas
        WHERE empresa_id = $1 AND status = 'PENDENTE'
          AND criado_em > NOW() - INTERVAL '15 minutes'`,
      [empresaId]
    );
    if (abertas.recordset[0].total >= 3) {
      return res.status(409).json({
        erro: 'Você já tem um pagamento em aberto. Conclua ou aguarde alguns minutos.',
      });
    }

    const ra = await executeQuery(
      `INSERT INTO assinaturas (empresa_id, plano, periodo, valor_centavos, status)
       VALUES ($1, $2, $3, $4, 'PENDENTE') RETURNING id`,
      [empresaId, plano.plano, plano.periodo, plano.valor_centavos]
    );
    const assinaturaId = ra.recordset[0].id;

    let preferencia;
    try {
      preferencia = await criarPreferencia(MP_ACCESS_TOKEN, {
        titulo: `${plano.nome} — ${req.empresa.nome}`,
        valorCentavos: plano.valor_centavos,
        externalReference: `assinatura:${assinaturaId}`,
        urlRetorno: `${APP_URL}/app#/assinatura`,
        urlWebhook: `${APP_URL}/api/assinatura/webhook`,
        emailComprador: req.usuario.email || undefined,
        // O link morre junto com a janela de tentativa: pagamento fora do
        // prazo vira conferência manual em vez de crédito silencioso.
        expiraEmMinutos: 60,
      });
    } catch (err) {
      console.error('[assinatura] Falha ao criar preferência:', err.corpoMP || err.message);
      await executeQuery(
        `UPDATE assinaturas SET status = 'ERRO' WHERE id = $1 AND empresa_id = $2`,
        [assinaturaId, empresaId]
      );
      return res.status(502).json({ erro: 'Não foi possível abrir o pagamento agora. Tente de novo em instantes.' });
    }

    await executeQuery(
      'UPDATE assinaturas SET mp_preference_id = $1 WHERE id = $2 AND empresa_id = $3',
      [String(preferencia.id), assinaturaId, empresaId]
    );

    res.status(201).json({
      assinatura_id: assinaturaId,
      valor_centavos: plano.valor_centavos,
      url: preferencia.init_point || preferencia.sandbox_init_point,
    });
  } catch (err) {
    next(err);
  }
});

// ─── Webhook da assinatura (rota pública) ──────────────────────────
// Mesmas travas do webhook do cliente: sem segredo 503, assinatura
// inválida 401, valor conferido na tabela do servidor.

router.post('/webhook', async (req, res) => {
  if (!MP_WEBHOOK_SECRET) {
    console.error('[assinatura] MP_WEBHOOK_SECRET não configurado — recusando.');
    return res.status(503).send('Webhook não configurado.');
  }

  const dataId = (req.query && req.query['data.id']) ||
    (req.body && req.body.data && req.body.data.id) || null;

  const ok = validarAssinatura({
    segredo: MP_WEBHOOK_SECRET,
    xSignature: req.headers['x-signature'],
    xRequestId: req.headers['x-request-id'],
    dataId,
  });
  if (!ok) {
    console.error('[assinatura] assinatura inválida.');
    return res.status(401).send('Assinatura inválida.');
  }

  res.status(200).send('OK');

  const tipo = (req.body && (req.body.type || req.body.topic)) || req.query.type;
  if (tipo !== 'payment' || !dataId) return;

  processarAssinatura(String(dataId)).catch(err =>
    console.error('[assinatura] falha ao processar:', err));
});

async function processarAssinatura(paymentId) {
  const pgto = await consultarPagamento(MP_ACCESS_TOKEN, paymentId);

  // Dinheiro que voltou (estorno, contestação, cancelamento): marca a
  // assinatura para o dono decidir o que fazer com o acesso. Não corta
  // sozinho — derrubar um petshop no meio do expediente por um estorno
  // parcial seria pior que o problema.
  if (['refunded', 'charged_back', 'cancelled'].includes(pgto.status)) {
    const r = await executeQuery(
      `UPDATE assinaturas SET status = 'ESTORNADO'
        WHERE mp_payment_id = $1 AND status = 'APROVADO'
        RETURNING id, empresa_id`,
      [String(paymentId)]
    );
    if (r.recordset.length) {
      const a = r.recordset[0];
      console.error(`[assinatura] ATENÇÃO: pagamento ${paymentId} virou ${pgto.status} — ` +
        `assinatura ${a.id} da empresa ${a.empresa_id} estornada. Conferir o acesso.`);
    }
    return;
  }

  if (pgto.status !== 'approved') {
    console.log(`[assinatura] pagamento ${paymentId} está ${pgto.status} — nada a fazer.`);
    return;
  }

  const m = /^assinatura:(\d+)$/.exec(String(pgto.external_reference || ''));
  if (!m) {
    console.error(`[assinatura] external_reference inesperado: ${pgto.external_reference}`);
    return;
  }
  const assinaturaId = parseInt(m[1], 10);
  const valorPago = Number(pgto.transaction_amount);

  await comTransacao(async (query) => {
    const ra = await query(
      `SELECT id, empresa_id, plano, periodo, valor_centavos, status
         FROM assinaturas WHERE id = $1 FOR UPDATE`,
      [assinaturaId]
    );
    const assinatura = ra.recordset[0];
    if (!assinatura) {
      console.error(`[assinatura] registro ${assinaturaId} não encontrado.`);
      return;
    }
    if (assinatura.status === 'APROVADO') {
      const rja = await query(
        'SELECT mp_payment_id FROM assinaturas WHERE id = $1', [assinaturaId]);
      const anterior = rja.recordset[0] && rja.recordset[0].mp_payment_id;
      if (anterior && String(anterior) !== String(paymentId)) {
        // O petshop pagou duas vezes a MESMA cobrança. Não estende o acesso
        // de novo, mas registra para devolvermos — nunca some em silêncio.
        console.error(`[assinatura] ${assinaturaId} recebeu segunda cobrança ${paymentId} (já paga em ${anterior}).`);
        await query(
          `INSERT INTO assinaturas (empresa_id, plano, periodo, valor_centavos,
                                    status, mp_payment_id)
           VALUES ($1, $2, $3, $4, 'DUPLICADO', $5)
           ON CONFLICT (mp_payment_id) DO NOTHING`,
          [assinatura.empresa_id, assinatura.plano, assinatura.periodo,
           Math.round(valorPago * 100), String(paymentId)]
        );
        return;
      }
      console.log(`[assinatura] ${assinaturaId} já aprovada — ignorando repetição.`);
      return;
    }

    // O plano e a duração saem da TABELA DO SERVIDOR, nunca do que veio.
    const plano = planoDe(assinatura.periodo);
    if (!plano) {
      console.error(`[assinatura] período ${assinatura.periodo} não existe mais na tabela.`);
      await query(
        `UPDATE assinaturas SET status = 'PENDENTE_MANUAL', mp_payment_id = $1 WHERE id = $2`,
        [String(paymentId), assinaturaId]
      );
      return;
    }
    // Confere contra o valor da PREFERÊNCIA criada (o que o petshop viu na
    // tela). Se a tabela mudar de preço no meio, quem já estava pagando não
    // é penalizado nem beneficiado.
    const esperado = assinatura.valor_centavos / 100;
    if (Math.abs(valorPago - esperado) >= 0.01) {
      console.error(`[assinatura] valor divergente em ${assinaturaId}: pago ${valorPago}, esperado ${esperado}.`);
      await query(
        `UPDATE assinaturas SET status = 'DIVERGENTE', mp_payment_id = $1 WHERE id = $2`,
        [String(paymentId), assinaturaId]
      );
      return;
    }

    // Renovar SOMA ao que resta: quem paga antes de vencer não perde dias.
    const re = await query(
      'SELECT acesso_ate FROM empresas WHERE id = $1 FOR UPDATE',
      [assinatura.empresa_id]
    );
    const atual = new Date(re.recordset[0].acesso_ate).getTime();
    const base = Math.max(atual, Date.now());
    const novoAte = new Date(base + plano.dias * 24 * 60 * 60 * 1000);

    await query(
      'UPDATE empresas SET plano = $1, acesso_ate = $2 WHERE id = $3',
      [plano.plano, novoAte.toISOString(), assinatura.empresa_id]
    );
    await query(
      `UPDATE assinaturas SET status = 'APROVADO', mp_payment_id = $1,
              acesso_de = $2, acesso_ate = $3, aprovado_em = NOW()
        WHERE id = $4`,
      [String(paymentId), new Date(base).toISOString(), novoAte.toISOString(), assinaturaId]
    );

    console.log(`[assinatura] empresa ${assinatura.empresa_id} liberada até ${novoAte.toISOString()}.`);
  });
}

/** Recupera assinaturas cujo webhook se perdeu. */
async function reconciliarAssinaturas(limiteMinutos = 10) {
  // A limpeza roda SEMPRE: cobrança não paga em 24h vira EXPIRADA. Sem
  // isso a fila entope de PENDENTE morto e o LIMIT deixa de alcançar os
  // pagamentos reais. Não depende das credenciais do Mercado Pago.
  const morta = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const expiradas = await executeQuery(
    `UPDATE assinaturas SET status = 'EXPIRADA'
      WHERE status = 'PENDENTE' AND criado_em < $1`,
    [morta]
  );
  if (expiradas.rowsAffected[0]) {
    console.log(`[assinatura] ${expiradas.rowsAffected[0]} cobrança(s) sem pagamento expiradas.`);
  }

  // Buscar no Mercado Pago exige credencial; a limpeza acima, não.
  if (!cobrancaDisponivel()) return 0;

  const corte = new Date(Date.now() - limiteMinutos * 60 * 1000).toISOString();
  const r = await executeQuery(
    `SELECT id, mp_preference_id FROM assinaturas
      WHERE status = 'PENDENTE' AND mp_preference_id IS NOT NULL AND criado_em < $1
      ORDER BY criado_em DESC LIMIT 50`,
    [corte]
  );
  let recuperadas = 0;
  for (const linha of r.recordset) {
    try {
      const encontrados = await buscarPagamentosDaPreferencia(MP_ACCESS_TOKEN, linha.mp_preference_id);
      const aprovado = encontrados.find(p => p.status === 'approved');
      if (!aprovado) continue;
      await processarAssinatura(String(aprovado.id));
      recuperadas += 1;
      console.log(`[assinatura] ${linha.id} recuperada sem webhook.`);
    } catch (err) {
      console.error(`[assinatura] falha ao reconciliar ${linha.id}:`, err.message);
    }
  }
  return recuperadas;
}

module.exports = router;
module.exports.reconciliarAssinaturas = reconciliarAssinaturas;
