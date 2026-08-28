'use strict';

// Loja do petshop: catálogo de produtos (painel) e pedidos.
// A entrega do pedido pago entra na agenda do veículo — o mesmo carro que
// devolve o pet leva a ração.

const express = require('express');
const { executeQuery, comTransacao } = require('../database');
const { somenteAdmin } = require('../middlewares/autenticacao');
const { hojeSaoPaulo } = require('../util/datas');
const { contextoDoDia } = require('../util/agendamentos');
const { primeiroEncaixe, agoraHHMMSaoPaulo } = require('../util/agenda');

const router = express.Router();

const DATA_RE = /^\d{4}-\d{2}-\d{2}$/;
// ~700 KB de base64 (a foto é reduzida no navegador antes de subir).
const LIMITE_FOTO = 700 * 1024;

function erroNegocio(mensagem, statusHttp) {
  return Object.assign(new Error(mensagem), { statusHttp });
}

// ─── Catálogo de produtos ──────────────────────────────────────────

router.get('/produtos', async (req, res, next) => {
  try {
    const r = await executeQuery(
      `SELECT id, nome, descricao, preco_centavos, estoque, controla_estoque, ativo, foto
         FROM produtos WHERE empresa_id = $1 ORDER BY nome`,
      [req.usuario.empresa_id]
    );
    res.json(r.recordset);
  } catch (err) {
    next(err);
  }
});

function validarProduto(corpo) {
  const nome = String((corpo || {}).nome || '').trim();
  const preco = parseInt((corpo || {}).preco_centavos, 10);
  const estoque = parseInt((corpo || {}).estoque, 10);
  if (!nome || !Number.isInteger(preco) || preco < 0 ||
      !Number.isInteger(estoque) || estoque < 0) {
    return null;
  }
  // Foto opcional. Vem reduzida do navegador; o limite é imposto aqui
  // porque o navegador do cliente não é confiável.
  const foto = (corpo || {}).foto;
  let fotoValidada;
  if (foto === null || foto === '') {
    fotoValidada = null;                   // apagar a foto
  } else if (typeof foto === 'string') {
    if (!/^data:image\/(jpeg|jpg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(foto)) return null;
    // Lança em vez de devolver sentinela: um chamador novo não tem como
    // esquecer de tratar e acabar gravando lixo.
    if (foto.length > LIMITE_FOTO) throw erroNegocio('Foto muito grande. Tire outra.', 413);
    fotoValidada = foto;
  } else {
    fotoValidada = undefined;              // não mexer na foto atual
  }

  return {
    nome: nome.slice(0, 120),
    descricao: String((corpo || {}).descricao || '').trim().slice(0, 500) || null,
    preco,
    estoque,
    controlaEstoque: (corpo || {}).controla_estoque !== false,
    foto: fotoValidada,
  };
}

router.post('/produtos', somenteAdmin, async (req, res, next) => {
  try {
    const dados = validarProduto(req.body);
    if (!dados) return res.status(400).json({ erro: 'Dados do produto inválidos.' });
    const r = await executeQuery(
      `INSERT INTO produtos (empresa_id, nome, descricao, preco_centavos, estoque, controla_estoque, foto)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, nome, descricao, preco_centavos, estoque, controla_estoque, ativo, foto`,
      [req.usuario.empresa_id, dados.nome, dados.descricao, dados.preco, dados.estoque,
       dados.controlaEstoque, dados.foto || null]
    );
    res.status(201).json(r.recordset[0]);
  } catch (err) {
    if (err.statusHttp) return res.status(err.statusHttp).json({ erro: err.message });
    next(err);
  }
});

router.put('/produtos/:id', somenteAdmin, async (req, res, next) => {
  try {
    const produtoId = parseInt(req.params.id, 10);
    const dados = validarProduto(req.body);
    if (!Number.isInteger(produtoId) || !dados) {
      return res.status(400).json({ erro: 'Dados do produto inválidos.' });
    }
    const ativo = typeof (req.body || {}).ativo === 'boolean' ? req.body.ativo : null;
    const empresaId = req.usuario.empresa_id;

    // O formulário manda o estoque que o admin VIU ao abrir a tela. Se
    // alguém comprou nesse meio-tempo, gravar o número cru desfaz a
    // reserva. Aplicamos a DIFERENÇA sobre o valor atual, em transação.
    const atualizado = await comTransacao(async (query) => {
      const r = await query(
        `SELECT id, estoque FROM produtos WHERE id = $1 AND empresa_id = $2 FOR UPDATE`,
        [produtoId, empresaId]
      );
      const atual = r.recordset[0];
      if (!atual) return null;

      const visto = parseInt((req.body || {}).estoque_visto, 10);
      let novoEstoque = dados.estoque;
      if (Number.isInteger(visto) && visto !== atual.estoque) {
        const diferenca = dados.estoque - visto;
        novoEstoque = Math.max(0, atual.estoque + diferenca);
      }

      const up = await query(
        `UPDATE produtos SET nome = $1, descricao = $2, preco_centavos = $3,
                estoque = $4, controla_estoque = $5, ativo = COALESCE($6, ativo),
                foto = CASE WHEN $7::boolean THEN $8 ELSE foto END
          WHERE id = $9 AND empresa_id = $10
          RETURNING id, nome, descricao, preco_centavos, estoque, controla_estoque, ativo, foto`,
        [dados.nome, dados.descricao, dados.preco, novoEstoque, dados.controlaEstoque,
         ativo, dados.foto !== undefined, dados.foto === undefined ? null : dados.foto,
         produtoId, empresaId]
      );
      return up.recordset[0];
    });

    if (!atualizado) return res.status(404).json({ erro: 'Produto não encontrado.' });
    res.json(atualizado);
  } catch (err) {
    if (err.statusHttp) return res.status(err.statusHttp).json({ erro: err.message });
    next(err);
  }
});

// ─── Pedidos (painel do petshop) ───────────────────────────────────

// Transições permitidas. Voltar para AGUARDANDO_PAGAMENTO entregaria um
// pedido pago ao job de expiração, que devolveria o estoque de graça.
const TRANSICOES = {
  AGUARDANDO_PAGAMENTO: ['CANCELADO'],
  PAGO: ['SEPARADO', 'EM_ROTA', 'ENTREGUE', 'CANCELADO'],
  SEPARADO: ['EM_ROTA', 'ENTREGUE', 'CANCELADO'],
  EM_ROTA: ['ENTREGUE', 'CANCELADO'],
  ENTREGUE: [],
  CANCELADO: [],
};

router.get('/pedidos', async (req, res, next) => {
  try {
    const empresaId = req.usuario.empresa_id;
    const [pedidos, itens] = await Promise.all([
      executeQuery(
        `SELECT p.id, p.valor_centavos, p.status, p.entrega, p.endereco, p.observacao,
                p.criado_em, p.entregue_em, p.agendamento_id,
                c.id AS cliente_id, c.nome AS cliente_nome, c.telefone,
                a.data AS entrega_data, a.inicio AS entrega_inicio
           FROM pedidos p
           JOIN clientes c ON c.id = p.cliente_id
           LEFT JOIN agendamentos a ON a.id = p.agendamento_id
          WHERE p.empresa_id = $1
          ORDER BY p.criado_em DESC LIMIT 100`,
        [empresaId]),
      // Só os itens dos pedidos que a tela mostra — não o histórico todo.
      executeQuery(
        `SELECT i.pedido_id, i.produto_nome, i.preco_centavos, i.quantidade
           FROM pedidos_itens i
           JOIN pedidos p ON p.id = i.pedido_id
          WHERE i.empresa_id = $1
            AND p.id IN (SELECT id FROM pedidos WHERE empresa_id = $1
                          ORDER BY criado_em DESC LIMIT 100)
          ORDER BY i.id`,
        [empresaId]),
    ]);

    const porPedido = new Map();
    for (const item of itens.recordset) {
      if (!porPedido.has(item.pedido_id)) porPedido.set(item.pedido_id, []);
      porPedido.get(item.pedido_id).push(item);
    }
    res.json(pedidos.recordset.map(p => ({ ...p, itens: porPedido.get(p.id) || [] })));
  } catch (err) {
    next(err);
  }
});

// Avança a situação do pedido. Ao marcar ENTREGUE, conclui a parada do
// veículo; ao CANCELAR, devolve o estoque e libera a parada.
router.put('/pedidos/:id', async (req, res, next) => {
  try {
    const pedidoId = parseInt(req.params.id, 10);
    const status = String((req.body || {}).status || '');
    if (!Number.isInteger(pedidoId) || !Object.keys(TRANSICOES).includes(status)) {
      return res.status(400).json({ erro: 'Situação inválida.' });
    }
    const empresaId = req.usuario.empresa_id;

    const resultado = await comTransacao(async (query) => {
      const rp = await query(
        `SELECT id, status, agendamento_id FROM pedidos
          WHERE id = $1 AND empresa_id = $2 FOR UPDATE`,
        [pedidoId, empresaId]
      );
      const pedido = rp.recordset[0];
      if (!pedido) throw erroNegocio('Pedido não encontrado.', 404);
      if (!(TRANSICOES[pedido.status] || []).includes(status)) {
        throw erroNegocio(
          `Não dá para mudar um pedido ${String(pedido.status).toLowerCase().replace(/_/g, ' ')} para ${String(status).toLowerCase().replace(/_/g, ' ')}.`,
          409
        );
      }

      if (status === 'CANCELADO') {
        const itens = await query(
          'SELECT produto_id, quantidade FROM pedidos_itens WHERE pedido_id = $1 AND empresa_id = $2',
          [pedidoId, empresaId]
        );
        for (const item of itens.recordset) {
          if (item.produto_id) {
            await query(
              `UPDATE produtos SET estoque = estoque + $1::int
                WHERE id = $2 AND empresa_id = $3 AND controla_estoque`,
              [item.quantidade, item.produto_id, empresaId]
            );
          }
        }
        if (pedido.agendamento_id) {
          await query(
            `UPDATE agendamentos SET status = 'CANCELADO'
              WHERE id = $1 AND empresa_id = $2 AND status = 'AGENDADO'`,
            [pedido.agendamento_id, empresaId]
          );
        }
        // Fecha o pagamento pendente: senão a reconciliação vai buscar no
        // Mercado Pago um pedido que já morreu.
        await query(
          `UPDATE pagamentos SET status = 'CANCELADO'
            WHERE pedido_id = $1 AND empresa_id = $2 AND status = 'PENDENTE'`,
          [pedidoId, empresaId]
        );
      }

      if (status === 'ENTREGUE' && pedido.agendamento_id) {
        await query(
          `UPDATE agendamentos SET status = 'CONCLUIDO'
            WHERE id = $1 AND empresa_id = $2 AND status = 'AGENDADO'`,
          [pedido.agendamento_id, empresaId]
        );
      }

      const r = await query(
        `UPDATE pedidos SET status = $1,
                entregue_em = CASE WHEN $1 = 'ENTREGUE' THEN NOW() ELSE entregue_em END
          WHERE id = $2 AND empresa_id = $3
          RETURNING id, status, entregue_em`,
        [status, pedidoId, empresaId]
      );
      return r.recordset[0];
    });

    res.json(resultado);
  } catch (err) {
    if (err.statusHttp) return res.status(err.statusHttp).json({ erro: err.message });
    next(err);
  }
});

/**
 * Agenda a entrega de um pedido pago na rota do veículo: primeiro encaixe
 * livre no dia pedido. Compartilhado com o fluxo do cliente.
 */
async function agendarEntrega(query, { empresaId, pedidoId, clienteId, data }) {
  const ctx = await contextoDoDia(query, empresaId, data);
  if (ctx.fechado || !ctx.periodos.length) throw erroNegocio('O petshop não abre neste dia.', 409);
  if (!ctx.veiculos.length) throw erroNegocio('Este petshop não faz entrega.', 409);

  const aPartirDe = data === hojeSaoPaulo()
    ? agoraHHMMSaoPaulo()
    : ctx.periodos[0].inicio;

  const encaixe = primeiroEncaixe({
    periodos: ctx.periodos, recursos: ctx.veiculos,
    ocupacoes: ctx.ocupacoes, aPartirDe, duracao: ctx.desloc,
  });
  if (!encaixe) throw erroNegocio('Sem janela de entrega neste dia. Escolha outro.', 409);

  const ra = await query(
    `INSERT INTO agendamentos (empresa_id, cliente_id, recurso_id, tipo, data, inicio, fim,
                               observacao, origem)
     VALUES ($1, $2, $3, 'ENTREGA', $4, $5, $6, $7, 'CLIENTE')
     RETURNING id, data, inicio, fim`,
    [empresaId, clienteId, encaixe.recurso_id, data, encaixe.inicio, encaixe.fim,
     `Entrega do pedido #${pedidoId}`]
  );
  const agendamento = ra.recordset[0];
  await query(
    'UPDATE pedidos SET agendamento_id = $1 WHERE id = $2 AND empresa_id = $3',
    [agendamento.id, pedidoId, empresaId]
  );
  return agendamento;
}

// Petshop agenda/reagenda a entrega manualmente.
router.post('/pedidos/:id/entrega', async (req, res, next) => {
  try {
    const pedidoId = parseInt(req.params.id, 10);
    const data = String((req.body || {}).data || '');
    if (!Number.isInteger(pedidoId) || !DATA_RE.test(data)) {
      return res.status(400).json({ erro: 'Informe a data da entrega.' });
    }
    if (data < hojeSaoPaulo()) return res.status(400).json({ erro: 'Data no passado.' });
    const empresaId = req.usuario.empresa_id;

    const resultado = await comTransacao(async (query) => {
      await query('SELECT id FROM empresas WHERE id = $1 FOR UPDATE', [empresaId]);
      const rp = await query(
        `SELECT id, cliente_id, status, entrega, agendamento_id FROM pedidos
          WHERE id = $1 AND empresa_id = $2 FOR UPDATE`,
        [pedidoId, empresaId]
      );
      const pedido = rp.recordset[0];
      if (!pedido) throw erroNegocio('Pedido não encontrado.', 404);
      if (pedido.entrega !== 'ENTREGA') throw erroNegocio('Este pedido é para retirada no balcão.', 409);
      if (!['PAGO', 'SEPARADO', 'EM_ROTA'].includes(pedido.status)) {
        throw erroNegocio('Só é possível agendar a entrega de um pedido pago.', 409);
      }

      if (pedido.agendamento_id) {
        await query(
          `UPDATE agendamentos SET status = 'CANCELADO'
            WHERE id = $1 AND empresa_id = $2 AND status = 'AGENDADO'`,
          [pedido.agendamento_id, empresaId]
        );
      }
      return agendarEntrega(query, {
        empresaId, pedidoId, clienteId: pedido.cliente_id, data,
      });
    });

    res.json(resultado);
  } catch (err) {
    if (err.statusHttp) return res.status(err.statusHttp).json({ erro: err.message });
    next(err);
  }
});

module.exports = router;
module.exports.agendarEntrega = agendarEntrega;
