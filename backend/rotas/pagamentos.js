'use strict';

// Pagamento online: o CLIENTE paga o PETSHOP (credenciais do Mercado Pago
// de cada empresa). Rotas públicas — a credencial do cliente é o link
// com token OU o crachá da conta dele; o webhook é validado por HMAC do
// segredo daquela empresa.

const express = require('express');
const rateLimit = require('express-rate-limit');
const { executeQuery, comTransacao } = require('../database');
const { decifrar } = require('../util/cripto');
const { APP_URL } = require('../config/segredos');
const {
  criarPreferencia, consultarPagamento, buscarPagamentosDaPreferencia, validarAssinatura,
} = require('../util/mercadopago');
const { hojeSaoPaulo, somarMeses } = require('../util/datas');
const { idDaSessao } = require('../middlewares/clienteAuth');

const router = express.Router();

function erroNegocio(mensagem, statusHttp) {
  return Object.assign(new Error(mensagem), { statusHttp });
}

function proximoDia(iso) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

// Abrir checkout cria registro e reserva estoque: limita por IP.
// A bateria roda dezenas de compras seguidas do mesmo IP — o limite de
// produção só atrapalharia lá.
const limiteCompra = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: process.env.NODE_ENV === 'test' ? 1000 : 15,
  message: { erro: 'Muitas tentativas de compra. Aguarde alguns minutos.' },
  standardHeaders: false, legacyHeaders: false, validate: false,
});

// Carrega o cliente com a empresa e as credenciais de pagamento dela.
async function carregarCliente(where, params) {
  const r = await executeQuery(
    `SELECT c.id, c.nome, c.email, c.endereco, c.empresa_id, c.conta_ativa,
            e.nome AS empresa_nome, e.acesso_ate, e.ativo AS empresa_ativa,
            e.aceita_online, e.mp_access_token, e.mp_webhook_secret
       FROM clientes c
       JOIN empresas e ON e.id = c.empresa_id
      WHERE ${where} AND c.ativo`,
    params
  );
  const cliente = r.recordset[0];
  if (!cliente || !cliente.empresa_ativa) return null;
  if (new Date(cliente.acesso_ate).getTime() < Date.now()) return null;
  return cliente;
}

async function clientePorToken(token) {
  return carregarCliente('c.token_portal = $1', [token]);
}

// Duas portas para o mesmo cliente: o link antigo (/portal/<token>) e a
// conta com telefone e senha (/portal/conta + crachá no cabeçalho).
async function clienteDaRequisicao(req) {
  const bruto = req.params && req.params.token;
  if (bruto && bruto !== 'conta') return clientePorToken(String(bruto));

  const clienteId = idDaSessao(req.headers.authorization);
  if (!clienteId) return null;
  const cliente = await carregarCliente('c.id = $1', [clienteId]);
  return cliente && cliente.conta_ativa ? cliente : null;
}

// Para onde o Mercado Pago devolve o cliente depois de pagar.
function urlDeRetorno(req) {
  const bruto = req.params && req.params.token;
  return bruto && bruto !== 'conta'
    ? `${APP_URL}/portal/${encodeURIComponent(bruto)}`
    : `${APP_URL}/portal/conta`;
}

// ─── Cliente inicia a compra de um pacote ──────────────────────────

router.post('/portal/:token/comprar', limiteCompra, async (req, res, next) => {
  try {
    const cliente = await clienteDaRequisicao(req);
    if (!cliente) return res.status(404).json({ erro: 'Link inválido.' });
    if (!cliente.aceita_online) {
      return res.status(409).json({ erro: 'Este petshop não vende pacotes pelo aplicativo. Fale com eles.' });
    }

    const accessToken = decifrar(cliente.mp_access_token);
    if (!accessToken) {
      return res.status(503).json({
        erro: 'O petshop ainda não configurou o pagamento online. Fale com eles para comprar.',
      });
    }

    const modeloId = parseInt((req.body || {}).modelo_id, 10);
    if (!Number.isInteger(modeloId)) return res.status(400).json({ erro: 'Escolha um pacote.' });

    // Preço e itens SEMPRE do catálogo do servidor.
    const rm = await executeQuery(
      `SELECT id, nome, valor_centavos FROM pacotes_modelo
        WHERE id = $1 AND empresa_id = $2 AND ativo`,
      [modeloId, cliente.empresa_id]
    );
    if (!rm.recordset.length) return res.status(404).json({ erro: 'Pacote não encontrado.' });
    const modelo = rm.recordset[0];
    if (modelo.valor_centavos <= 0) {
      return res.status(409).json({ erro: 'Este pacote não tem preço definido. Fale com o petshop.' });
    }

    const rp = await executeQuery(
      `INSERT INTO pagamentos (empresa_id, cliente_id, tipo, modelo_id, valor_centavos, status)
       VALUES ($1, $2, 'PACOTE', $3, $4, 'PENDENTE')
       RETURNING id`,
      [cliente.empresa_id, cliente.id, modeloId, modelo.valor_centavos]
    );
    const pagamentoId = rp.recordset[0].id;

    let preferencia;
    try {
      preferencia = await criarPreferencia(accessToken, {
        titulo: `${modelo.nome} — ${cliente.empresa_nome}`,
        valorCentavos: modelo.valor_centavos,
        externalReference: `pagamento:${pagamentoId}`,
        urlRetorno: urlDeRetorno(req),
        urlWebhook: `${APP_URL}/api/pagamentos/webhook/${cliente.empresa_id}`,
        emailComprador: cliente.email || undefined,
      });
    } catch (err) {
      console.error('[pagamentos] Falha ao criar preferência:', err.corpoMP || err.message);
      await executeQuery(
        `UPDATE pagamentos SET status = 'ERRO' WHERE id = $1 AND empresa_id = $2`,
        [pagamentoId, cliente.empresa_id]
      );
      return res.status(502).json({ erro: 'Não foi possível abrir o pagamento agora. Tente de novo em instantes.' });
    }

    await executeQuery(
      'UPDATE pagamentos SET mp_preference_id = $1 WHERE id = $2 AND empresa_id = $3',
      [String(preferencia.id), pagamentoId, cliente.empresa_id]
    );

    res.status(201).json({
      pagamento_id: pagamentoId,
      url: preferencia.init_point || preferencia.sandbox_init_point,
    });
  } catch (err) {
    next(err);
  }
});

// ─── Webhook do Mercado Pago ───────────────────────────────────────
// Fecha por padrão: sem segredo configurado responde 503; assinatura
// inválida responde 401. O valor é conferido contra o catálogo do servidor.

router.post('/webhook/:empresaId', async (req, res) => {
  const empresaId = parseInt(req.params.empresaId, 10);
  if (!Number.isInteger(empresaId)) return res.status(404).send('Não encontrado.');

  let empresa;
  try {
    const r = await executeQuery(
      'SELECT id, mp_access_token, mp_webhook_secret FROM empresas WHERE id = $1 AND ativo',
      [empresaId]
    );
    empresa = r.recordset[0];
  } catch (err) {
    console.error('[webhook] Falha ao carregar empresa:', err);
    return res.status(500).send('Erro.');
  }
  if (!empresa) return res.status(404).send('Não encontrado.');

  const segredo = decifrar(empresa.mp_webhook_secret);
  if (!segredo) {
    console.error(`[webhook] empresa ${empresaId} sem segredo configurado — recusando.`);
    return res.status(503).send('Webhook não configurado.');
  }

  const dataId = (req.query && req.query['data.id']) ||
    (req.body && req.body.data && req.body.data.id) || null;

  const assinaturaOk = validarAssinatura({
    segredo,
    xSignature: req.headers['x-signature'],
    xRequestId: req.headers['x-request-id'],
    dataId,
  });
  if (!assinaturaOk) {
    console.error(`[webhook] assinatura inválida (empresa ${empresaId}).`);
    return res.status(401).send('Assinatura inválida.');
  }

  // Responde rápido: o MP re-tenta em timeout. O processamento segue depois.
  res.status(200).send('OK');

  const tipo = (req.body && (req.body.type || req.body.topic)) || req.query.type;
  if (tipo !== 'payment' || !dataId) return;

  // Se falhar aqui (rede, banco), o pagamento fica PENDENTE e o job de
  // reconciliação em jobs/expiracao.js pega depois — nada se perde por
  // termos respondido 200 antes de processar.
  processarPagamento(empresaId, empresa, String(dataId)).catch(err =>
    console.error('[webhook] falha ao processar pagamento:', err));
});

/**
 * Reprocessa pagamentos PENDENTES antigos consultando o Mercado Pago pela
 * preferência. Rede: o webhook pode ter se perdido; o dinheiro não pode.
 */
async function reconciliarPendentes(limiteMinutos = 10) {
  const corte = new Date(Date.now() - limiteMinutos * 60 * 1000).toISOString();
  const r = await executeQuery(
    `SELECT p.id, p.empresa_id, p.mp_preference_id,
            e.mp_access_token, e.mp_webhook_secret
       FROM pagamentos p
       JOIN empresas e ON e.id = p.empresa_id
      WHERE p.status = 'PENDENTE' AND p.mp_preference_id IS NOT NULL
        AND p.criado_em < $1 AND e.ativo
      ORDER BY p.criado_em LIMIT 50`,
    [corte]
  );
  if (!r.recordset.length) return 0;

  let recuperados = 0;
  for (const linha of r.recordset) {
    const accessToken = decifrar(linha.mp_access_token);
    if (!accessToken) continue;
    try {
      const busca = await buscarPagamentosDaPreferencia(accessToken, linha.mp_preference_id);
      const aprovado = busca.find(p => p.status === 'approved');
      if (!aprovado) continue;
      await processarPagamento(linha.empresa_id, {
        mp_access_token: linha.mp_access_token,
        mp_webhook_secret: linha.mp_webhook_secret,
      }, String(aprovado.id));
      recuperados += 1;
      console.log(`[reconciliar] pagamento ${linha.id} recuperado sem webhook.`);
    } catch (err) {
      console.error(`[reconciliar] falha no pagamento ${linha.id}:`, err.message);
    }
  }
  return recuperados;
}

async function processarPagamento(empresaId, empresa, paymentId) {
  const accessToken = decifrar(empresa.mp_access_token);
  if (!accessToken) {
    console.error(`[webhook] empresa ${empresaId} sem access token — não dá para conferir o pagamento.`);
    return;
  }

  // Nunca confiar no corpo do POST: re-consulta na API do MP.
  const pgto = await consultarPagamento(accessToken, paymentId);
  if (pgto.status !== 'approved') {
    console.log(`[webhook] pagamento ${paymentId} está ${pgto.status} — nada a fazer.`);
    return;
  }

  const referencia = String(pgto.external_reference || '');
  const m = /^pagamento:(\d+)$/.exec(referencia);
  if (!m) {
    console.error(`[webhook] external_reference inesperado: ${referencia}`);
    return;
  }
  const pagamentoId = parseInt(m[1], 10);
  const valorPago = Number(pgto.transaction_amount);

  await comTransacao(async (query) => {
    // Mesma trava por empresa que a criação de agendamento usa: creditar um
    // pedido pode inserir uma parada na agenda do veículo, e duas entregas
    // não podem cair no mesmo horário.
    await query('SELECT id FROM empresas WHERE id = $1 FOR UPDATE', [empresaId]);

    const rp = await query(
      `SELECT id, empresa_id, cliente_id, tipo, modelo_id, pedido_id,
              valor_centavos, status, pacote_id
         FROM pagamentos WHERE id = $1 AND empresa_id = $2 FOR UPDATE`,
      [pagamentoId, empresaId]
    );
    const pagamento = rp.recordset[0];
    if (!pagamento) {
      console.error(`[webhook] pagamento ${pagamentoId} não é da empresa ${empresaId}.`);
      return;
    }
    if (pagamento.status === 'APROVADO') {
      const rjaPago = await query(
        'SELECT mp_payment_id FROM pagamentos WHERE id = $1 AND empresa_id = $2',
        [pagamentoId, empresaId]
      );
      const anterior = rjaPago.recordset[0] && rjaPago.recordset[0].mp_payment_id;
      if (anterior && String(anterior) !== String(paymentId)) {
        // Dois pagamentos aprovados para a MESMA cobrança: o cliente pagou
        // duas vezes. Não credita de novo, mas registra para o petshop ver
        // e devolver — nunca some em silêncio.
        console.error(`[webhook] pagamento ${pagamentoId} recebeu segunda cobrança ${paymentId} (já pago em ${anterior}).`);
        await query(
          `INSERT INTO pagamentos (empresa_id, cliente_id, tipo, modelo_id, pedido_id,
                                   valor_centavos, status, mp_payment_id)
           VALUES ($1, $2, $3, $4, $5, $6, 'DUPLICADO', $7)
           ON CONFLICT (mp_payment_id) DO NOTHING`,
          [empresaId, pagamento.cliente_id, pagamento.tipo, pagamento.modelo_id,
           pagamento.pedido_id, Math.round(valorPago * 100), String(paymentId)]
        );
        return;
      }
      console.log(`[webhook] pagamento ${pagamentoId} já estava aprovado — ignorando repetição.`);
      return;
    }

    // O valor tem de bater com o preço do SERVIDOR, não com o que veio.
    const esperado = pagamento.valor_centavos / 100;
    if (Math.abs(valorPago - esperado) >= 0.01) {
      console.error(`[webhook] valor divergente no pagamento ${pagamentoId}: pago ${valorPago}, esperado ${esperado}.`);
      await query(
        `UPDATE pagamentos SET status = 'DIVERGENTE', mp_payment_id = $1 WHERE id = $2 AND empresa_id = $3`,
        [String(paymentId), pagamentoId, empresaId]
      );
      return;
    }

    if (pagamento.tipo === 'PACOTE') {
      await creditarPacote(query, { empresaId, pagamento, paymentId });
    } else if (pagamento.tipo === 'PEDIDO') {
      // Sem pedido_id não dá para baixar o pedido: aborta a transação para
      // NÃO marcar APROVADO (o MP re-tenta e a próxima passa).
      if (!pagamento.pedido_id) {
        throw new Error(`[webhook] pagamento ${pagamento.id} do tipo PEDIDO sem pedido_id.`);
      }

      const rped = await query(
        `SELECT id, entrega, cliente_id, status FROM pedidos
          WHERE id = $1 AND empresa_id = $2 FOR UPDATE`,
        [pagamento.pedido_id, empresaId]
      );
      const pedido = rped.recordset[0];
      if (!pedido) {
        throw new Error(`[webhook] pedido ${pagamento.pedido_id} não encontrado na empresa ${empresaId}.`);
      }

      // O dinheiro entrou para um pedido que já não está aberto (expirou
      // ou foi cancelado). NÃO aprova em silêncio, não agenda entrega:
      // registra para o petshop devolver ou refazer na mão.
      if (pedido.status !== 'AGUARDANDO_PAGAMENTO') {
        console.error(`[webhook] pagamento ${pagamentoId} aprovado para pedido ${pedido.id} em ${pedido.status} — conferência manual.`);
        await query(
          `UPDATE pagamentos SET status = 'PENDENTE_MANUAL', mp_payment_id = $1, aprovado_em = NOW()
            WHERE id = $2 AND empresa_id = $3`,
          [String(paymentId), pagamentoId, empresaId]
        );
        return;
      }

      await query(
        `UPDATE pedidos SET status = 'PAGO'
          WHERE id = $1 AND empresa_id = $2 AND status = 'AGUARDANDO_PAGAMENTO'`,
        [pagamento.pedido_id, empresaId]
      );

      // Pedido com entrega em casa entra na rota do veículo no próximo dia
      // com janela livre. Sem janela, o petshop combina manualmente (o
      // pedido continua pago e visível no painel).
      if (pedido.entrega === 'ENTREGA') {
        try {
          const { agendarEntrega } = require('./loja');
          let data = hojeSaoPaulo();
          let agendado = null;
          for (let i = 0; i < 7 && !agendado; i++) {
            try {
              agendado = await agendarEntrega(query, {
                empresaId, pedidoId: pagamento.pedido_id,
                clienteId: pedido.cliente_id, data,
              });
            } catch (_e) {
              data = proximoDia(data);
            }
          }
          if (!agendado) {
            console.warn(`[webhook] pedido ${pagamento.pedido_id} pago sem janela de entrega — combinar manualmente.`);
          }
        } catch (err) {
          console.error('[webhook] falha ao agendar entrega:', err.message);
        }
      }

      await query(
        `UPDATE pagamentos SET status = 'APROVADO', mp_payment_id = $1, aprovado_em = NOW()
          WHERE id = $2 AND empresa_id = $3`,
        [String(paymentId), pagamentoId, empresaId]
      );
    }
  });
}

// Cria o pacote com os itens do modelo — mesma regra da venda no balcão.
async function creditarPacote(query, { empresaId, pagamento, paymentId }) {
  // Mesma trava do balcão: modelo ativo e nenhum serviço desativado.
  // O crédito precisa ser usável, senão o cliente pagou por nada.
  const rm = await query(
    `SELECT nome, valor_centavos, validade_meses FROM pacotes_modelo
      WHERE id = $1 AND empresa_id = $2 AND ativo`,
    [pagamento.modelo_id, empresaId]
  );
  if (!rm.recordset.length) {
    console.error(`[webhook] modelo ${pagamento.modelo_id} sumiu — pagamento ${pagamento.id} sem crédito.`);
    await query(
      `UPDATE pagamentos SET status = 'PENDENTE_MANUAL', mp_payment_id = $1 WHERE id = $2 AND empresa_id = $3`,
      [String(paymentId), pagamento.id, empresaId]
    );
    return;
  }
  const modelo = rm.recordset[0];

  const ri = await query(
    `SELECT i.servico_id, i.quantidade, s.nome AS servico_nome
       FROM pacotes_modelo_itens i JOIN servicos s ON s.id = i.servico_id
      WHERE i.modelo_id = $1 AND i.empresa_id = $2 AND s.ativo ORDER BY i.id`,
    [pagamento.modelo_id, empresaId]
  );
  const totalItens = await query(
    'SELECT COUNT(*)::int AS total FROM pacotes_modelo_itens WHERE modelo_id = $1 AND empresa_id = $2',
    [pagamento.modelo_id, empresaId]
  );
  if (!ri.recordset.length || ri.recordset.length < totalItens.recordset[0].total) {
    console.error(`[webhook] modelo ${pagamento.modelo_id} sem itens usáveis — pagamento ${pagamento.id} para conferência manual.`);
    await query(
      `UPDATE pagamentos SET status = 'PENDENTE_MANUAL', mp_payment_id = $1 WHERE id = $2 AND empresa_id = $3`,
      [String(paymentId), pagamento.id, empresaId]
    );
    return;
  }

  const total = ri.recordset.reduce((soma, i) => soma + i.quantidade, 0);
  const compradoEm = hojeSaoPaulo();
  const validadeAte = modelo.validade_meses ? somarMeses(compradoEm, modelo.validade_meses) : null;

  const rpac = await query(
    `INSERT INTO pacotes (empresa_id, cliente_id, nome, qtd_banhos, valor_centavos,
                          saldo, status, comprado_em, validade_ate)
     VALUES ($1, $2, $3, $4, $5, $4, 'ATIVO', $6, $7)
     RETURNING id`,
    [empresaId, pagamento.cliente_id, modelo.nome, total, modelo.valor_centavos,
     compradoEm, validadeAte]
  );
  const pacoteId = rpac.recordset[0].id;

  for (const item of ri.recordset) {
    await query(
      `INSERT INTO pacotes_itens (empresa_id, pacote_id, servico_id, servico_nome, quantidade, saldo)
       VALUES ($1, $2, $3, $4, $5, $5)`,
      [empresaId, pacoteId, item.servico_id, item.servico_nome, item.quantidade]
    );
  }

  // mp_payment_id é UNIQUE: se o mesmo pagamento chegar duas vezes em
  // paralelo, o banco recusa a segunda e a transação inteira volta atrás.
  await query(
    `UPDATE pagamentos SET status = 'APROVADO', mp_payment_id = $1,
            pacote_id = $2, aprovado_em = NOW()
      WHERE id = $3 AND empresa_id = $4`,
    [String(paymentId), pacoteId, pagamento.id, empresaId]
  );

  console.log(`[webhook] pacote ${pacoteId} creditado ao cliente ${pagamento.cliente_id}.`);
}

// ─── Cliente fecha um pedido da loja ───────────────────────────────

router.post('/portal/:token/pedido', limiteCompra, async (req, res, next) => {
  try {
    const cliente = await clienteDaRequisicao(req);
    if (!cliente) return res.status(404).json({ erro: 'Link inválido.' });

    const accessToken = decifrar(cliente.mp_access_token);
    if (!accessToken) {
      return res.status(503).json({ erro: 'O petshop ainda não configurou o pagamento online.' });
    }

    const itens = (req.body || {}).itens;
    const entrega = (req.body || {}).entrega === 'ENTREGA' ? 'ENTREGA' : 'RETIRADA';
    const observacao = String((req.body || {}).observacao || '').trim().slice(0, 300) || null;
    if (!Array.isArray(itens) || !itens.length || itens.length > 30) {
      return res.status(400).json({ erro: 'Escolha de 1 a 30 produtos.' });
    }
    if (entrega === 'ENTREGA' && !cliente.endereco) {
      return res.status(400).json({ erro: 'Cadastre o endereço para receber em casa.' });
    }

    const empresaId = cliente.empresa_id;

    // Preço, estoque e taxa saem SEMPRE do servidor. Estoque é reservado
    // já na criação do pedido, dentro da transação.
    const criado = await comTransacao(async (query) => {
      const rEmp = await query(
        `SELECT vende_produtos, taxa_entrega_centavos, entrega_gratis_acima_centavos
           FROM empresas WHERE id = $1 FOR UPDATE`,
        [empresaId]
      );
      const emp = rEmp.recordset[0];
      if (!emp.vende_produtos) throw erroNegocio('Este petshop ainda não vende produtos pelo aplicativo.', 409);

      // Um cliente não pode segurar a loja inteira com pedidos que nunca
      // paga: no máximo 3 pedidos aguardando pagamento por vez.
      const abertos = await query(
        `SELECT COUNT(*)::int AS total FROM pedidos
          WHERE cliente_id = $1 AND empresa_id = $2 AND status = 'AGUARDANDO_PAGAMENTO'`,
        [cliente.id, empresaId]
      );
      if (abertos.recordset[0].total >= 3) {
        throw erroNegocio('Você tem pedidos aguardando pagamento. Conclua ou aguarde alguns minutos.', 409);
      }

      let subtotal = 0;
      const linhas = [];
      for (const item of itens) {
        const produtoId = parseInt(item && item.produto_id, 10);
        const quantidade = parseInt(item && item.quantidade, 10);
        if (!Number.isInteger(produtoId) || !Number.isInteger(quantidade) ||
            quantidade <= 0 || quantidade > 50) {
          throw erroNegocio('Item do pedido inválido.', 400);
        }
        const rprod = await query(
          `SELECT id, nome, preco_centavos, estoque, controla_estoque
             FROM produtos WHERE id = $1 AND empresa_id = $2 AND ativo FOR UPDATE`,
          [produtoId, empresaId]
        );
        const produto = rprod.recordset[0];
        if (!produto) throw erroNegocio('Produto indisponível.', 404);
        if (produto.controla_estoque && produto.estoque < quantidade) {
          throw erroNegocio(`Estoque insuficiente de ${produto.nome} (restam ${produto.estoque}).`, 409);
        }
        subtotal += produto.preco_centavos * quantidade;
        linhas.push({ produto, quantidade });
      }

      const gratis = emp.entrega_gratis_acima_centavos !== null &&
        emp.entrega_gratis_acima_centavos !== undefined &&
        subtotal >= emp.entrega_gratis_acima_centavos;
      const taxa = entrega === 'ENTREGA' && !gratis ? (emp.taxa_entrega_centavos || 0) : 0;
      const total = subtotal + taxa;
      if (total <= 0) throw erroNegocio('Pedido sem valor.', 400);

      const rped = await query(
        `INSERT INTO pedidos (empresa_id, cliente_id, valor_centavos, status, entrega, endereco, observacao)
         VALUES ($1, $2, $3, 'AGUARDANDO_PAGAMENTO', $4, $5, $6)
         RETURNING id`,
        [empresaId, cliente.id, total, entrega,
         entrega === 'ENTREGA' ? cliente.endereco : null, observacao]
      );
      const pedidoId = rped.recordset[0].id;

      for (const { produto, quantidade } of linhas) {
        await query(
          `INSERT INTO pedidos_itens (empresa_id, pedido_id, produto_id, produto_nome, preco_centavos, quantidade)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [empresaId, pedidoId, produto.id, produto.nome, produto.preco_centavos, quantidade]
        );
        if (produto.controla_estoque) {
          await query(
            'UPDATE produtos SET estoque = estoque - $1::int WHERE id = $2 AND empresa_id = $3',
            [quantidade, produto.id, empresaId]
          );
        }
      }

      const rpag = await query(
        `INSERT INTO pagamentos (empresa_id, cliente_id, tipo, pedido_id, valor_centavos, status)
         VALUES ($1, $2, 'PEDIDO', $3, $4, 'PENDENTE')
         RETURNING id`,
        [empresaId, cliente.id, pedidoId, total]
      );
      return { pedidoId, pagamentoId: rpag.recordset[0].id, total };
    });

    let preferencia;
    try {
      preferencia = await criarPreferencia(accessToken, {
        titulo: `Pedido #${criado.pedidoId} — ${cliente.empresa_nome}`,
        valorCentavos: criado.total,
        externalReference: `pagamento:${criado.pagamentoId}`,
        urlRetorno: urlDeRetorno(req),
        urlWebhook: `${APP_URL}/api/pagamentos/webhook/${empresaId}`,
        emailComprador: cliente.email || undefined,
        // Casado com o prazo de expirarPedidosAbandonados (60 min).
        expiraEmMinutos: 55,
      });
    } catch (err) {
      console.error('[pagamentos] Falha ao criar preferência do pedido:', err.corpoMP || err.message);
      // Devolve o estoque reservado — o pedido não vai acontecer. Com
      // trava e guard de status: se o job de expiração já tiver devolvido,
      // não devolve de novo.
      await comTransacao(async (query) => {
        const rp = await query(
          `SELECT id, status FROM pedidos WHERE id = $1 AND empresa_id = $2 FOR UPDATE`,
          [criado.pedidoId, empresaId]
        );
        if (!rp.recordset[0] || rp.recordset[0].status !== 'AGUARDANDO_PAGAMENTO') return;

        const itensReservados = await query(
          'SELECT produto_id, quantidade FROM pedidos_itens WHERE pedido_id = $1 AND empresa_id = $2',
          [criado.pedidoId, empresaId]
        );
        for (const item of itensReservados.recordset) {
          if (item.produto_id) {
            await query(
              `UPDATE produtos SET estoque = estoque + $1::int
                WHERE id = $2 AND empresa_id = $3 AND controla_estoque`,
              [item.quantidade, item.produto_id, empresaId]
            );
          }
        }
        await query(`UPDATE pedidos SET status = 'CANCELADO' WHERE id = $1 AND empresa_id = $2`,
          [criado.pedidoId, empresaId]);
        await query(`UPDATE pagamentos SET status = 'ERRO' WHERE id = $1 AND empresa_id = $2`,
          [criado.pagamentoId, empresaId]);
      });
      return res.status(502).json({ erro: 'Não foi possível abrir o pagamento agora. Tente de novo em instantes.' });
    }

    await executeQuery(
      'UPDATE pagamentos SET mp_preference_id = $1 WHERE id = $2 AND empresa_id = $3',
      [String(preferencia.id), criado.pagamentoId, empresaId]
    );

    res.status(201).json({
      pedido_id: criado.pedidoId,
      pagamento_id: criado.pagamentoId,
      valor_centavos: criado.total,
      url: preferencia.init_point || preferencia.sandbox_init_point,
    });
  } catch (err) {
    if (err.statusHttp) return res.status(err.statusHttp).json({ erro: err.message });
    next(err);
  }
});

// ─── Consulta de situação (o app do cliente faz polling após voltar) ──

router.get('/portal/:token/pagamentos', async (req, res, next) => {
  try {
    const cliente = await clienteDaRequisicao(req);
    if (!cliente) return res.status(404).json({ erro: 'Link inválido.' });
    const r = await executeQuery(
      `SELECT p.id, p.tipo, p.valor_centavos, p.status, p.criado_em, p.aprovado_em,
              m.nome AS pacote_nome
         FROM pagamentos p
         LEFT JOIN pacotes_modelo m ON m.id = p.modelo_id
        WHERE p.cliente_id = $1 AND p.empresa_id = $2
        ORDER BY p.criado_em DESC LIMIT 10`,
      [cliente.id, cliente.empresa_id]
    );
    res.json(r.recordset);
  } catch (err) {
    next(err);
  }
});

/**
 * Devolve o estoque de pedidos que ficaram sem pagamento. Sem isso, o
 * cliente que abandona o carrinho segura o produto para sempre — e um
 * abusador zera a loja de graça.
 */
async function expirarPedidosAbandonados(limiteMinutos = 60) {
  const corte = new Date(Date.now() - limiteMinutos * 60 * 1000).toISOString();
  const r = await executeQuery(
    `SELECT id, empresa_id FROM pedidos
      WHERE status = 'AGUARDANDO_PAGAMENTO' AND criado_em < $1
      ORDER BY criado_em LIMIT 200`,
    [corte]
  );
  if (!r.recordset.length) return 0;

  let expirados = 0;
  for (const pedido of r.recordset) {
    try {
      await comTransacao(async (query) => {
        const rp = await query(
          `SELECT id, status FROM pedidos WHERE id = $1 AND empresa_id = $2 FOR UPDATE`,
          [pedido.id, pedido.empresa_id]
        );
        // Pode ter sido pago entre a leitura e a trava.
        if (!rp.recordset[0] || rp.recordset[0].status !== 'AGUARDANDO_PAGAMENTO') return;

        // E o pagamento? Se já não está pendente (aprovado agora mesmo,
        // ou em conferência manual), não cancela nem devolve estoque.
        const rpag = await query(
          `SELECT id, status FROM pagamentos
            WHERE pedido_id = $1 AND empresa_id = $2 AND tipo = 'PEDIDO'
            ORDER BY id DESC FOR UPDATE`,
          [pedido.id, pedido.empresa_id]
        );
        const pendentes = rpag.recordset.filter(p => p.status === 'PENDENTE');
        if (rpag.recordset.length && !pendentes.length) return;

        const itens = await query(
          'SELECT produto_id, quantidade FROM pedidos_itens WHERE pedido_id = $1 AND empresa_id = $2',
          [pedido.id, pedido.empresa_id]
        );
        for (const item of itens.recordset) {
          if (item.produto_id) {
            await query(
              `UPDATE produtos SET estoque = estoque + $1::int
                WHERE id = $2 AND empresa_id = $3 AND controla_estoque`,
              [item.quantidade, item.produto_id, pedido.empresa_id]
            );
          }
        }
        await query(
          `UPDATE pedidos SET status = 'CANCELADO' WHERE id = $1 AND empresa_id = $2`,
          [pedido.id, pedido.empresa_id]
        );
        await query(
          `UPDATE pagamentos SET status = 'EXPIRADO'
            WHERE pedido_id = $1 AND empresa_id = $2 AND status = 'PENDENTE'`,
          [pedido.id, pedido.empresa_id]
        );
        expirados += 1;
      });
    } catch (err) {
      console.error(`[expirar] falha no pedido ${pedido.id}:`, err.message);
    }
  }
  if (expirados) console.log(`[expirar] ${expirados} pedido(s) sem pagamento — estoque devolvido.`);
  return expirados;
}

module.exports = router;
module.exports.reconciliarPendentes = reconciliarPendentes;
module.exports.expirarPedidosAbandonados = expirarPedidosAbandonados;
