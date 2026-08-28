'use strict';

const express = require('express');
const { executeQuery, comTransacao } = require('../database');
const { hojeSaoPaulo } = require('../util/datas');
const { consumirUmCredito, saldosPorServico } = require('../util/creditos');

const router = express.Router();

function erroNegocio(mensagem, statusHttp) {
  return Object.assign(new Error(mensagem), { statusHttp });
}

// ─── Baixa manual (balcão, sem agendamento) ────────────────────────
// Cada item nomeia o serviço consumido; o crédito sai do pacote mais
// antigo do cliente que tenha aquele serviço (FIFO), tudo em UMA transação.
// Sem crédito para algum item, NADA é gravado (409).

router.post('/', async (req, res, next) => {
  try {
    const { cliente_id, itens, observacao } = req.body || {};
    const clienteId = parseInt(cliente_id, 10);

    if (!Number.isInteger(clienteId)) {
      return res.status(400).json({ erro: 'Informe o cliente.' });
    }
    if (!Array.isArray(itens) || !itens.length || itens.length > 10) {
      return res.status(400).json({ erro: 'Informe de 1 a 10 itens por vez.' });
    }
    const empresaId = req.usuario.empresa_id;

    const resultado = await comTransacao(async (query) => {
      const rc = await query(
        'SELECT id FROM clientes WHERE id = $1 AND empresa_id = $2 AND ativo',
        [clienteId, empresaId]
      );
      if (!rc.recordset.length) throw erroNegocio('Cliente não encontrado.', 404);

      const registradas = [];
      for (const item of itens) {
        const servicoId = parseInt(item && item.servico_id, 10);
        if (!Number.isInteger(servicoId)) throw erroNegocio('Serviço inválido.', 400);

        const petId = item && item.pet_id !== undefined && item.pet_id !== null && item.pet_id !== ''
          ? parseInt(item.pet_id, 10) : null;
        if (petId !== null) {
          if (!Number.isInteger(petId)) throw erroNegocio('Pet inválido.', 400);
          const rp = await query(
            'SELECT id FROM pets WHERE id = $1 AND empresa_id = $2 AND cliente_id = $3 AND ativo',
            [petId, empresaId, clienteId]
          );
          if (!rp.recordset.length) throw erroNegocio('Pet não pertence a este cliente.', 400);
        }

        const rs = await query(
          'SELECT nome FROM servicos WHERE id = $1 AND empresa_id = $2',
          [servicoId, empresaId]
        );
        if (!rs.recordset.length) throw erroNegocio('Serviço não encontrado.', 404);

        const baixa = await consumirUmCredito(query, {
          empresaId, clienteId, servicoId,
          servicoNome: rs.recordset[0].nome, petId,
          observacao: String(observacao || '').trim() || null,
          usuarioId: req.usuario.id,
        });
        if (!baixa) {
          throw erroNegocio(`Cliente sem crédito de "${rs.recordset[0].nome}" disponível.`, 409);
        }
        registradas.push(baixa);
      }

      const saldos = await saldosPorServico(query, empresaId, clienteId);
      let saldoTotal = 0;
      for (const total of saldos.values()) saldoTotal += total;
      return { baixas: registradas, saldo: saldoTotal };
    });

    res.status(201).json(resultado);
  } catch (err) {
    if (err.statusHttp) return res.status(err.statusHttp).json({ erro: err.message });
    next(err);
  }
});

// ─── Estorno ───────────────────────────────────────────────────────
// Devolve 1 crédito ao ITEM de onde saiu. Atendente só estorna baixa do
// mesmo dia; administrador estorna qualquer uma.

router.post('/:id/estornar', async (req, res, next) => {
  try {
    const baixaId = parseInt(req.params.id, 10);
    if (!Number.isInteger(baixaId)) return res.status(404).json({ erro: 'Baixa não encontrada.' });
    const empresaId = req.usuario.empresa_id;

    const resultado = await comTransacao(async (query) => {
      const rb = await query(
        `SELECT b.id, b.pacote_id, b.pacote_item_id, b.estornada, b.registrado_em,
                p.saldo AS pacote_saldo, p.qtd_banhos, p.status,
                i.saldo AS item_saldo, i.quantidade AS item_quantidade
           FROM baixas b
           JOIN pacotes p ON p.id = b.pacote_id
           LEFT JOIN pacotes_itens i ON i.id = b.pacote_item_id
          WHERE b.id = $1 AND b.empresa_id = $2
          FOR UPDATE OF b, p`,
        [baixaId, empresaId]
      );
      const baixa = rb.recordset[0];
      if (!baixa) throw erroNegocio('Baixa não encontrada.', 404);
      if (baixa.estornada) throw erroNegocio('Esta baixa já foi estornada.', 409);
      if (!baixa.pacote_item_id) throw erroNegocio('Baixa antiga sem item de crédito — estorno manual pelo suporte.', 409);

      if (req.usuario.permissoes !== 'ADMINISTRADOR') {
        const dataBaixa = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Sao_Paulo' })
          .format(new Date(baixa.registrado_em));
        if (dataBaixa !== hojeSaoPaulo()) {
          throw erroNegocio('Atendente só estorna baixa do mesmo dia. Peça a um administrador.', 403);
        }
      }
      if (baixa.item_saldo >= baixa.item_quantidade) {
        throw erroNegocio('O crédito deste item já está cheio — nada a estornar.', 409);
      }

      await query(
        `UPDATE baixas SET estornada = TRUE, estornada_por = $1, estornada_em = NOW()
          WHERE id = $2 AND empresa_id = $3`,
        [req.usuario.id, baixaId, empresaId]
      );
      await query(
        'UPDATE pacotes_itens SET saldo = saldo + 1 WHERE id = $1 AND empresa_id = $2',
        [baixa.pacote_item_id, empresaId]
      );
      const novoSaldoPacote = baixa.pacote_saldo + 1;
      const novoStatus = baixa.status === 'ESGOTADO' ? 'ATIVO' : baixa.status;
      await query(
        'UPDATE pacotes SET saldo = $1, status = $2 WHERE id = $3 AND empresa_id = $4',
        [novoSaldoPacote, novoStatus, baixa.pacote_id, empresaId]
      );

      return { saldo: novoSaldoPacote, status: novoStatus };
    });

    res.json(resultado);
  } catch (err) {
    if (err.statusHttp) return res.status(err.statusHttp).json({ erro: err.message });
    next(err);
  }
});

// Últimas baixas do petshop (alimenta a visão geral).
router.get('/recentes', async (req, res, next) => {
  try {
    const limite = Math.min(parseInt(req.query.limite, 10) || 20, 50);
    const r = await executeQuery(
      `SELECT b.id, b.servico, b.saldo_apos, b.registrado_em, b.estornada,
              p.nome AS pet_nome, c.nome AS cliente_nome, c.id AS cliente_id,
              u.nome AS registrado_por_nome
         FROM baixas b
         JOIN pacotes pa ON pa.id = b.pacote_id
         JOIN clientes c ON c.id = pa.cliente_id
         LEFT JOIN pets p ON p.id = b.pet_id
         JOIN usuarios u ON u.id = b.registrado_por
        WHERE b.empresa_id = $1
        ORDER BY b.registrado_em DESC
        LIMIT $2`,
      [req.usuario.empresa_id, limite]
    );
    res.json(r.recordset);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
