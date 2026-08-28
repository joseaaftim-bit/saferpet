'use strict';

// Núcleo de agendamento compartilhado entre o painel do petshop e o app do
// cliente (portal). Toda criação passa por aqui — as duas portas de entrada
// obedecem exatamente às mesmas regras de horário, recurso e leva-e-traz.

const { hojeSaoPaulo } = require('./datas');
const {
  paraMinutos, paraHHMM, horariosLivres, escolherRecurso,
  primeiroEncaixe, diaDaSemana, agoraHHMMSaoPaulo,
} = require('./agenda');

const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATA_RE = /^\d{4}-\d{2}-\d{2}$/;

function erroNegocio(mensagem, statusHttp) {
  return Object.assign(new Error(mensagem), { statusHttp });
}

/**
 * Períodos, recursos e ocupações do dia. `q` pode ser o executeQuery global
 * (leitura) ou o query de uma transação.
 */
async function contextoDoDia(q, empresaId, data) {
  const dia = diaDaSemana(data);

  const [horarios, excecoes, recursos, ocupados, empresa] = await Promise.all([
    q('SELECT inicio, fim FROM agenda_horarios WHERE empresa_id = $1 AND dia_semana = $2 ORDER BY inicio',
      [empresaId, dia]),
    q('SELECT id FROM agenda_excecoes WHERE empresa_id = $1 AND data = $2', [empresaId, data]),
    q('SELECT id, nome, tipo FROM recursos WHERE empresa_id = $1 AND ativo ORDER BY tipo, id',
      [empresaId]),
    q(`SELECT recurso_id, inicio, fim FROM agendamentos
        WHERE empresa_id = $1 AND data = $2 AND status IN ('AGENDADO', 'CONCLUIDO')`,
      [empresaId, data]),
    q('SELECT tempo_deslocamento_minutos, intervalo_grade_minutos FROM empresas WHERE id = $1',
      [empresaId]),
  ]);

  const fechado = excecoes.recordset.length > 0;
  return {
    periodos: fechado ? [] : horarios.recordset,
    fechado,
    atendimento: recursos.recordset.filter(r => r.tipo === 'ATENDIMENTO').map(r => r.id),
    veiculos: recursos.recordset.filter(r => r.tipo === 'VEICULO').map(r => r.id),
    recursos: recursos.recordset,
    ocupacoes: ocupados.recordset,
    desloc: empresa.recordset[0].tempo_deslocamento_minutos,
    passo: empresa.recordset[0].intervalo_grade_minutos,
  };
}

/** Horários que comportam o serviço inteiro no dia. */
async function calcularHorariosLivres(q, { empresaId, data, servicoId, levaTraz }) {
  if (!DATA_RE.test(String(data))) throw erroNegocio('Data inválida.', 400);
  if (data < hojeSaoPaulo()) return { horarios: [], leva_traz_disponivel: false };

  const rs = await q(
    'SELECT duracao_minutos FROM servicos WHERE id = $1 AND empresa_id = $2 AND ativo',
    [servicoId, empresaId]
  );
  if (!rs.recordset.length) throw erroNegocio('Serviço não encontrado.', 404);

  const ctx = await contextoDoDia(q, empresaId, data);
  const horarios = horariosLivres({
    periodos: ctx.periodos,
    recursos: ctx.atendimento,
    veiculos: ctx.veiculos,
    ocupacoes: ctx.ocupacoes,
    duracao: rs.recordset[0].duracao_minutos,
    passo: ctx.passo,
    levaTraz: !!levaTraz,
    desloc: ctx.desloc,
    minimoInicio: data === hojeSaoPaulo() ? agoraHHMMSaoPaulo() : null,
  });
  return { horarios, leva_traz_disponivel: ctx.veiculos.length > 0 };
}

/**
 * Cria o agendamento (e a busca/entrega do leva-e-traz) DENTRO de uma
 * transação já aberta. `query` é o da transação; o chamador é responsável
 * pela trava de serialização por empresa.
 */
async function criarAgendamento(query, dados) {
  const {
    empresaId, clienteId, petId, servicoId, data, inicio,
    levaTraz, observacao, usuarioId = null, origem = 'PETSHOP',
  } = dados;

  if (!Number.isInteger(clienteId) || !Number.isInteger(servicoId) ||
      !DATA_RE.test(String(data)) || !HHMM_RE.test(String(inicio)) ||
      (petId !== null && !Number.isInteger(petId))) {
    throw erroNegocio('Dados do agendamento inválidos.', 400);
  }
  if (data < hojeSaoPaulo()) throw erroNegocio('Não é possível agendar no passado.', 400);

  const rc = await query(
    'SELECT id FROM clientes WHERE id = $1 AND empresa_id = $2 AND ativo',
    [clienteId, empresaId]);
  if (!rc.recordset.length) throw erroNegocio('Cliente não encontrado.', 404);

  if (petId !== null) {
    const rp = await query(
      'SELECT id FROM pets WHERE id = $1 AND empresa_id = $2 AND cliente_id = $3 AND ativo',
      [petId, empresaId, clienteId]);
    if (!rp.recordset.length) throw erroNegocio('Pet não pertence a este cliente.', 400);
  }

  const rs = await query(
    'SELECT nome, duracao_minutos FROM servicos WHERE id = $1 AND empresa_id = $2 AND ativo',
    [servicoId, empresaId]);
  if (!rs.recordset.length) throw erroNegocio('Serviço não encontrado.', 404);
  const duracao = rs.recordset[0].duracao_minutos;

  const ctx = await contextoDoDia(query, empresaId, data);
  if (ctx.fechado || !ctx.periodos.length) throw erroNegocio('O petshop não abre neste dia.', 409);
  if (levaTraz && !ctx.veiculos.length) {
    throw erroNegocio('Este petshop não faz leva-e-traz.', 409);
  }

  // Revalida DENTRO da transação: se outra pessoa acabou de ocupar, cai aqui.
  const livres = horariosLivres({
    periodos: ctx.periodos, recursos: ctx.atendimento, veiculos: ctx.veiculos,
    ocupacoes: ctx.ocupacoes, duracao, passo: ctx.passo,
    levaTraz: !!levaTraz, desloc: ctx.desloc,
    minimoInicio: data === hojeSaoPaulo() ? agoraHHMMSaoPaulo() : null,
  });
  if (!livres.includes(inicio)) {
    throw erroNegocio('Este horário acabou de ficar indisponível. Escolha outro.', 409);
  }

  const fim = paraHHMM(paraMinutos(inicio) + duracao);
  const recursoId = escolherRecurso(ctx.atendimento, ctx.ocupacoes, inicio, fim);

  const ra = await query(
    `INSERT INTO agendamentos (empresa_id, cliente_id, pet_id, servico_id, recurso_id,
                               tipo, data, inicio, fim, observacao, criado_por, origem)
     VALUES ($1, $2, $3, $4, $5, 'SERVICO', $6, $7, $8, $9, $10, $11)
     RETURNING id, data, inicio, fim, recurso_id`,
    [empresaId, clienteId, petId, servicoId, recursoId, data, inicio, fim,
     String(observacao || '').trim().slice(0, 500) || null, usuarioId, origem]
  );
  const principal = ra.recordset[0];
  let busca = null;
  let entrega = null;
  let avisoEntrega = null;

  if (levaTraz) {
    const iniBusca = paraHHMM(paraMinutos(inicio) - ctx.desloc);
    const veiculoBusca = escolherRecurso(ctx.veiculos, ctx.ocupacoes, iniBusca, inicio);
    const rb = await query(
      `INSERT INTO agendamentos (empresa_id, cliente_id, pet_id, servico_id, recurso_id,
                                 tipo, agendamento_pai_id, data, inicio, fim, criado_por, origem)
       VALUES ($1, $2, $3, $4, $5, 'BUSCA', $6, $7, $8, $9, $10, $11)
       RETURNING id, inicio, fim`,
      [empresaId, clienteId, petId, servicoId, veiculoBusca, principal.id,
       data, iniBusca, inicio, usuarioId, origem]
    );
    busca = rb.recordset[0];

    const ocupacoesComBusca = ctx.ocupacoes.concat([
      { recurso_id: veiculoBusca, inicio: iniBusca, fim: inicio },
    ]);
    const encaixe = primeiroEncaixe({
      periodos: ctx.periodos, recursos: ctx.veiculos,
      ocupacoes: ocupacoesComBusca, aPartirDe: fim, duracao: ctx.desloc,
    });
    if (encaixe) {
      const re = await query(
        `INSERT INTO agendamentos (empresa_id, cliente_id, pet_id, servico_id, recurso_id,
                                   tipo, agendamento_pai_id, data, inicio, fim, criado_por, origem)
         VALUES ($1, $2, $3, $4, $5, 'ENTREGA', $6, $7, $8, $9, $10, $11)
         RETURNING id, inicio, fim`,
        [empresaId, clienteId, petId, servicoId, encaixe.recurso_id, principal.id,
         data, encaixe.inicio, encaixe.fim, usuarioId, origem]
      );
      entrega = re.recordset[0];
    } else {
      avisoEntrega = 'Sem janela livre do veículo para a entrega — combinar manualmente.';
    }
  }

  return { agendamento: principal, busca, entrega, aviso_entrega: avisoEntrega };
}

module.exports = {
  contextoDoDia, calcularHorariosLivres, criarAgendamento,
  erroNegocio, HHMM_RE, DATA_RE,
};
