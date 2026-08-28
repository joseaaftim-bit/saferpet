'use strict';

// Motor de horários da agenda. Funções PURAS sobre minutos — nada de banco
// aqui, para a bateria de testes cobrir cada caso de borda.
//
// Regra central (a do usuário): o horário só é ofertado se cabe o serviço
// INTEIRO em algum recurso livre. Agendou 45 min às 10:00, o próximo livre
// é 10:45; agendou 30, é 10:30.

function paraMinutos(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + m;
}

function paraHHMM(minutos) {
  const h = Math.floor(minutos / 60);
  const m = minutos % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// intervalos [inicio, fim) — toque de ponta (10:00–10:30 e 10:30–11:00) não conflita.
function sobrepoe(aIni, aFim, bIni, bFim) {
  return aIni < bFim && bIni < aFim;
}

/**
 * Monta o mapa recurso_id -> lista de [inicio_min, fim_min) ocupados.
 * `ocupacoes`: [{ recurso_id, inicio: 'HH:MM', fim: 'HH:MM' }]
 */
function indexarOcupacoes(ocupacoes) {
  const porRecurso = new Map();
  for (const o of ocupacoes || []) {
    if (!porRecurso.has(o.recurso_id)) porRecurso.set(o.recurso_id, []);
    porRecurso.get(o.recurso_id).push([paraMinutos(o.inicio), paraMinutos(o.fim)]);
  }
  return porRecurso;
}

function recursoLivre(porRecurso, recursoId, ini, fim) {
  const lista = porRecurso.get(recursoId) || [];
  return !lista.some(([oIni, oFim]) => sobrepoe(ini, fim, oIni, oFim));
}

/**
 * Horários de início possíveis para um serviço.
 *
 * @param {Object} opts
 *   periodos:   [{inicio:'HH:MM', fim:'HH:MM'}] — funcionamento do dia
 *   recursos:   [id, ...] recursos de ATENDIMENTO ativos
 *   veiculos:   [id, ...] recursos VEICULO ativos (para leva-e-traz)
 *   ocupacoes:  [{recurso_id, inicio, fim}] — agendamentos que bloqueiam
 *   duracao:    minutos do serviço
 *   passo:      granularidade da grade (min)
 *   levaTraz:   se true, exige veículo livre no deslocamento ANTES do início
 *   desloc:     minutos de deslocamento do leva-e-traz
 *   minimoInicio: 'HH:MM' — corta horários no passado (dia de hoje)
 * @returns ['HH:MM', ...]
 */
function horariosLivres(opts) {
  const {
    periodos = [], recursos = [], veiculos = [], ocupacoes = [],
    duracao, passo = 15, levaTraz = false, desloc = 30, minimoInicio = null,
  } = opts;

  if (!duracao || duracao <= 0 || !recursos.length) return [];
  if (levaTraz && !veiculos.length) return [];

  const porRecurso = indexarOcupacoes(ocupacoes);
  const pers = periodos
    .map(p => [paraMinutos(p.inicio), paraMinutos(p.fim)])
    .filter(([i, f]) => f > i)
    .sort((a, b) => a[0] - b[0]);
  const minimo = minimoInicio ? paraMinutos(minimoInicio) : -1;

  const livres = [];
  for (const [perIni, perFim] of pers) {
    for (let t = perIni; t + duracao <= perFim; t += passo) {
      if (t < minimo) continue;
      if (!recursos.some(r => recursoLivre(porRecurso, r, t, t + duracao))) continue;

      if (levaTraz) {
        const iniBusca = t - desloc;
        if (iniBusca < 0) continue;
        // Hoje, a BUSCA também não pode começar no passado.
        if (minimo >= 0 && iniBusca < minimo) continue;
        // O motorista trabalha dentro do funcionamento: a busca precisa
        // caber em algum período do dia.
        const buscaDentro = pers.some(([i, f]) => iniBusca >= i && t <= f);
        if (!buscaDentro) continue;
        if (!veiculos.some(v => recursoLivre(porRecurso, v, iniBusca, t))) continue;
      }

      livres.push(paraHHMM(t));
    }
  }
  return livres;
}

/**
 * Escolhe um recurso livre para [inicio, fim). Retorna o id ou null.
 */
function escolherRecurso(recursos, ocupacoes, inicioHHMM, fimHHMM) {
  const porRecurso = indexarOcupacoes(ocupacoes);
  const ini = paraMinutos(inicioHHMM);
  const fim = paraMinutos(fimHHMM);
  for (const r of recursos) {
    if (recursoLivre(porRecurso, r, ini, fim)) return r;
  }
  return null;
}

/**
 * Primeiro encaixe de `duracao` minutos em algum veículo, começando em
 * `aPartirDe` ou depois, dentro dos períodos. Usado para agendar a ENTREGA
 * logo após o fim do serviço. Retorna { recurso_id, inicio, fim } ou null.
 */
function primeiroEncaixe({ periodos = [], recursos = [], ocupacoes = [], aPartirDe, duracao, passo = 5 }) {
  const porRecurso = indexarOcupacoes(ocupacoes);
  const pers = periodos
    .map(p => [paraMinutos(p.inicio), paraMinutos(p.fim)])
    .filter(([i, f]) => f > i)
    .sort((a, b) => a[0] - b[0]);
  const minimo = paraMinutos(aPartirDe);

  for (const [perIni, perFim] of pers) {
    const inicioVarredura = Math.max(perIni, Math.ceil(minimo / passo) * passo);
    for (let t = inicioVarredura; t + duracao <= perFim; t += passo) {
      for (const r of recursos) {
        if (recursoLivre(porRecurso, r, t, t + duracao)) {
          return { recurso_id: r, inicio: paraHHMM(t), fim: paraHHMM(t + duracao) };
        }
      }
    }
  }
  return null;
}

function diaDaSemana(dataISO) {
  // Ancorado ao meio-dia UTC: o dia da semana de uma data de calendário
  // não depende do fuso do servidor.
  return new Date(`${dataISO}T12:00:00Z`).getUTCDay();
}

function agoraHHMMSaoPaulo() {
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date()).replace('h', ':');
}

module.exports = {
  paraMinutos, paraHHMM, sobrepoe, horariosLivres,
  escolherRecurso, primeiroEncaixe, diaDaSemana, agoraHHMMSaoPaulo,
};
