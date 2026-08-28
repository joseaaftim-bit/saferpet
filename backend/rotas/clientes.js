'use strict';

const express = require('express');
const crypto = require('crypto');
const { executeQuery } = require('../database');
const { somenteAdmin } = require('../middlewares/autenticacao');
const { APP_URL } = require('../config/segredos');
const { hojeSaoPaulo } = require('../util/datas');

const router = express.Router();

function novoTokenPortal() {
  return crypto.randomBytes(24).toString('base64url');
}

function linkPortal(token) {
  return `${APP_URL}/portal/${token}`;
}

// Lista de clientes com pets, pacote ativo e última baixa — a tela principal.
// Consultas simples por empresa + junção em JS: portátil e fácil de auditar.
router.get('/', async (req, res, next) => {
  try {
    const empresaId = req.usuario.empresa_id;
    const [rc, rpets, rpacotes, rbaixas] = await Promise.all([
      executeQuery(
        'SELECT id, nome, telefone FROM clientes WHERE empresa_id = $1 AND ativo ORDER BY nome',
        [empresaId]
      ),
      executeQuery(
        'SELECT cliente_id, nome FROM pets WHERE empresa_id = $1 AND ativo ORDER BY nome',
        [empresaId]
      ),
      executeQuery(
        `SELECT id, cliente_id, nome, qtd_banhos, saldo, status, validade_ate, criado_em
           FROM pacotes WHERE empresa_id = $1 AND status = 'ATIVO' ORDER BY criado_em`,
        [empresaId]
      ),
      executeQuery(
        `SELECT pacote_id, MAX(registrado_em) AS ultima
           FROM baixas WHERE empresa_id = $1 AND estornada = FALSE GROUP BY pacote_id`,
        [empresaId]
      ),
    ]);

    const petsPorCliente = new Map();
    for (const p of rpets.recordset) {
      if (!petsPorCliente.has(p.cliente_id)) petsPorCliente.set(p.cliente_id, []);
      petsPorCliente.get(p.cliente_id).push(p.nome);
    }
    // Com mais de um pacote ativo, o MAIS ANTIGO é o que está em consumo
    // (regra da casa: gasta primeiro o que vence primeiro). Os demais somam
    // no saldo_total, para a lista não gritar "acabando" com pacote novo
    // cheio na fila.
    const pacotePorCliente = new Map();
    const saldoTotalPorCliente = new Map();
    const ativosPorCliente = new Map();
    for (const pa of rpacotes.recordset) {
      if (!pacotePorCliente.has(pa.cliente_id)) pacotePorCliente.set(pa.cliente_id, pa);
      saldoTotalPorCliente.set(pa.cliente_id, (saldoTotalPorCliente.get(pa.cliente_id) || 0) + pa.saldo);
      ativosPorCliente.set(pa.cliente_id, (ativosPorCliente.get(pa.cliente_id) || 0) + 1);
    }

    const ultimaPorPacote = new Map();
    for (const b of rbaixas.recordset) ultimaPorPacote.set(b.pacote_id, b.ultima);

    const busca = String(req.query.busca || '').trim().toLowerCase();
    const lista = rc.recordset
      .map(c => {
        const pets = petsPorCliente.get(c.id) || [];
        const pa = pacotePorCliente.get(c.id) || null;
        return {
          id: c.id,
          nome: c.nome,
          telefone: c.telefone,
          pets: pets.join(' e ') || null,
          pacote_id: pa ? pa.id : null,
          pacote_nome: pa ? pa.nome : null,
          qtd_banhos: pa ? pa.qtd_banhos : null,
          saldo: pa ? pa.saldo : null,
          saldo_total: pa ? saldoTotalPorCliente.get(c.id) : null,
          pacotes_ativos: pa ? ativosPorCliente.get(c.id) : 0,
          validade_ate: pa ? pa.validade_ate : null,
          ultima_baixa: pa ? (ultimaPorPacote.get(pa.id) || null) : null,
        };
      })
      .filter(c => !busca ||
        c.nome.toLowerCase().includes(busca) ||
        (c.pets || '').toLowerCase().includes(busca));

    res.json(lista);
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const { nome, telefone, email, observacoes } = req.body || {};
    if (!nome || !String(nome).trim()) {
      return res.status(400).json({ erro: 'Informe o nome do cliente.' });
    }
    const r = await executeQuery(
      `INSERT INTO clientes (empresa_id, nome, telefone, email, observacoes, token_portal)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, nome, telefone, email, observacoes, token_portal`,
      [
        req.usuario.empresa_id,
        String(nome).trim(),
        String(telefone || '').trim() || null,
        String(email || '').trim() || null,
        String(observacoes || '').trim() || null,
        novoTokenPortal(),
      ]
    );
    const cliente = r.recordset[0];
    res.status(201).json({ ...cliente, link_portal: linkPortal(cliente.token_portal) });
  } catch (err) {
    next(err);
  }
});

// Ficha completa: cliente + pets + pacotes + histórico de baixas.
router.get('/:id', async (req, res, next) => {
  try {
    const clienteId = parseInt(req.params.id, 10);
    if (!Number.isInteger(clienteId)) return res.status(404).json({ erro: 'Cliente não encontrado.' });

    const rc = await executeQuery(
      `SELECT id, nome, telefone, email, observacoes, token_portal, criado_em
         FROM clientes WHERE id = $1 AND empresa_id = $2 AND ativo`,
      [clienteId, req.usuario.empresa_id]
    );
    const cliente = rc.recordset[0];
    if (!cliente) return res.status(404).json({ erro: 'Cliente não encontrado.' });

    const [pets, pacotes, itens, baixas, agendamentos] = await Promise.all([
      executeQuery(
        `SELECT id, nome, raca, porte, observacoes FROM pets
          WHERE cliente_id = $1 AND empresa_id = $2 AND ativo ORDER BY nome`,
        [clienteId, req.usuario.empresa_id]
      ),
      executeQuery(
        `SELECT id, nome, qtd_banhos, valor_centavos, saldo, status,
                comprado_em, validade_ate
           FROM pacotes WHERE cliente_id = $1 AND empresa_id = $2
          ORDER BY criado_em DESC`,
        [clienteId, req.usuario.empresa_id]
      ),
      executeQuery(
        `SELECT i.id, i.pacote_id, i.servico_id, i.servico_nome, i.quantidade, i.saldo
           FROM pacotes_itens i
           JOIN pacotes p ON p.id = i.pacote_id
          WHERE p.cliente_id = $1 AND i.empresa_id = $2
          ORDER BY i.id`,
        [clienteId, req.usuario.empresa_id]
      ),
      executeQuery(
        `SELECT b.id, b.pacote_id, b.servico, b.observacao, b.saldo_apos,
                b.registrado_em, b.estornada, b.estornada_em,
                p.nome AS pet_nome, u.nome AS registrado_por_nome
           FROM baixas b
           LEFT JOIN pets p ON p.id = b.pet_id
           JOIN usuarios u ON u.id = b.registrado_por
           JOIN pacotes pa ON pa.id = b.pacote_id
          WHERE pa.cliente_id = $1 AND b.empresa_id = $2
          ORDER BY b.registrado_em DESC
          LIMIT 100`,
        [clienteId, req.usuario.empresa_id]
      ),
      executeQuery(
        `SELECT a.id, a.data, a.inicio, a.fim, a.tipo, a.status, a.agendamento_pai_id,
                p.nome AS pet_nome, s.nome AS servico_nome
           FROM agendamentos a
           LEFT JOIN pets p ON p.id = a.pet_id
           LEFT JOIN servicos s ON s.id = a.servico_id
          WHERE a.cliente_id = $1 AND a.empresa_id = $2
            AND a.status = 'AGENDADO' AND a.data >= $3
          ORDER BY a.data, a.inicio
          LIMIT 40`,
        [clienteId, req.usuario.empresa_id, hojeSaoPaulo()]
      ),
    ]);

    const itensPorPacote = new Map();
    for (const item of itens.recordset) {
      if (!itensPorPacote.has(item.pacote_id)) itensPorPacote.set(item.pacote_id, []);
      itensPorPacote.get(item.pacote_id).push(item);
    }

    // Marca leva-e-traz juntando os filhos (BUSCA/ENTREGA) em JS — portátil.
    const comBusca = new Set(
      agendamentos.recordset
        .filter(a => a.tipo === 'BUSCA' && a.agendamento_pai_id)
        .map(a => a.agendamento_pai_id)
    );
    const futuros = agendamentos.recordset
      .filter(a => a.tipo === 'SERVICO')
      .slice(0, 20)
      .map(a => ({ ...a, leva_traz: comBusca.has(a.id) }));

    res.json({
      ...cliente,
      link_portal: linkPortal(cliente.token_portal),
      pets: pets.recordset,
      pacotes: pacotes.recordset.map(p => ({ ...p, itens: itensPorPacote.get(p.id) || [] })),
      baixas: baixas.recordset,
      agendamentos: futuros,
    });
  } catch (err) {
    next(err);
  }
});

router.put('/:id', async (req, res, next) => {
  try {
    const clienteId = parseInt(req.params.id, 10);
    const { nome, telefone, email, observacoes } = req.body || {};
    if (!Number.isInteger(clienteId) || !nome || !String(nome).trim()) {
      return res.status(400).json({ erro: 'Dados inválidos.' });
    }
    const r = await executeQuery(
      `UPDATE clientes SET nome = $1, telefone = $2, email = $3, observacoes = $4
        WHERE id = $5 AND empresa_id = $6 AND ativo
        RETURNING id`,
      [
        String(nome).trim(),
        String(telefone || '').trim() || null,
        String(email || '').trim() || null,
        String(observacoes || '').trim() || null,
        clienteId,
        req.usuario.empresa_id,
      ]
    );
    if (!r.recordset.length) return res.status(404).json({ erro: 'Cliente não encontrado.' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Desativa (soft delete) — o histórico permanece.
router.delete('/:id', somenteAdmin, async (req, res, next) => {
  try {
    const clienteId = parseInt(req.params.id, 10);
    if (!Number.isInteger(clienteId)) return res.status(404).json({ erro: 'Cliente não encontrado.' });
    const r = await executeQuery(
      'UPDATE clientes SET ativo = FALSE WHERE id = $1 AND empresa_id = $2 RETURNING id',
      [clienteId, req.usuario.empresa_id]
    );
    if (!r.recordset.length) return res.status(404).json({ erro: 'Cliente não encontrado.' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Gera um novo link de portal (invalida o anterior, ex.: link vazado).
router.post('/:id/regenerar-token', somenteAdmin, async (req, res, next) => {
  try {
    const clienteId = parseInt(req.params.id, 10);
    if (!Number.isInteger(clienteId)) return res.status(404).json({ erro: 'Cliente não encontrado.' });
    const token = novoTokenPortal();
    const r = await executeQuery(
      `UPDATE clientes SET token_portal = $1
        WHERE id = $2 AND empresa_id = $3 AND ativo RETURNING token_portal`,
      [token, clienteId, req.usuario.empresa_id]
    );
    if (!r.recordset.length) return res.status(404).json({ erro: 'Cliente não encontrado.' });
    res.json({ token_portal: token, link_portal: linkPortal(token) });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
