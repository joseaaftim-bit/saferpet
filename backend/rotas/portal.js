'use strict';

// Portal do cliente: acesso público por token único (link enviado por
// WhatsApp). Sem login — o token de 24 bytes aleatórios É a credencial.
// Tudo que sai daqui é filtrado pelo cliente dono do token.

const express = require('express');
const { executeQuery } = require('../database');
const { hojeSaoPaulo } = require('../util/datas');

const router = express.Router();

router.get('/:token', async (req, res, next) => {
  try {
    const token = String(req.params.token || '');
    if (token.length < 20 || token.length > 64) {
      return res.status(404).json({ erro: 'Link inválido.' });
    }

    const rc = await executeQuery(
      `SELECT c.id, c.nome, c.empresa_id,
              e.nome AS petshop_nome, e.whatsapp AS petshop_whatsapp,
              e.acesso_ate, e.ativo AS empresa_ativa
         FROM clientes c
         JOIN empresas e ON e.id = c.empresa_id
        WHERE c.token_portal = $1 AND c.ativo`,
      [token]
    );
    const cliente = rc.recordset[0];
    if (!cliente || !cliente.empresa_ativa) {
      return res.status(404).json({ erro: 'Link inválido.' });
    }
    if (new Date(cliente.acesso_ate).getTime() < Date.now()) {
      return res.status(503).json({ erro: 'Portal temporariamente indisponível. Fale direto com o petshop.' });
    }

    const [pets, pacotes, itens, baixas, agendamentos] = await Promise.all([
      executeQuery(
        `SELECT nome, raca, porte FROM pets
          WHERE cliente_id = $1 AND empresa_id = $2 AND ativo ORDER BY nome`,
        [cliente.id, cliente.empresa_id]
      ),
      executeQuery(
        `SELECT id, nome, qtd_banhos, saldo, status, validade_ate FROM pacotes
          WHERE cliente_id = $1 AND empresa_id = $2 AND status IN ('ATIVO', 'ESGOTADO')
          ORDER BY CASE WHEN status = 'ATIVO' THEN 0 ELSE 1 END, criado_em
          LIMIT 3`,
        [cliente.id, cliente.empresa_id]
      ),
      executeQuery(
        `SELECT i.pacote_id, i.servico_nome, i.quantidade, i.saldo
           FROM pacotes_itens i
           JOIN pacotes p ON p.id = i.pacote_id
          WHERE p.cliente_id = $1 AND i.empresa_id = $2
          ORDER BY i.id`,
        [cliente.id, cliente.empresa_id]
      ),
      executeQuery(
        `SELECT b.servico, b.saldo_apos, b.registrado_em, p.nome AS pet_nome
           FROM baixas b
           JOIN pacotes pa ON pa.id = b.pacote_id
           LEFT JOIN pets p ON p.id = b.pet_id
          WHERE pa.cliente_id = $1 AND b.empresa_id = $2 AND b.estornada = FALSE
          ORDER BY b.registrado_em DESC LIMIT 10`,
        [cliente.id, cliente.empresa_id]
      ),
      executeQuery(
        `SELECT a.id, a.data, a.inicio, a.status, a.tipo, a.agendamento_pai_id,
                p.nome AS pet_nome, s.nome AS servico_nome
           FROM agendamentos a
           LEFT JOIN pets p ON p.id = a.pet_id
           LEFT JOIN servicos s ON s.id = a.servico_id
          WHERE a.cliente_id = $1 AND a.empresa_id = $2
            AND a.status = 'AGENDADO' AND a.data >= $3
          ORDER BY a.data, a.inicio
          LIMIT 15`,
        [cliente.id, cliente.empresa_id, hojeSaoPaulo()]
      ),
    ]);

    const comBusca = new Set(
      agendamentos.recordset
        .filter(a => a.tipo === 'BUSCA' && a.agendamento_pai_id)
        .map(a => a.agendamento_pai_id)
    );
    const futuros = agendamentos.recordset
      .filter(a => a.tipo === 'SERVICO')
      .slice(0, 5)
      .map(a => ({
        data: a.data, inicio: a.inicio, status: a.status,
        pet_nome: a.pet_nome, servico_nome: a.servico_nome,
        leva_traz: comBusca.has(a.id),
      }));

    const itensPorPacote = new Map();
    for (const item of itens.recordset) {
      if (!itensPorPacote.has(item.pacote_id)) itensPorPacote.set(item.pacote_id, []);
      itensPorPacote.get(item.pacote_id).push({
        servico_nome: item.servico_nome, quantidade: item.quantidade, saldo: item.saldo,
      });
    }

    res.json({
      petshop: { nome: cliente.petshop_nome, whatsapp: cliente.petshop_whatsapp },
      cliente: { nome: cliente.nome },
      pets: pets.recordset,
      pacotes: pacotes.recordset.map(p => ({ ...p, itens: itensPorPacote.get(p.id) || [] })),
      ultimas_baixas: baixas.recordset,
      agendamentos: futuros,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
