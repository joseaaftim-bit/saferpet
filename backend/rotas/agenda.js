'use strict';

const express = require('express');
const { executeQuery, comTransacao } = require('../database');
const { somenteAdmin } = require('../middlewares/autenticacao');
const { hojeSaoPaulo } = require('../util/datas');
const { consumirUmCredito } = require('../util/creditos');
const { paraMinutos } = require('../util/agenda');
const {
  contextoDoDia, calcularHorariosLivres, criarAgendamento,
  erroNegocio, HHMM_RE, DATA_RE,
} = require('../util/agendamentos');

const router = express.Router();

// ─── Configuração ──────────────────────────────────────────────────

router.get('/config', async (req, res, next) => {
  try {
    const empresaId = req.usuario.empresa_id;
    const [horarios, recursos, excecoes, empresa] = await Promise.all([
      executeQuery(
        'SELECT id, dia_semana, inicio, fim FROM agenda_horarios WHERE empresa_id = $1 ORDER BY dia_semana, inicio',
        [empresaId]),
      executeQuery(
        'SELECT id, nome, tipo, ativo FROM recursos WHERE empresa_id = $1 ORDER BY tipo, id',
        [empresaId]),
      executeQuery(
        'SELECT id, data, motivo FROM agenda_excecoes WHERE empresa_id = $1 AND data >= $2 ORDER BY data',
        [empresaId, hojeSaoPaulo()]),
      executeQuery(
        'SELECT tempo_deslocamento_minutos, intervalo_grade_minutos FROM empresas WHERE id = $1',
        [empresaId]),
    ]);
    res.json({
      horarios: horarios.recordset,
      recursos: recursos.recordset,
      excecoes: excecoes.recordset,
      tempo_deslocamento_minutos: empresa.recordset[0].tempo_deslocamento_minutos,
      intervalo_grade_minutos: empresa.recordset[0].intervalo_grade_minutos,
    });
  } catch (err) {
    next(err);
  }
});

router.put('/config', somenteAdmin, async (req, res, next) => {
  try {
    const { horarios, tempo_deslocamento_minutos, intervalo_grade_minutos } = req.body || {};
    const empresaId = req.usuario.empresa_id;

    if (!Array.isArray(horarios) || horarios.length > 30) {
      return res.status(400).json({ erro: 'Informe os horários de funcionamento.' });
    }
    for (const h of horarios) {
      const dia = parseInt(h && h.dia_semana, 10);
      if (!Number.isInteger(dia) || dia < 0 || dia > 6 ||
          !HHMM_RE.test(String(h.inicio)) || !HHMM_RE.test(String(h.fim)) ||
          paraMinutos(h.inicio) >= paraMinutos(h.fim)) {
        return res.status(400).json({ erro: 'Período inválido (use HH:MM, com início antes do fim).' });
      }
    }
    const desloc = parseInt(tempo_deslocamento_minutos, 10);
    const passo = parseInt(intervalo_grade_minutos, 10);
    if (!Number.isInteger(desloc) || desloc < 5 || desloc > 180 ||
        !Number.isInteger(passo) || ![5, 10, 15, 20, 30, 60].includes(passo)) {
      return res.status(400).json({ erro: 'Deslocamento (5–180 min) ou grade inválidos.' });
    }

    await comTransacao(async (query) => {
      await query('DELETE FROM agenda_horarios WHERE empresa_id = $1', [empresaId]);
      for (const h of horarios) {
        await query(
          'INSERT INTO agenda_horarios (empresa_id, dia_semana, inicio, fim) VALUES ($1, $2, $3, $4)',
          [empresaId, parseInt(h.dia_semana, 10), h.inicio, h.fim]
        );
      }
      await query(
        'UPDATE empresas SET tempo_deslocamento_minutos = $1, intervalo_grade_minutos = $2 WHERE id = $3',
        [desloc, passo, empresaId]
      );
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post('/recursos', somenteAdmin, async (req, res, next) => {
  try {
    const nome = String((req.body || {}).nome || '').trim();
    const tipo = (req.body || {}).tipo === 'VEICULO' ? 'VEICULO' : 'ATENDIMENTO';
    if (!nome) return res.status(400).json({ erro: 'Informe o nome.' });
    const r = await executeQuery(
      `INSERT INTO recursos (empresa_id, nome, tipo) VALUES ($1, $2, $3)
       RETURNING id, nome, tipo, ativo`,
      [req.usuario.empresa_id, nome, tipo]
    );
    res.status(201).json(r.recordset[0]);
  } catch (err) {
    next(err);
  }
});

router.put('/recursos/:id', somenteAdmin, async (req, res, next) => {
  try {
    const recursoId = parseInt(req.params.id, 10);
    const nome = String((req.body || {}).nome || '').trim();
    const ativo = typeof (req.body || {}).ativo === 'boolean' ? req.body.ativo : null;
    if (!Number.isInteger(recursoId) || !nome) return res.status(400).json({ erro: 'Dados inválidos.' });

    // Desativar um recurso com agendamentos futuros esconderia horários já
    // vendidos e reofertaria os mesmos slots — fecha por padrão.
    if (ativo === false) {
      const futuros = await executeQuery(
        `SELECT COUNT(*)::int AS total FROM agendamentos
          WHERE recurso_id = $1 AND empresa_id = $2 AND status = 'AGENDADO' AND data >= $3`,
        [recursoId, req.usuario.empresa_id, hojeSaoPaulo()]
      );
      const total = futuros.recordset[0].total;
      if (total > 0) {
        return res.status(409).json({
          erro: `Este recurso tem ${total} agendamento(s) futuro(s). Cancele ou conclua antes de desativar.`,
        });
      }
    }

    const r = await executeQuery(
      `UPDATE recursos SET nome = $1, ativo = COALESCE($2, ativo)
        WHERE id = $3 AND empresa_id = $4 RETURNING id, nome, tipo, ativo`,
      [nome, ativo, recursoId, req.usuario.empresa_id]
    );
    if (!r.recordset.length) return res.status(404).json({ erro: 'Recurso não encontrado.' });
    res.json(r.recordset[0]);
  } catch (err) {
    next(err);
  }
});

router.post('/excecoes', somenteAdmin, async (req, res, next) => {
  try {
    const { data, motivo } = req.body || {};
    if (!DATA_RE.test(String(data))) return res.status(400).json({ erro: 'Data inválida (AAAA-MM-DD).' });
    const afetados = await executeQuery(
      `SELECT COUNT(*)::int AS total FROM agendamentos
        WHERE empresa_id = $1 AND data = $2 AND status = 'AGENDADO'`,
      [req.usuario.empresa_id, data]
    );
    const r = await executeQuery(
      `INSERT INTO agenda_excecoes (empresa_id, data, motivo) VALUES ($1, $2, $3)
       RETURNING id, data, motivo`,
      [req.usuario.empresa_id, data, String(motivo || '').trim() || null]
    );
    res.status(201).json({ ...r.recordset[0], agendamentos_afetados: afetados.recordset[0].total });
  } catch (err) {
    next(err);
  }
});

router.delete('/excecoes/:id', somenteAdmin, async (req, res, next) => {
  try {
    const excecaoId = parseInt(req.params.id, 10);
    if (!Number.isInteger(excecaoId)) return res.status(404).json({ erro: 'Não encontrada.' });
    const r = await executeQuery(
      'DELETE FROM agenda_excecoes WHERE id = $1 AND empresa_id = $2 RETURNING id',
      [excecaoId, req.usuario.empresa_id]
    );
    if (!r.recordset.length) return res.status(404).json({ erro: 'Não encontrada.' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ─── Consulta do dia e horários livres ─────────────────────────────

router.get('/dia', async (req, res, next) => {
  try {
    const data = String(req.query.data || hojeSaoPaulo());
    if (!DATA_RE.test(data)) return res.status(400).json({ erro: 'Data inválida.' });
    const empresaId = req.usuario.empresa_id;

    const [ctx, ags, todosRecursos] = await Promise.all([
      contextoDoDia(executeQuery, empresaId, data),
      executeQuery(
        `SELECT a.id, a.tipo, a.data, a.inicio, a.fim, a.status, a.observacao, a.origem,
                a.recurso_id, a.agendamento_pai_id, a.cliente_id, a.pet_id, a.servico_id,
                c.nome AS cliente_nome, p.nome AS pet_nome, s.nome AS servico_nome
           FROM agendamentos a
           JOIN clientes c ON c.id = a.cliente_id
           LEFT JOIN pets p ON p.id = a.pet_id
           LEFT JOIN servicos s ON s.id = a.servico_id
          WHERE a.empresa_id = $1 AND a.data = $2
          ORDER BY a.inicio`,
        [empresaId, data]),
      executeQuery(
        'SELECT id, nome, tipo, ativo FROM recursos WHERE empresa_id = $1 ORDER BY tipo, id',
        [empresaId]),
    ]);

    // Recursos inativos que ainda têm agendamento no dia continuam na
    // grade (marcados), para os horários já vendidos não sumirem.
    const idsAtivos = new Set(ctx.recursos.map(r => r.id));
    const referenciados = new Set(ags.recordset.map(a => a.recurso_id));
    const recursos = ctx.recursos.map(r => ({ ...r, ativo: true })).concat(
      todosRecursos.recordset.filter(r => !idsAtivos.has(r.id) && referenciados.has(r.id))
    );

    res.json({
      data,
      fechado: ctx.fechado,
      periodos: ctx.periodos,
      recursos,
      agendamentos: ags.recordset,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/horarios-livres', async (req, res, next) => {
  try {
    const data = String(req.query.data || '');
    const servicoId = parseInt(req.query.servico_id, 10);
    if (!DATA_RE.test(data) || !Number.isInteger(servicoId)) {
      return res.status(400).json({ erro: 'Informe data e serviço.' });
    }
    const resultado = await calcularHorariosLivres(executeQuery, {
      empresaId: req.usuario.empresa_id,
      data, servicoId,
      levaTraz: String(req.query.leva_traz) === 'true',
    });
    res.json(resultado);
  } catch (err) {
    if (err.statusHttp) return res.status(err.statusHttp).json({ erro: err.message });
    next(err);
  }
});

// ─── Criar agendamento ─────────────────────────────────────────────

router.post('/agendamentos', async (req, res, next) => {
  try {
    const { cliente_id, pet_id, servico_id, data, inicio, leva_traz, observacao } = req.body || {};
    const empresaId = req.usuario.empresa_id;

    const resultado = await comTransacao(async (query) => {
      // Trava por empresa: serializa criações e impede agendamento duplo
      // no mesmo horário por duas atendentes ao mesmo tempo.
      await query('SELECT id FROM empresas WHERE id = $1 FOR UPDATE', [empresaId]);
      return criarAgendamento(query, {
        empresaId,
        clienteId: parseInt(cliente_id, 10),
        petId: pet_id === null || pet_id === undefined || pet_id === '' ? null : parseInt(pet_id, 10),
        servicoId: parseInt(servico_id, 10),
        data: String(data),
        inicio: String(inicio),
        levaTraz: leva_traz === true,
        observacao,
        usuarioId: req.usuario.id,
        origem: 'PETSHOP',
      });
    });

    res.status(201).json(resultado);
  } catch (err) {
    if (err.statusHttp) return res.status(err.statusHttp).json({ erro: err.message });
    next(err);
  }
});

// ─── Concluir / cancelar / faltou ──────────────────────────────────

router.put('/agendamentos/:id', async (req, res, next) => {
  try {
    const agendamentoId = parseInt(req.params.id, 10);
    const { acao, consumir_credito } = req.body || {};
    if (!Number.isInteger(agendamentoId) || !['CONCLUIR', 'CANCELAR', 'FALTOU'].includes(acao)) {
      return res.status(400).json({ erro: 'Ação inválida.' });
    }
    const empresaId = req.usuario.empresa_id;

    const resultado = await comTransacao(async (query) => {
      const ra = await query(
        `SELECT a.id, a.tipo, a.status, a.cliente_id, a.pet_id, a.servico_id,
                s.nome AS servico_nome
           FROM agendamentos a
           LEFT JOIN servicos s ON s.id = a.servico_id
          WHERE a.id = $1 AND a.empresa_id = $2
          FOR UPDATE OF a`,
        [agendamentoId, empresaId]
      );
      const ag = ra.recordset[0];
      if (!ag) throw erroNegocio('Agendamento não encontrado.', 404);
      if (ag.status !== 'AGENDADO') {
        throw erroNegocio(`Este agendamento já está ${String(ag.status).toLowerCase()}.`, 409);
      }

      const novoStatus = acao === 'CONCLUIR' ? 'CONCLUIDO' : (acao === 'CANCELAR' ? 'CANCELADO' : 'FALTOU');
      await query(
        'UPDATE agendamentos SET status = $1 WHERE id = $2 AND empresa_id = $3',
        [novoStatus, agendamentoId, empresaId]
      );

      // Cancelamento/falta do serviço derruba a busca e a entrega ligadas.
      if (novoStatus !== 'CONCLUIDO' && ag.tipo === 'SERVICO') {
        await query(
          `UPDATE agendamentos SET status = 'CANCELADO'
            WHERE agendamento_pai_id = $1 AND empresa_id = $2 AND status = 'AGENDADO'`,
          [agendamentoId, empresaId]
        );
      }

      // Conclusão de serviço pode consumir 1 crédito do pacote.
      let baixa = null;
      let semCredito = false;
      if (novoStatus === 'CONCLUIDO' && ag.tipo === 'SERVICO' && consumir_credito !== false) {
        baixa = await consumirUmCredito(query, {
          empresaId, clienteId: ag.cliente_id, servicoId: ag.servico_id,
          servicoNome: ag.servico_nome, petId: ag.pet_id,
          usuarioId: req.usuario.id, agendamentoId,
        });
        semCredito = !baixa;
      }

      return { status: novoStatus, baixa, sem_credito: semCredito };
    });

    res.json(resultado);
  } catch (err) {
    if (err.statusHttp) return res.status(err.statusHttp).json({ erro: err.message });
    next(err);
  }
});

module.exports = router;
