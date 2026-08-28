'use strict';

// Fase 4 — o que faz o cliente falar do petshop:
// foto do pet pronto, carteirinha de vacinação, fila de encaixe e
// relatórios do dono.

const express = require('express');
const { executeQuery, comTransacao } = require('../database');
const { somenteAdmin } = require('../middlewares/autenticacao');
const { hojeSaoPaulo, somarMeses } = require('../util/datas');

const router = express.Router();

const DATA_RE = /^\d{4}-\d{2}-\d{2}$/;
// ~700 KB de base64 (a imagem é reduzida no navegador antes de subir).
const LIMITE_FOTO = 700 * 1024;

function erroNegocio(mensagem, statusHttp) {
  return Object.assign(new Error(mensagem), { statusHttp });
}

// ─── Foto do pet pronto ────────────────────────────────────────────

router.post('/fotos', async (req, res, next) => {
  try {
    const { cliente_id, pet_id, agendamento_id, conteudo, legenda } = req.body || {};
    const clienteId = parseInt(cliente_id, 10);
    const empresaId = req.usuario.empresa_id;

    if (!Number.isInteger(clienteId)) return res.status(400).json({ erro: 'Informe o cliente.' });
    const imagem = String(conteudo || '');
    if (!/^data:image\/(jpeg|jpg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(imagem)) {
      return res.status(400).json({ erro: 'Imagem inválida.' });
    }
    if (imagem.length > LIMITE_FOTO) {
      return res.status(413).json({ erro: 'Foto muito grande. Tire uma foto menor.' });
    }

    const rc = await executeQuery(
      'SELECT id FROM clientes WHERE id = $1 AND empresa_id = $2 AND ativo',
      [clienteId, empresaId]
    );
    if (!rc.recordset.length) return res.status(404).json({ erro: 'Cliente não encontrado.' });

    const petId = pet_id ? parseInt(pet_id, 10) : null;
    if (petId !== null) {
      const rp = await executeQuery(
        'SELECT id FROM pets WHERE id = $1 AND empresa_id = $2 AND cliente_id = $3',
        [petId, empresaId, clienteId]
      );
      if (!rp.recordset.length) return res.status(400).json({ erro: 'Pet não pertence a este cliente.' });
    }

    const agendamentoId = agendamento_id ? parseInt(agendamento_id, 10) : null;
    if (agendamentoId !== null) {
      const ra = await executeQuery(
        'SELECT id FROM agendamentos WHERE id = $1 AND empresa_id = $2 AND cliente_id = $3',
        [agendamentoId, empresaId, clienteId]
      );
      if (!ra.recordset.length) return res.status(400).json({ erro: 'Agendamento não confere.' });
    }

    const r = await executeQuery(
      `INSERT INTO fotos (empresa_id, cliente_id, pet_id, agendamento_id, conteudo, legenda, criado_por)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, criado_em`,
      [empresaId, clienteId, petId, agendamentoId, imagem,
       String(legenda || '').trim().slice(0, 200) || null, req.usuario.id]
    );
    res.status(201).json(r.recordset[0]);
  } catch (err) {
    next(err);
  }
});

router.delete('/fotos/:id', async (req, res, next) => {
  try {
    const fotoId = parseInt(req.params.id, 10);
    if (!Number.isInteger(fotoId)) return res.status(404).json({ erro: 'Foto não encontrada.' });
    const r = await executeQuery(
      'DELETE FROM fotos WHERE id = $1 AND empresa_id = $2 RETURNING id',
      [fotoId, req.usuario.empresa_id]
    );
    if (!r.recordset.length) return res.status(404).json({ erro: 'Foto não encontrada.' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ─── Carteirinha de vacinação ──────────────────────────────────────

router.get('/vacinas', async (req, res, next) => {
  try {
    const empresaId = req.usuario.empresa_id;
    const petId = req.query.pet_id ? parseInt(req.query.pet_id, 10) : null;
    const params = [empresaId];
    let filtro = '';
    if (Number.isInteger(petId)) { params.push(petId); filtro = 'AND v.pet_id = $2'; }

    const r = await executeQuery(
      `SELECT v.id, v.pet_id, v.nome, v.aplicada_em, v.reforco_em, v.lote, v.observacao,
              p.nome AS pet_nome, c.id AS cliente_id, c.nome AS cliente_nome, c.telefone
         FROM vacinas v
         JOIN pets p ON p.id = v.pet_id
         JOIN clientes c ON c.id = p.cliente_id
        WHERE v.empresa_id = $1 ${filtro}
        ORDER BY v.reforco_em NULLS LAST, v.aplicada_em DESC
        LIMIT 200`,
      params
    );
    res.json(r.recordset);
  } catch (err) {
    next(err);
  }
});

// Reforços vencidos ou próximos — a lista de quem avisar.
router.get('/vacinas/reforcos', async (req, res, next) => {
  try {
    const dias = Math.min(parseInt(req.query.dias, 10) || 30, 180);
    const limite = new Date(`${hojeSaoPaulo()}T12:00:00Z`);
    limite.setUTCDate(limite.getUTCDate() + dias);

    const r = await executeQuery(
      `SELECT v.id, v.nome, v.reforco_em, p.nome AS pet_nome,
              c.id AS cliente_id, c.nome AS cliente_nome, c.telefone
         FROM vacinas v
         JOIN pets p ON p.id = v.pet_id
         JOIN clientes c ON c.id = p.cliente_id
        WHERE v.empresa_id = $1 AND v.reforco_em IS NOT NULL
          AND v.reforco_em <= $2::date AND p.ativo AND c.ativo
        ORDER BY v.reforco_em
        LIMIT 100`,
      [req.usuario.empresa_id, limite.toISOString().slice(0, 10)]
    );
    res.json(r.recordset);
  } catch (err) {
    next(err);
  }
});

router.post('/vacinas', async (req, res, next) => {
  try {
    const { pet_id, nome, aplicada_em, reforco_meses, reforco_em, lote, observacao } = req.body || {};
    const petId = parseInt(pet_id, 10);
    const empresaId = req.usuario.empresa_id;

    if (!Number.isInteger(petId) || !nome || !String(nome).trim()) {
      return res.status(400).json({ erro: 'Informe o pet e a vacina.' });
    }
    const aplicada = DATA_RE.test(String(aplicada_em)) ? String(aplicada_em) : hojeSaoPaulo();

    const rp = await executeQuery(
      'SELECT id FROM pets WHERE id = $1 AND empresa_id = $2 AND ativo',
      [petId, empresaId]
    );
    if (!rp.recordset.length) return res.status(404).json({ erro: 'Pet não encontrado.' });

    let reforco = null;
    if (DATA_RE.test(String(reforco_em))) {
      reforco = String(reforco_em);
    } else if (reforco_meses) {
      const meses = parseInt(reforco_meses, 10);
      if (Number.isInteger(meses) && meses > 0 && meses <= 120) {
        reforco = somarMeses(aplicada, meses);
      }
    }

    const r = await executeQuery(
      `INSERT INTO vacinas (empresa_id, pet_id, nome, aplicada_em, reforco_em, lote, observacao, registrado_por)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, pet_id, nome, aplicada_em, reforco_em, lote`,
      [empresaId, petId, String(nome).trim().slice(0, 120), aplicada, reforco,
       String(lote || '').trim().slice(0, 60) || null,
       String(observacao || '').trim() || null, req.usuario.id]
    );
    res.status(201).json(r.recordset[0]);
  } catch (err) {
    next(err);
  }
});

router.delete('/vacinas/:id', somenteAdmin, async (req, res, next) => {
  try {
    const vacinaId = parseInt(req.params.id, 10);
    if (!Number.isInteger(vacinaId)) return res.status(404).json({ erro: 'Registro não encontrado.' });
    const r = await executeQuery(
      'DELETE FROM vacinas WHERE id = $1 AND empresa_id = $2 RETURNING id',
      [vacinaId, req.usuario.empresa_id]
    );
    if (!r.recordset.length) return res.status(404).json({ erro: 'Registro não encontrado.' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ─── Fila de encaixe ───────────────────────────────────────────────

router.get('/fila', async (req, res, next) => {
  try {
    const r = await executeQuery(
      `SELECT f.id, f.data, f.periodo, f.status, f.criado_em,
              c.id AS cliente_id, c.nome AS cliente_nome, c.telefone,
              p.nome AS pet_nome, s.nome AS servico_nome, s.id AS servico_id
         FROM fila_espera f
         JOIN clientes c ON c.id = f.cliente_id
         LEFT JOIN pets p ON p.id = f.pet_id
         JOIN servicos s ON s.id = f.servico_id
        WHERE f.empresa_id = $1 AND f.status = 'ESPERANDO' AND f.data >= $2
        ORDER BY f.data, f.criado_em
        LIMIT 100`,
      [req.usuario.empresa_id, hojeSaoPaulo()]
    );
    res.json(r.recordset);
  } catch (err) {
    next(err);
  }
});

router.put('/fila/:id', async (req, res, next) => {
  try {
    const filaId = parseInt(req.params.id, 10);
    const status = String((req.body || {}).status || '');
    if (!Number.isInteger(filaId) || !['ATENDIDO', 'DESISTIU'].includes(status)) {
      return res.status(400).json({ erro: 'Situação inválida.' });
    }
    const r = await executeQuery(
      `UPDATE fila_espera SET status = $1 WHERE id = $2 AND empresa_id = $3 RETURNING id, status`,
      [status, filaId, req.usuario.empresa_id]
    );
    if (!r.recordset.length) return res.status(404).json({ erro: 'Registro não encontrado.' });
    res.json(r.recordset[0]);
  } catch (err) {
    next(err);
  }
});

// ─── Relatórios do dono ────────────────────────────────────────────

router.get('/relatorios', async (req, res, next) => {
  try {
    const empresaId = req.usuario.empresa_id;
    const dias = Math.min(parseInt(req.query.dias, 10) || 30, 365);
    const desde = new Date(Date.now() - dias * 24 * 60 * 60 * 1000).toISOString();
    const desdeData = desde.slice(0, 10);

    const [porServico, pacotesVendidos, ocupacao, aVencer, semVir, avaliacoes, produtos] =
      await Promise.all([
        executeQuery(
          `SELECT b.servico, COUNT(*)::int AS total
             FROM baixas b
            WHERE b.empresa_id = $1 AND b.estornada = FALSE AND b.registrado_em >= $2
            GROUP BY b.servico ORDER BY total DESC LIMIT 20`,
          [empresaId, desde]),
        executeQuery(
          `SELECT COUNT(*)::int AS total, COALESCE(SUM(valor_centavos), 0)::bigint AS valor
             FROM pacotes WHERE empresa_id = $1 AND criado_em >= $2`,
          [empresaId, desde]),
        executeQuery(
          `SELECT status, COUNT(*)::int AS total
             FROM agendamentos
            WHERE empresa_id = $1 AND tipo = 'SERVICO' AND data >= $2
            GROUP BY status`,
          [empresaId, desdeData]),
        executeQuery(
          `SELECT COUNT(*)::int AS total FROM pacotes
            WHERE empresa_id = $1 AND status = 'ATIVO' AND validade_ate IS NOT NULL
              AND validade_ate <= $2`,
          [empresaId, somarMeses(hojeSaoPaulo(), 1)]),
        executeQuery(
          `SELECT id, nome, telefone FROM clientes
            WHERE empresa_id = $1 AND ativo ORDER BY nome LIMIT 500`,
          [empresaId]),
        executeQuery(
          `SELECT COUNT(*)::int AS total, COALESCE(AVG(nota), 0)::numeric(3,2) AS media
             FROM avaliacoes WHERE empresa_id = $1 AND criado_em >= $2`,
          [empresaId, desde]),
        executeQuery(
          `SELECT COALESCE(SUM(p.valor_centavos), 0)::bigint AS valor, COUNT(*)::int AS total
             FROM pedidos p
            WHERE p.empresa_id = $1 AND p.status IN ('PAGO','SEPARADO','EM_ROTA','ENTREGUE')
              AND p.criado_em >= $2`,
          [empresaId, desde]),
      ]);

    // Última visita por cliente: agregação simples + junção em JS (evita
    // subquery correlacionada e mantém a query portátil).
    const visitas = await executeQuery(
      `SELECT p.cliente_id, MAX(b.registrado_em) AS ultima_visita
         FROM baixas b
         JOIN pacotes p ON p.id = b.pacote_id
        WHERE b.empresa_id = $1 AND b.estornada = FALSE
        GROUP BY p.cliente_id`,
      [empresaId]
    );
    const ultimaPorCliente = new Map(
      visitas.recordset.map(v => [v.cliente_id, v.ultima_visita])
    );
    const limiteSumido = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).getTime();
    const sumidos = semVir.recordset
      .map(c => ({ ...c, ultima_visita: ultimaPorCliente.get(c.id) || null }))
      .filter(c => !c.ultima_visita || new Date(c.ultima_visita).getTime() < limiteSumido)
      .sort((a, b) => {
        if (!a.ultima_visita) return -1;
        if (!b.ultima_visita) return 1;
        return new Date(a.ultima_visita) - new Date(b.ultima_visita);
      })
      .slice(0, 20);

    res.json({
      dias,
      servicos_realizados: porServico.recordset,
      pacotes_vendidos: {
        total: pacotesVendidos.recordset[0].total,
        valor_centavos: Number(pacotesVendidos.recordset[0].valor),
      },
      agendamentos: ocupacao.recordset,
      pacotes_a_vencer: aVencer.recordset[0].total,
      clientes_sumidos: sumidos,
      avaliacoes: {
        total: avaliacoes.recordset[0].total,
        media: Number(avaliacoes.recordset[0].media),
      },
      produtos_vendidos: {
        total: produtos.recordset[0].total,
        valor_centavos: Number(produtos.recordset[0].valor),
      },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
