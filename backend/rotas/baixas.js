'use strict';

const express = require('express');
const { executeQuery, comTransacao } = require('../database');
const { hojeSaoPaulo, vencido } = require('../util/datas');

const router = express.Router();

function erroNegocio(mensagem, statusHttp) {
  return Object.assign(new Error(mensagem), { statusHttp });
}

// ─── Registrar baixa(s) ────────────────────────────────────────────
// Uma requisição pode debitar vários banhos de uma vez (mandou as duas
// cachorras: 2 itens, 2 baixas). Tudo em UMA transação com as linhas dos
// pacotes do cliente travadas (FOR UPDATE) — duas atendentes registrando
// ao mesmo tempo nunca deixam o saldo negativo nem furam a contagem.
//
// Transbordo FIFO: se o pacote alvo não cobre todos os itens, o resto sai
// dos demais pacotes ATIVO (não vencidos) do mesmo cliente, do mais antigo
// para o mais novo. Cliente com 1 banho no pacote velho + 24 no novo dá
// baixa das duas cachorras numa operação só.

router.post('/', async (req, res, next) => {
  try {
    const { pacote_id, itens, observacao } = req.body || {};
    const pacoteId = parseInt(pacote_id, 10);

    if (!Number.isInteger(pacoteId)) {
      return res.status(400).json({ erro: 'Informe o pacote.' });
    }
    if (!Array.isArray(itens) || !itens.length || itens.length > 10) {
      return res.status(400).json({ erro: 'Informe de 1 a 10 banhos por vez.' });
    }
    for (const item of itens) {
      if (item && item.pet_id !== undefined && item.pet_id !== null &&
          !Number.isInteger(parseInt(item.pet_id, 10))) {
        return res.status(400).json({ erro: 'Pet inválido.' });
      }
    }

    const resultado = await comTransacao(async (query) => {
      const rp = await query(
        `SELECT id, cliente_id, qtd_banhos, saldo, status, validade_ate
           FROM pacotes WHERE id = $1 AND empresa_id = $2 FOR UPDATE`,
        [pacoteId, req.usuario.empresa_id]
      );
      const alvo = rp.recordset[0];
      if (!alvo) throw erroNegocio('Pacote não encontrado.', 404);
      if (alvo.status !== 'ATIVO') {
        throw erroNegocio(`Este pacote está ${String(alvo.status).toLowerCase()} — não é possível dar baixa.`, 409);
      }
      const hoje = hojeSaoPaulo();
      if (vencido(alvo.validade_ate, hoje)) {
        throw erroNegocio('Este pacote está vencido. Um administrador pode prorrogar a validade na ficha do cliente.', 409);
      }

      // Todos os pacotes ATIVO do cliente, travados em ordem estável.
      const rTodos = await query(
        `SELECT id, saldo, status, validade_ate
           FROM pacotes
          WHERE cliente_id = $1 AND empresa_id = $2 AND status = 'ATIVO'
          ORDER BY criado_em, id
          FOR UPDATE`,
        [alvo.cliente_id, req.usuario.empresa_id]
      );
      const demais = rTodos.recordset
        .filter(p => p.id !== alvo.id && !vencido(p.validade_ate, hoje));
      const fila = [
        { id: alvo.id, saldo: alvo.saldo },
        ...demais.map(p => ({ id: p.id, saldo: p.saldo })),
      ];

      const saldoTotal = fila.reduce((soma, p) => soma + p.saldo, 0);
      if (saldoTotal < itens.length) {
        throw erroNegocio(`Saldo insuficiente: restam ${saldoTotal} banho(s) para este cliente.`, 409);
      }

      let posicao = 0;
      const registradas = [];
      const tocados = new Map();
      for (const item of itens) {
        const petId = item && item.pet_id !== undefined && item.pet_id !== null
          ? parseInt(item.pet_id, 10) : null;

        if (petId !== null) {
          const rpet = await query(
            'SELECT id FROM pets WHERE id = $1 AND empresa_id = $2 AND cliente_id = $3 AND ativo',
            [petId, req.usuario.empresa_id, alvo.cliente_id]
          );
          if (!rpet.recordset.length) {
            throw erroNegocio('Pet não pertence ao dono deste pacote.', 400);
          }
        }

        while (fila[posicao].saldo === 0) posicao += 1;
        const fonte = fila[posicao];
        fonte.saldo -= 1;
        tocados.set(fonte.id, fonte.saldo);

        const servico = String((item && item.servico) || 'Banho').trim().slice(0, 120) || 'Banho';
        const rb = await query(
          `INSERT INTO baixas (empresa_id, pacote_id, pet_id, servico, observacao,
                               saldo_apos, registrado_por)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING id, pacote_id, pet_id, servico, saldo_apos, registrado_em`,
          [req.usuario.empresa_id, fonte.id, petId, servico,
           String(observacao || '').trim() || null, fonte.saldo, req.usuario.id]
        );
        registradas.push(rb.recordset[0]);
      }

      for (const [id, saldo] of tocados) {
        await query(
          'UPDATE pacotes SET saldo = $1, status = $2 WHERE id = $3 AND empresa_id = $4',
          [saldo, saldo === 0 ? 'ESGOTADO' : 'ATIVO', id, req.usuario.empresa_id]
        );
      }

      const saldoRestante = fila.reduce((soma, p) => soma + p.saldo, 0);
      const statusAlvo = fila[0].saldo === 0 ? 'ESGOTADO' : 'ATIVO';
      return { saldo: saldoRestante, status: statusAlvo, baixas: registradas };
    });

    res.status(201).json(resultado);
  } catch (err) {
    if (err.statusHttp) return res.status(err.statusHttp).json({ erro: err.message });
    next(err);
  }
});

// ─── Estorno ───────────────────────────────────────────────────────
// Corrige registro errado sem apagar nada: a baixa fica marcada como
// estornada e o saldo volta. Atendente só estorna baixa do mesmo dia;
// administrador estorna qualquer uma.

router.post('/:id/estornar', async (req, res, next) => {
  try {
    const baixaId = parseInt(req.params.id, 10);
    if (!Number.isInteger(baixaId)) return res.status(404).json({ erro: 'Baixa não encontrada.' });

    const resultado = await comTransacao(async (query) => {
      const rb = await query(
        `SELECT b.id, b.pacote_id, b.estornada, b.registrado_em,
                p.saldo, p.qtd_banhos, p.status, p.validade_ate
           FROM baixas b
           JOIN pacotes p ON p.id = b.pacote_id
          WHERE b.id = $1 AND b.empresa_id = $2
          FOR UPDATE OF b, p`,
        [baixaId, req.usuario.empresa_id]
      );
      const baixa = rb.recordset[0];
      if (!baixa) throw erroNegocio('Baixa não encontrada.', 404);
      if (baixa.estornada) throw erroNegocio('Esta baixa já foi estornada.', 409);

      if (req.usuario.permissoes !== 'ADMINISTRADOR') {
        const dataBaixa = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Sao_Paulo' })
          .format(new Date(baixa.registrado_em));
        if (dataBaixa !== hojeSaoPaulo()) {
          throw erroNegocio('Atendente só estorna baixa do mesmo dia. Peça a um administrador.', 403);
        }
      }
      if (baixa.saldo >= baixa.qtd_banhos) {
        throw erroNegocio('O saldo deste pacote já está cheio — nada a estornar.', 409);
      }

      await query(
        `UPDATE baixas SET estornada = TRUE, estornada_por = $1, estornada_em = NOW()
          WHERE id = $2 AND empresa_id = $3`,
        [req.usuario.id, baixaId, req.usuario.empresa_id]
      );

      const novoSaldo = baixa.saldo + 1;
      const novoStatus = baixa.status === 'ESGOTADO' ? 'ATIVO' : baixa.status;
      await query(
        'UPDATE pacotes SET saldo = $1, status = $2 WHERE id = $3 AND empresa_id = $4',
        [novoSaldo, novoStatus, baixa.pacote_id, req.usuario.empresa_id]
      );

      return { saldo: novoSaldo, status: novoStatus };
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
