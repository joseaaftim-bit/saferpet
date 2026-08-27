'use strict';

const express = require('express');
const { executeQuery, comTransacao } = require('../database');
const { somenteAdmin } = require('../middlewares/autenticacao');
const { hojeSaoPaulo, somarMeses, dataISO } = require('../util/datas');

const router = express.Router();

// ─── Catálogo (pacotes_modelo) ─────────────────────────────────────

router.get('/modelos', async (req, res, next) => {
  try {
    const r = await executeQuery(
      `SELECT id, nome, qtd_banhos, valor_centavos, validade_meses, ativo
         FROM pacotes_modelo WHERE empresa_id = $1 ORDER BY qtd_banhos`,
      [req.usuario.empresa_id]
    );
    res.json(r.recordset);
  } catch (err) {
    next(err);
  }
});

router.post('/modelos', somenteAdmin, async (req, res, next) => {
  try {
    const { nome, qtd_banhos, valor_centavos, validade_meses } = req.body || {};
    const qtd = parseInt(qtd_banhos, 10);
    const valor = parseInt(valor_centavos, 10);
    const meses = validade_meses === null || validade_meses === undefined || validade_meses === ''
      ? null : parseInt(validade_meses, 10);

    if (!nome || !String(nome).trim() || !Number.isInteger(qtd) || qtd <= 0 ||
        !Number.isInteger(valor) || valor < 0 || (meses !== null && (!Number.isInteger(meses) || meses <= 0))) {
      return res.status(400).json({ erro: 'Dados do pacote inválidos.' });
    }

    const r = await executeQuery(
      `INSERT INTO pacotes_modelo (empresa_id, nome, qtd_banhos, valor_centavos, validade_meses)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, nome, qtd_banhos, valor_centavos, validade_meses, ativo`,
      [req.usuario.empresa_id, String(nome).trim(), qtd, valor, meses]
    );
    res.status(201).json(r.recordset[0]);
  } catch (err) {
    next(err);
  }
});

router.put('/modelos/:id', somenteAdmin, async (req, res, next) => {
  try {
    const modeloId = parseInt(req.params.id, 10);
    const { nome, qtd_banhos, valor_centavos, validade_meses, ativo } = req.body || {};
    const qtd = parseInt(qtd_banhos, 10);
    const valor = parseInt(valor_centavos, 10);
    const meses = validade_meses === null || validade_meses === undefined || validade_meses === ''
      ? null : parseInt(validade_meses, 10);

    if (!Number.isInteger(modeloId) || !nome || !String(nome).trim() ||
        !Number.isInteger(qtd) || qtd <= 0 || !Number.isInteger(valor) || valor < 0) {
      return res.status(400).json({ erro: 'Dados do pacote inválidos.' });
    }

    const r = await executeQuery(
      `UPDATE pacotes_modelo
          SET nome = $1, qtd_banhos = $2, valor_centavos = $3, validade_meses = $4,
              ativo = COALESCE($5, ativo)
        WHERE id = $6 AND empresa_id = $7 RETURNING id`,
      [String(nome).trim(), qtd, valor, meses,
       typeof ativo === 'boolean' ? ativo : null, modeloId, req.usuario.empresa_id]
    );
    if (!r.recordset.length) return res.status(404).json({ erro: 'Modelo não encontrado.' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ─── Venda de pacote a um cliente ──────────────────────────────────
// Com modelo_id, quantidade, valor e validade saem do CATÁLOGO do servidor
// (nunca do corpo da requisição). Venda avulsa exige os campos explícitos.

router.post('/', async (req, res, next) => {
  try {
    const { cliente_id, modelo_id, nome, qtd_banhos, valor_centavos, validade_meses } = req.body || {};
    const clienteId = parseInt(cliente_id, 10);
    if (!Number.isInteger(clienteId)) {
      return res.status(400).json({ erro: 'Informe o cliente.' });
    }

    const dono = await executeQuery(
      'SELECT id FROM clientes WHERE id = $1 AND empresa_id = $2 AND ativo',
      [clienteId, req.usuario.empresa_id]
    );
    if (!dono.recordset.length) return res.status(404).json({ erro: 'Cliente não encontrado.' });

    let dados;
    if (modelo_id) {
      const modeloId = parseInt(modelo_id, 10);
      const m = await executeQuery(
        `SELECT nome, qtd_banhos, valor_centavos, validade_meses
           FROM pacotes_modelo WHERE id = $1 AND empresa_id = $2 AND ativo`,
        [modeloId, req.usuario.empresa_id]
      );
      if (!m.recordset.length) return res.status(404).json({ erro: 'Modelo de pacote não encontrado.' });
      dados = m.recordset[0];
    } else {
      const qtd = parseInt(qtd_banhos, 10);
      const valor = parseInt(valor_centavos, 10);
      const meses = validade_meses === null || validade_meses === undefined || validade_meses === ''
        ? null : parseInt(validade_meses, 10);
      if (!nome || !String(nome).trim() || !Number.isInteger(qtd) || qtd <= 0 ||
          !Number.isInteger(valor) || valor < 0 || (meses !== null && (!Number.isInteger(meses) || meses <= 0))) {
        return res.status(400).json({ erro: 'Dados do pacote inválidos.' });
      }
      dados = { nome: String(nome).trim(), qtd_banhos: qtd, valor_centavos: valor, validade_meses: meses };
    }

    // Data no fuso do petshop, soma de meses com o dia travado no fim do
    // mês (31/01 + 1 mês = 28/02) — nada de Date/UTC aqui.
    const compradoEm = hojeSaoPaulo();
    const validadeAte = dados.validade_meses
      ? somarMeses(compradoEm, dados.validade_meses) : null;

    const r = await executeQuery(
      `INSERT INTO pacotes (empresa_id, cliente_id, nome, qtd_banhos, valor_centavos,
                            saldo, status, comprado_em, validade_ate, criado_por)
       VALUES ($1, $2, $3, $4, $5, $4, 'ATIVO', $6, $7, $8)
       RETURNING id, nome, qtd_banhos, valor_centavos, saldo, status, comprado_em, validade_ate`,
      [req.usuario.empresa_id, clienteId, dados.nome, dados.qtd_banhos,
       dados.valor_centavos, compradoEm, validadeAte, req.usuario.id]
    );
    res.status(201).json(r.recordset[0]);
  } catch (err) {
    next(err);
  }
});

// Ajustes administrativos: prorrogar validade ou cancelar.
router.put('/:id', somenteAdmin, async (req, res, next) => {
  try {
    const pacoteId = parseInt(req.params.id, 10);
    const { validade_ate, status } = req.body || {};
    if (!Number.isInteger(pacoteId)) return res.status(404).json({ erro: 'Pacote não encontrado.' });

    const STATUS_PERMITIDOS = ['ATIVO', 'CANCELADO'];
    if (status !== undefined && !STATUS_PERMITIDOS.includes(status)) {
      return res.status(400).json({ erro: 'Status inválido.' });
    }
    if (validade_ate !== undefined && validade_ate !== null &&
        !/^\d{4}-\d{2}-\d{2}$/.test(String(validade_ate))) {
      return res.status(400).json({ erro: 'Validade inválida (use AAAA-MM-DD).' });
    }

    const atualizado = await comTransacao(async (query) => {
      const atual = await query(
        'SELECT id, saldo, status, validade_ate FROM pacotes WHERE id = $1 AND empresa_id = $2 FOR UPDATE',
        [pacoteId, req.usuario.empresa_id]
      );
      const pacote = atual.recordset[0];
      if (!pacote) return null;

      // Reativar um pacote esgotado não faz sentido; cancelado/vencido só
      // volta a ATIVO se ainda tiver saldo E validade que não esteja no
      // passado — senão o cron remarca VENCIDO na madrugada seguinte.
      let novoStatus = pacote.status;
      if (status !== undefined) {
        if (status === 'ATIVO' && pacote.saldo <= 0) {
          throw Object.assign(new Error('Pacote sem saldo não pode voltar a ATIVO.'), { statusHttp: 409 });
        }
        if (status === 'ATIVO') {
          const validadeEfetiva = validade_ate !== undefined ? validade_ate : dataISO(pacote.validade_ate);
          if (validadeEfetiva && validadeEfetiva < hojeSaoPaulo()) {
            throw Object.assign(
              new Error('Defina uma validade futura para reativar este pacote.'),
              { statusHttp: 409 }
            );
          }
        }
        novoStatus = status;
      }

      const r = await query(
        `UPDATE pacotes SET
            validade_ate = CASE WHEN $1::boolean THEN $2::date ELSE validade_ate END,
            status = $3
          WHERE id = $4 AND empresa_id = $5
          RETURNING id, nome, saldo, status, validade_ate`,
        [validade_ate !== undefined, validade_ate || null, novoStatus, pacoteId, req.usuario.empresa_id]
      );
      return r.recordset[0];
    });

    if (!atualizado) return res.status(404).json({ erro: 'Pacote não encontrado.' });
    res.json(atualizado);
  } catch (err) {
    if (err.statusHttp) return res.status(err.statusHttp).json({ erro: err.message });
    next(err);
  }
});

module.exports = router;
