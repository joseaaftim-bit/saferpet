'use strict';

const express = require('express');
const { executeQuery, comTransacao } = require('../database');
const { somenteAdmin } = require('../middlewares/autenticacao');
const { hojeSaoPaulo, somarMeses, dataISO } = require('../util/datas');

const router = express.Router();

function erroNegocio(mensagem, statusHttp) {
  return Object.assign(new Error(mensagem), { statusHttp });
}

// Valida a lista de itens { servico_id, quantidade } contra o catálogo da
// empresa. Retorna [{ servico_id, servico_nome, quantidade }] ou lança 400.
async function validarItens(q, empresaId, itens) {
  if (!Array.isArray(itens) || !itens.length || itens.length > 10) {
    throw erroNegocio('O pacote precisa de 1 a 10 itens de serviço.', 400);
  }
  const validados = [];
  const vistos = new Set();
  for (const item of itens) {
    const servicoId = parseInt(item && item.servico_id, 10);
    const quantidade = parseInt(item && item.quantidade, 10);
    if (!Number.isInteger(servicoId) || !Number.isInteger(quantidade) ||
        quantidade <= 0 || quantidade > 500) {
      throw erroNegocio('Item de pacote inválido.', 400);
    }
    if (vistos.has(servicoId)) throw erroNegocio('Serviço repetido no pacote.', 400);
    vistos.add(servicoId);

    const rs = await q(
      'SELECT nome FROM servicos WHERE id = $1 AND empresa_id = $2 AND ativo',
      [servicoId, empresaId]
    );
    if (!rs.recordset.length) throw erroNegocio('Serviço do pacote não encontrado.', 400);
    validados.push({ servico_id: servicoId, servico_nome: rs.recordset[0].nome, quantidade });
  }
  return validados;
}

async function anexarItensDeModelos(modelos, empresaId) {
  if (!modelos.length) return modelos;
  const r = await executeQuery(
    `SELECT i.modelo_id, i.servico_id, i.quantidade, s.nome AS servico_nome
       FROM pacotes_modelo_itens i
       JOIN servicos s ON s.id = i.servico_id
      WHERE i.empresa_id = $1
      ORDER BY i.id`,
    [empresaId]
  );
  const porModelo = new Map();
  for (const item of r.recordset) {
    if (!porModelo.has(item.modelo_id)) porModelo.set(item.modelo_id, []);
    porModelo.get(item.modelo_id).push(item);
  }
  return modelos.map(m => ({ ...m, itens: porModelo.get(m.id) || [] }));
}

// ─── Catálogo (pacotes_modelo + itens) ─────────────────────────────

router.get('/modelos', async (req, res, next) => {
  try {
    const r = await executeQuery(
      `SELECT id, nome, valor_centavos, validade_meses, ativo
         FROM pacotes_modelo WHERE empresa_id = $1 ORDER BY nome`,
      [req.usuario.empresa_id]
    );
    res.json(await anexarItensDeModelos(r.recordset, req.usuario.empresa_id));
  } catch (err) {
    next(err);
  }
});

router.post('/modelos', somenteAdmin, async (req, res, next) => {
  try {
    const { nome, valor_centavos, validade_meses, itens } = req.body || {};
    const valor = parseInt(valor_centavos, 10);
    const meses = validade_meses === null || validade_meses === undefined || validade_meses === ''
      ? null : parseInt(validade_meses, 10);
    if (!nome || !String(nome).trim() || !Number.isInteger(valor) || valor < 0 ||
        (meses !== null && (!Number.isInteger(meses) || meses <= 0))) {
      return res.status(400).json({ erro: 'Dados do pacote inválidos.' });
    }
    const empresaId = req.usuario.empresa_id;

    const modelo = await comTransacao(async (query) => {
      const validados = await validarItens(query, empresaId, itens);
      const total = validados.reduce((soma, i) => soma + i.quantidade, 0);
      const rm = await query(
        `INSERT INTO pacotes_modelo (empresa_id, nome, qtd_banhos, valor_centavos, validade_meses)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, nome, valor_centavos, validade_meses, ativo`,
        [empresaId, String(nome).trim(), total, valor, meses]
      );
      const novo = rm.recordset[0];
      for (const item of validados) {
        await query(
          `INSERT INTO pacotes_modelo_itens (empresa_id, modelo_id, servico_id, quantidade)
           VALUES ($1, $2, $3, $4)`,
          [empresaId, novo.id, item.servico_id, item.quantidade]
        );
      }
      return { ...novo, itens: validados };
    });
    res.status(201).json(modelo);
  } catch (err) {
    if (err.statusHttp) return res.status(err.statusHttp).json({ erro: err.message });
    next(err);
  }
});

router.put('/modelos/:id', somenteAdmin, async (req, res, next) => {
  try {
    const modeloId = parseInt(req.params.id, 10);
    const { nome, valor_centavos, validade_meses, itens, ativo } = req.body || {};
    const valor = parseInt(valor_centavos, 10);
    const meses = validade_meses === null || validade_meses === undefined || validade_meses === ''
      ? null : parseInt(validade_meses, 10);
    if (!Number.isInteger(modeloId) || !nome || !String(nome).trim() ||
        !Number.isInteger(valor) || valor < 0) {
      return res.status(400).json({ erro: 'Dados do pacote inválidos.' });
    }
    const empresaId = req.usuario.empresa_id;

    const atualizado = await comTransacao(async (query) => {
      const existe = await query(
        'SELECT id FROM pacotes_modelo WHERE id = $1 AND empresa_id = $2',
        [modeloId, empresaId]
      );
      if (!existe.recordset.length) return null;

      const validados = await validarItens(query, empresaId, itens);
      const total = validados.reduce((soma, i) => soma + i.quantidade, 0);
      await query('DELETE FROM pacotes_modelo_itens WHERE modelo_id = $1 AND empresa_id = $2',
        [modeloId, empresaId]);
      for (const item of validados) {
        await query(
          `INSERT INTO pacotes_modelo_itens (empresa_id, modelo_id, servico_id, quantidade)
           VALUES ($1, $2, $3, $4)`,
          [empresaId, modeloId, item.servico_id, item.quantidade]
        );
      }
      const rm = await query(
        `UPDATE pacotes_modelo SET nome = $1, qtd_banhos = $2, valor_centavos = $3,
                validade_meses = $4, ativo = COALESCE($5, ativo)
          WHERE id = $6 AND empresa_id = $7
          RETURNING id, nome, valor_centavos, validade_meses, ativo`,
        [String(nome).trim(), total, valor, meses,
         typeof ativo === 'boolean' ? ativo : null, modeloId, empresaId]
      );
      return { ...rm.recordset[0], itens: validados };
    });

    if (!atualizado) return res.status(404).json({ erro: 'Modelo não encontrado.' });
    res.json(atualizado);
  } catch (err) {
    if (err.statusHttp) return res.status(err.statusHttp).json({ erro: err.message });
    next(err);
  }
});

// ─── Venda de pacote ───────────────────────────────────────────────
// Com modelo_id, TUDO (itens, valor, validade) sai do catálogo do servidor.
// Venda avulsa exige itens explícitos.

router.post('/', async (req, res, next) => {
  try {
    const { cliente_id, modelo_id, nome, valor_centavos, validade_meses, itens } = req.body || {};
    const clienteId = parseInt(cliente_id, 10);
    if (!Number.isInteger(clienteId)) {
      return res.status(400).json({ erro: 'Informe o cliente.' });
    }
    const empresaId = req.usuario.empresa_id;

    const pacote = await comTransacao(async (query) => {
      const dono = await query(
        'SELECT id FROM clientes WHERE id = $1 AND empresa_id = $2 AND ativo',
        [clienteId, empresaId]
      );
      if (!dono.recordset.length) throw erroNegocio('Cliente não encontrado.', 404);

      let dados;
      if (modelo_id) {
        const modeloId = parseInt(modelo_id, 10);
        const rm = await query(
          `SELECT id, nome, valor_centavos, validade_meses
             FROM pacotes_modelo WHERE id = $1 AND empresa_id = $2 AND ativo`,
          [modeloId, empresaId]
        );
        if (!rm.recordset.length) throw erroNegocio('Modelo de pacote não encontrado.', 404);
        const ri = await query(
          `SELECT i.servico_id, i.quantidade, s.nome AS servico_nome
             FROM pacotes_modelo_itens i JOIN servicos s ON s.id = i.servico_id
            WHERE i.modelo_id = $1 AND i.empresa_id = $2 AND s.ativo ORDER BY i.id`,
          [modeloId, empresaId]
        );
        const totalItens = await query(
          'SELECT COUNT(*)::int AS total FROM pacotes_modelo_itens WHERE modelo_id = $1 AND empresa_id = $2',
          [modeloId, empresaId]
        );
        if (!ri.recordset.length) throw erroNegocio('Modelo sem itens — edite o catálogo.', 409);
        if (ri.recordset.length < totalItens.recordset[0].total) {
          throw erroNegocio('O modelo inclui um serviço desativado — edite o catálogo antes de vender.', 409);
        }
        dados = { ...rm.recordset[0], itens: ri.recordset };
      } else {
        const valor = parseInt(valor_centavos, 10);
        const meses = validade_meses === null || validade_meses === undefined || validade_meses === ''
          ? null : parseInt(validade_meses, 10);
        if (!nome || !String(nome).trim() || !Number.isInteger(valor) || valor < 0 ||
            (meses !== null && (!Number.isInteger(meses) || meses <= 0))) {
          throw erroNegocio('Dados do pacote inválidos.', 400);
        }
        const validados = await validarItens(query, empresaId, itens);
        dados = {
          nome: String(nome).trim(), valor_centavos: valor,
          validade_meses: meses, itens: validados,
        };
      }

      const total = dados.itens.reduce((soma, i) => soma + i.quantidade, 0);
      const compradoEm = hojeSaoPaulo();
      const validadeAte = dados.validade_meses ? somarMeses(compradoEm, dados.validade_meses) : null;

      const rp = await query(
        `INSERT INTO pacotes (empresa_id, cliente_id, nome, qtd_banhos, valor_centavos,
                              saldo, status, comprado_em, validade_ate, criado_por)
         VALUES ($1, $2, $3, $4, $5, $4, 'ATIVO', $6, $7, $8)
         RETURNING id, nome, qtd_banhos, valor_centavos, saldo, status, comprado_em, validade_ate`,
        [empresaId, clienteId, dados.nome, total, dados.valor_centavos,
         compradoEm, validadeAte, req.usuario.id]
      );
      const novo = rp.recordset[0];
      const itensCriados = [];
      for (const item of dados.itens) {
        const ri = await query(
          `INSERT INTO pacotes_itens (empresa_id, pacote_id, servico_id, servico_nome, quantidade, saldo)
           VALUES ($1, $2, $3, $4, $5, $5)
           RETURNING id, servico_id, servico_nome, quantidade, saldo`,
          [empresaId, novo.id, item.servico_id, item.servico_nome, item.quantidade]
        );
        itensCriados.push(ri.recordset[0]);
      }
      return { ...novo, itens: itensCriados };
    });

    res.status(201).json(pacote);
  } catch (err) {
    if (err.statusHttp) return res.status(err.statusHttp).json({ erro: err.message });
    next(err);
  }
});

// ─── Ajustes administrativos: validade, cancelar, reativar ─────────

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

      let novoStatus = pacote.status;
      if (status !== undefined) {
        if (status === 'ATIVO' && pacote.saldo <= 0) {
          throw erroNegocio('Pacote sem saldo não pode voltar a ATIVO.', 409);
        }
        if (status === 'ATIVO') {
          const validadeEfetiva = validade_ate !== undefined ? validade_ate : dataISO(pacote.validade_ate);
          if (validadeEfetiva && validadeEfetiva < hojeSaoPaulo()) {
            throw erroNegocio('Defina uma validade futura para reativar este pacote.', 409);
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
