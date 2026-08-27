'use strict';

// Portal do cliente: acesso público por token único (link enviado por
// WhatsApp). Sem login — o token de 24 bytes aleatórios É a credencial.
// Tudo que sai daqui é filtrado pelo cliente dono do token.

const express = require('express');
const { executeQuery } = require('../database');

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

    const [pets, pacotes, baixas] = await Promise.all([
      executeQuery(
        `SELECT nome, raca, porte FROM pets
          WHERE cliente_id = $1 AND empresa_id = $2 AND ativo ORDER BY nome`,
        [cliente.id, cliente.empresa_id]
      ),
      executeQuery(
        `SELECT nome, qtd_banhos, saldo, status, validade_ate FROM pacotes
          WHERE cliente_id = $1 AND empresa_id = $2 AND status IN ('ATIVO', 'ESGOTADO')
          ORDER BY CASE WHEN status = 'ATIVO' THEN 0 ELSE 1 END, criado_em
          LIMIT 3`,
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
    ]);

    res.json({
      petshop: { nome: cliente.petshop_nome, whatsapp: cliente.petshop_whatsapp },
      cliente: { nome: cliente.nome },
      pets: pets.recordset,
      pacotes: pacotes.recordset,
      ultimas_baixas: baixas.recordset,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
