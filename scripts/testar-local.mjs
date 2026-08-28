// Bateria local do SaferPet contra um Postgres em memória (pg-mem).
// Roda sem banco instalado: npm run teste:local
// Cobre o motor de horários (unitário), a agenda de ponta a ponta, os
// créditos por serviço, isolamento entre petshops, permissões e limites.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'segredo-de-teste';
process.env.HUB_TOKEN = 'hub-de-teste';
process.env.APP_URL = 'http://localhost:4600';

import { createRequire } from 'module';
import { readFileSync, readdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { newDb } from 'pg-mem';

const require = createRequire(import.meta.url);
const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ─── Banco em memória ────────────────────────────────────────────────
// pg-mem não entende FOR UPDATE. A remoção precisa acontecer NO MESMO
// client (nunca via interceptQueries, que executa fora da transação e
// quebra o ROLLBACK depois de uma escrita).
const db = newDb();

function removerForUpdate(sql) {
  const m = /^([\s\S]*?)\s+FOR\s+UPDATE(\s+OF\s+[\w,\s]+)?\s*;?\s*$/i.exec(sql);
  return m ? m[1] : sql;
}
// O adaptador pg do pg-mem também IGNORA ROLLBACK (escritas são imediatas).
// Emulamos a transação com backup/restore do próprio pg-mem — no Postgres
// real o BEGIN/ROLLBACK do backend funciona normalmente.
function embrulharPool(poolReal) {
  return {
    query: (sql, params) => poolReal.query(removerForUpdate(sql), params),
    connect: async () => {
      const cliente = await poolReal.connect();
      let snapshot = null;
      return {
        query: (sql, params) => {
          const comando = String(sql).trim().toUpperCase();
          if (comando === 'BEGIN') { snapshot = db.backup(); return Promise.resolve({ rows: [], rowCount: 0 }); }
          if (comando === 'ROLLBACK') {
            if (snapshot) { snapshot.restore(); snapshot = null; }
            return Promise.resolve({ rows: [], rowCount: 0 });
          }
          if (comando === 'COMMIT') { snapshot = null; return Promise.resolve({ rows: [], rowCount: 0 }); }
          return cliente.query(removerForUpdate(sql), params);
        },
        release: () => cliente.release(),
      };
    },
    end: () => poolReal.end(),
  };
}

const { Pool } = db.adapters.createPg();
const poolBruto = new Pool();
const pool = embrulharPool(poolBruto);
const database = require(path.join(raiz, 'backend', 'database.js'));
database.injetarPoolParaTestes(pool);

// Aplica TODAS as migrations. Adaptações para o pg-mem: sem CREATE INDEX,
// sem ADD COLUMN IF NOT EXISTS, e sem o bloco "Migração de dados
// existentes" (num banco recém-criado ele é vazio por definição — e o
// pg-mem não planeja INSERT..SELECT com NOT EXISTS correlacionado).
for (const arquivo of readdirSync(path.join(raiz, 'migrations')).filter(f => f.endsWith('.sql')).sort()) {
  const sql = readFileSync(path.join(raiz, 'migrations', arquivo), 'utf-8')
    .split('Migração de dados existentes')[0]
    .split('\n').filter(l => !/^\s*CREATE INDEX/i.test(l)).join('\n')
    .replace(/ADD COLUMN IF NOT EXISTS/gi, 'ADD COLUMN');
  await pool.query(sql);
}

// Mercado Pago falso: substituído ANTES do server carregar as rotas, para
// o destructuring em pagamentos.js pegar estas versões. Permite exercitar
// o webhook inteiro (criar preferência → pagar → creditar) sem rede.
const mpFalso = require(path.join(raiz, 'backend', 'util', 'mercadopago.js'));
const pagamentosSimulados = new Map(); // payment_id -> pagamento do MP
let preferenciasCriadas = 0;
let falharProximaPreferencia = false;

mpFalso.criarPreferencia = async (_token, opcoes) => {
  if (falharProximaPreferencia) {
    falharProximaPreferencia = false;
    throw Object.assign(new Error('MP indisponível (simulado)'), { statusMP: 500 });
  }
  preferenciasCriadas += 1;
  const id = `pref-${preferenciasCriadas}`;
  // Guarda o que seria pago, para o "pagamento" bater com a preferência.
  pagamentosSimulados.set(`pay-${preferenciasCriadas}`, {
    id: `pay-${preferenciasCriadas}`,
    status: 'approved',
    external_reference: opcoes.externalReference,
    transaction_amount: opcoes.valorCentavos / 100,
    preference_id: id,
  });
  return { id, init_point: `https://mp.exemplo/checkout/${id}` };
};
mpFalso.consultarPagamento = async (_token, paymentId) => {
  const pgto = pagamentosSimulados.get(String(paymentId));
  if (!pgto) throw new Error('pagamento não encontrado (simulado)');
  return pgto;
};
mpFalso.buscarPagamentosDaPreferencia = async (_token, preferenceId) =>
  [...pagamentosSimulados.values()].filter(p => p.preference_id === preferenceId);

const { app } = require(path.join(raiz, 'backend', 'server.js'));
const motor = require(path.join(raiz, 'backend', 'util', 'agenda.js'));
const rotaPagamentos = require(path.join(raiz, 'backend', 'rotas', 'pagamentos.js'));
const servidor = app.listen(0);
const base = `http://127.0.0.1:${servidor.address().port}`;

// ─── Ferramentas ─────────────────────────────────────────────────────
let total = 0;
let falhas = 0;

function verificar(nome, condicao, detalhe) {
  total += 1;
  if (condicao) console.log(`  ok  ${nome}`);
  else { falhas += 1; console.error(`FALHA ${nome}${detalhe ? ` — ${detalhe}` : ''}`); }
}

async function chamar(metodo, caminho, { token, corpo } = {}) {
  const resp = await fetch(`${base}${caminho}`, {
    method: metodo,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  const dados = await resp.json().catch(() => ({}));
  return { status: resp.status, dados };
}

function somarDias(iso, n) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const hoje = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Sao_Paulo' }).format(new Date());
const dataTeste = somarDias(hoje, 7);
const dataFechada = somarDias(hoje, 8);

// ─── Bateria ─────────────────────────────────────────────────────────
try {
  console.log('\n— Motor de horários (unitário) —');
  {
    const basico = motor.horariosLivres({
      periodos: [{ inicio: '08:00', fim: '12:00' }],
      recursos: [1], duracao: 45, passo: 15,
    });
    verificar('grade vazia começa na abertura', basico[0] === '08:00');
    verificar('último início deixa o serviço caber (11:15 sim, 11:30 não)',
      basico.includes('11:15') && !basico.includes('11:30'));

    const ocupado45 = motor.horariosLivres({
      periodos: [{ inicio: '08:00', fim: '12:00' }],
      recursos: [1], duracao: 45, passo: 15,
      ocupacoes: [{ recurso_id: 1, inicio: '10:00', fim: '10:45' }],
    });
    verificar('exemplo do dono: 45 min às 10:00 → próximo livre 10:45',
      !ocupado45.includes('10:00') && ocupado45.includes('10:45'), JSON.stringify(ocupado45));
    verificar('toque de ponta não conflita (09:15 + 45 = 10:00 em ponto)',
      ocupado45.includes('09:15') && !ocupado45.includes('09:30'));

    const ocupado30 = motor.horariosLivres({
      periodos: [{ inicio: '08:00', fim: '12:00' }],
      recursos: [1], duracao: 30, passo: 15,
      ocupacoes: [{ recurso_id: 1, inicio: '10:00', fim: '10:30' }],
    });
    verificar('30 min às 10:00 → próximo livre 10:30', ocupado30.includes('10:30') && !ocupado30.includes('10:15'));

    const doisRecursos = motor.horariosLivres({
      periodos: [{ inicio: '08:00', fim: '12:00' }],
      recursos: [1, 2], duracao: 45, passo: 15,
      ocupacoes: [{ recurso_id: 1, inicio: '10:00', fim: '10:45' }],
    });
    verificar('com 2 recursos, o horário ocupado em um continua livre no outro', doisRecursos.includes('10:00'));

    const levaTraz = motor.horariosLivres({
      periodos: [{ inicio: '08:00', fim: '12:00' }],
      recursos: [1], veiculos: [9], duracao: 45, passo: 15,
      levaTraz: true, desloc: 30,
      ocupacoes: [{ recurso_id: 9, inicio: '09:30', fim: '10:00' }],
    });
    verificar('leva-e-traz: 08:00 cai (busca seria antes de abrir), 08:30 fica',
      !levaTraz.includes('08:00') && levaTraz.includes('08:30'));
    verificar('leva-e-traz: veículo ocupado 09:30–10:00 derruba 10:00 e 10:15, mantém 10:30',
      !levaTraz.includes('10:00') && !levaTraz.includes('10:15') && levaTraz.includes('10:30'),
      JSON.stringify(levaTraz));

    const levaTrazHoje = motor.horariosLivres({
      periodos: [{ inicio: '08:00', fim: '12:00' }],
      recursos: [1], veiculos: [9], duracao: 30, passo: 15,
      levaTraz: true, desloc: 30, minimoInicio: '10:00',
    });
    verificar('leva-e-traz hoje: a BUSCA também não pode começar no passado',
      !levaTrazHoje.includes('10:15') && levaTrazHoje.includes('10:30'), JSON.stringify(levaTrazHoje));

    const encaixe = motor.primeiroEncaixe({
      periodos: [{ inicio: '08:00', fim: '12:00' }],
      recursos: [9], aPartirDe: '10:45', duracao: 30,
      ocupacoes: [{ recurso_id: 9, inicio: '10:45', fim: '11:15' }],
    });
    verificar('entrega pega o primeiro encaixe do veículo (11:15–11:45)',
      encaixe && encaixe.inicio === '11:15' && encaixe.fim === '11:45', JSON.stringify(encaixe));
  }

  console.log('\n— Cadastro, defaults e serviços —');
  const regA = await chamar('POST', '/api/auth/registrar', { corpo: {
    empresa_nome: 'Salva Patas', whatsapp: '67999990000',
    nome: 'Dona A', email: 'a@teste.com', senha: 'senha-forte-1',
  }});
  verificar('registrar petshop A', regA.status === 201 && !!regA.dados.token);
  const tokenA = regA.dados.token;

  const servicosIniciais = await chamar('GET', '/api/servicos', { token: tokenA });
  verificar('empresa nasce com o serviço Banho', servicosIniciais.dados.length === 1 &&
    servicosIniciais.dados[0].nome === 'Banho' && servicosIniciais.dados[0].duracao_minutos === 30);
  const banhoId = servicosIniciais.dados[0].id;

  const configInicial = await chamar('GET', '/api/agenda/config', { token: tokenA });
  verificar('empresa nasce com horários e um recurso de atendimento',
    configInicial.dados.horarios.length === 6 && configInicial.dados.recursos.length === 1);

  const tosa = await chamar('POST', '/api/servicos', { token: tokenA, corpo: {
    nome: 'Banho e tosa', duracao_minutos: 45, preco_centavos: 8000,
  }});
  verificar('admin cria serviço com duração própria', tosa.status === 201);
  const tosaId = tosa.dados.id;

  console.log('\n— Configuração da agenda —');
  const horariosSemana = [0, 1, 2, 3, 4, 5, 6].map(d => ({ dia_semana: d, inicio: '08:00', fim: '18:00' }));
  const putConfig = await chamar('PUT', '/api/agenda/config', { token: tokenA, corpo: {
    horarios: horariosSemana, tempo_deslocamento_minutos: 30, intervalo_grade_minutos: 15,
  }});
  verificar('admin define funcionamento e deslocamento', putConfig.status === 200);

  const van = await chamar('POST', '/api/agenda/recursos', { token: tokenA, corpo: { nome: 'Van', tipo: 'VEICULO' } });
  verificar('admin cadastra o veículo do leva-e-traz', van.status === 201 && van.dados.tipo === 'VEICULO');

  const configRuim = await chamar('PUT', '/api/agenda/config', { token: tokenA, corpo: {
    horarios: [{ dia_semana: 1, inicio: '18:00', fim: '08:00' }],
    tempo_deslocamento_minutos: 30, intervalo_grade_minutos: 15,
  }});
  verificar('período invertido é recusado', configRuim.status === 400);

  console.log('\n— Cliente, pacote com itens por serviço —');
  const cli = await chamar('POST', '/api/clientes', { token: tokenA, corpo: { nome: 'Mariana Souza', telefone: '67988887777' } });
  const clienteId = cli.dados.id;
  const mel = await chamar('POST', '/api/pets', { token: tokenA, corpo: { cliente_id: clienteId, nome: 'Mel' } });
  const luna = await chamar('POST', '/api/pets', { token: tokenA, corpo: { cliente_id: clienteId, nome: 'Luna' } });
  verificar('cliente e pets criados', cli.status === 201 && mel.status === 201 && luna.status === 201);

  const modelo = await chamar('POST', '/api/pacotes/modelos', { token: tokenA, corpo: {
    nome: 'Combo 24', valor_centavos: 70000, validade_meses: 12,
    itens: [{ servico_id: banhoId, quantidade: 20 }, { servico_id: tosaId, quantidade: 4 }],
  }});
  verificar('modelo com itens de serviços diferentes', modelo.status === 201 && modelo.dados.itens.length === 2);

  const venda = await chamar('POST', '/api/pacotes', { token: tokenA, corpo: {
    cliente_id: clienteId, modelo_id: modelo.dados.id,
    itens: [{ servico_id: banhoId, quantidade: 999 }], valor_centavos: 1,
  }});
  verificar('venda pelo catálogo ignora itens/valor forjados no corpo',
    venda.status === 201 && venda.dados.saldo === 24 && venda.dados.valor_centavos === 70000 &&
    venda.dados.itens.length === 2, JSON.stringify(venda.dados));

  console.log('\n— Baixa por serviço e estorno —');
  const baixaBanho = await chamar('POST', '/api/baixas', { token: tokenA, corpo: {
    cliente_id: clienteId, itens: [{ pet_id: mel.dados.id, servico_id: banhoId }],
  }});
  verificar('baixa de banho consome o crédito certo (item 20 → 19, total 23)',
    baixaBanho.status === 201 && baixaBanho.dados.saldo === 23 &&
    baixaBanho.dados.baixas[0].saldo_apos === 19, JSON.stringify(baixaBanho.dados));

  const baixaTosa2 = await chamar('POST', '/api/baixas', { token: tokenA, corpo: {
    cliente_id: clienteId,
    itens: [{ pet_id: mel.dados.id, servico_id: tosaId }, { pet_id: luna.dados.id, servico_id: tosaId }],
  }});
  verificar('duas tosas numa operação (item 4 → 2)', baixaTosa2.status === 201 &&
    baixaTosa2.dados.baixas[1].saldo_apos === 2);

  const baixaTosa3 = await chamar('POST', '/api/baixas', { token: tokenA, corpo: {
    cliente_id: clienteId,
    itens: [{ servico_id: tosaId }, { servico_id: tosaId }, { servico_id: tosaId }],
  }});
  verificar('3 tosas com só 2 créditos: 409 e NADA é gravado', baixaTosa3.status === 409);
  const fichaTosa = await chamar('GET', `/api/clientes/${clienteId}`, { token: tokenA });
  const itemTosa = fichaTosa.dados.pacotes[0].itens.find(i => i.servico_id === tosaId);
  verificar('crédito de tosa continua 2 após o 409', itemTosa && itemTosa.saldo === 2);

  const estorno = await chamar('POST', `/api/baixas/${baixaTosa2.dados.baixas[1].id}/estornar`, { token: tokenA });
  verificar('estorno devolve ao item certo (tosa 2 → 3)', estorno.status === 200 && estorno.dados.saldo === 22);
  const estornoDuplo = await chamar('POST', `/api/baixas/${baixaTosa2.dados.baixas[1].id}/estornar`, { token: tokenA });
  verificar('estornar duas vezes dá 409', estornoDuplo.status === 409);

  console.log('\n— FIFO entre pacotes e validade (cliente Carlos) —');
  const carlos = await chamar('POST', '/api/clientes', { token: tokenA, corpo: { nome: 'Carlos Henrique' } });
  const carlosId = carlos.dados.id;
  const velho = await chamar('POST', '/api/pacotes', { token: tokenA, corpo: {
    cliente_id: carlosId, nome: 'Avulso 1 banho', valor_centavos: 5000,
    itens: [{ servico_id: banhoId, quantidade: 1 }],
  }});
  const novo = await chamar('POST', '/api/pacotes', { token: tokenA, corpo: {
    cliente_id: carlosId, nome: 'Pacote 10 banhos', valor_centavos: 40000,
    itens: [{ servico_id: banhoId, quantidade: 10 }],
  }});
  verificar('dois pacotes ativos vendidos', velho.status === 201 && novo.status === 201);

  const fifo1 = await chamar('POST', '/api/baixas', { token: tokenA, corpo: {
    cliente_id: carlosId, itens: [{ servico_id: banhoId }],
  }});
  verificar('FIFO: primeiro consome o pacote mais antigo (esgota o avulso)',
    fifo1.status === 201 && fifo1.dados.baixas[0].saldo_apos === 0 && fifo1.dados.saldo === 10);

  const fifo2 = await chamar('POST', '/api/baixas', { token: tokenA, corpo: {
    cliente_id: carlosId, itens: [{ servico_id: banhoId }],
  }});
  verificar('depois passa para o pacote seguinte (10 → 9)',
    fifo2.status === 201 && fifo2.dados.baixas[0].saldo_apos === 9);

  await pool.query(`UPDATE pacotes SET validade_ate = '2020-01-01' WHERE id = ${novo.dados.id}`);
  const baixaVencido = await chamar('POST', '/api/baixas', { token: tokenA, corpo: {
    cliente_id: carlosId, itens: [{ servico_id: banhoId }],
  }});
  verificar('crédito de pacote vencido não conta (409)', baixaVencido.status === 409);

  await pool.query(`UPDATE pacotes SET status = 'VENCIDO' WHERE id = ${novo.dados.id}`);
  const reativarSemData = await chamar('PUT', `/api/pacotes/${novo.dados.id}`, { token: tokenA, corpo: { status: 'ATIVO' } });
  verificar('reativar vencido sem nova validade dá 409', reativarSemData.status === 409);
  const reativar = await chamar('PUT', `/api/pacotes/${novo.dados.id}`, { token: tokenA, corpo: {
    status: 'ATIVO', validade_ate: '2030-01-01',
  }});
  verificar('reativar com validade futura volta a funcionar', reativar.status === 200 &&
    (await chamar('POST', '/api/baixas', { token: tokenA, corpo: { cliente_id: carlosId, itens: [{ servico_id: banhoId }] } })).status === 201);

  console.log('\n— Agenda: horários livres e agendamentos —');
  const livres0 = await chamar('GET', `/api/agenda/horarios-livres?data=${dataTeste}&servico_id=${tosaId}`, { token: tokenA });
  verificar('dia aberto oferece horários desde as 08:00',
    livres0.status === 200 && livres0.dados.horarios[0] === '08:00' && livres0.dados.leva_traz_disponivel === true);

  const ag1 = await chamar('POST', '/api/agenda/agendamentos', { token: tokenA, corpo: {
    cliente_id: clienteId, pet_id: mel.dados.id, servico_id: tosaId, data: dataTeste, inicio: '10:00',
  }});
  verificar('agendar 45 min às 10:00 calcula fim 10:45', ag1.status === 201 && ag1.dados.agendamento.fim === '10:45');

  const livres1 = await chamar('GET', `/api/agenda/horarios-livres?data=${dataTeste}&servico_id=${tosaId}`, { token: tokenA });
  verificar('na API: 10:00 some, 10:45 é o próximo livre, 09:30 cai, 09:15 fica',
    !livres1.dados.horarios.includes('10:00') && livres1.dados.horarios.includes('10:45') &&
    !livres1.dados.horarios.includes('09:30') && livres1.dados.horarios.includes('09:15'));

  const conflito = await chamar('POST', '/api/agenda/agendamentos', { token: tokenA, corpo: {
    cliente_id: clienteId, servico_id: tosaId, data: dataTeste, inicio: '10:15',
  }});
  verificar('horário em conflito é recusado (409)', conflito.status === 409);

  const ag2 = await chamar('POST', '/api/agenda/agendamentos', { token: tokenA, corpo: {
    cliente_id: clienteId, pet_id: luna.dados.id, servico_id: tosaId, data: dataTeste, inicio: '10:45',
  }});
  verificar('encostar no fim do anterior pode (10:45)', ag2.status === 201);

  const livresLt = await chamar('GET', `/api/agenda/horarios-livres?data=${dataTeste}&servico_id=${tosaId}&leva_traz=true`, { token: tokenA });
  verificar('leva-e-traz não oferece 08:00 (busca seria antes de abrir)',
    !livresLt.dados.horarios.includes('08:00') && livresLt.dados.horarios.includes('08:30'));

  const agLt = await chamar('POST', '/api/agenda/agendamentos', { token: tokenA, corpo: {
    cliente_id: clienteId, pet_id: mel.dados.id, servico_id: tosaId, data: dataTeste,
    inicio: '14:00', leva_traz: true,
  }});
  verificar('leva-e-traz cria busca 13:30–14:00 e entrega no primeiro encaixe (14:45)',
    agLt.status === 201 && agLt.dados.busca && agLt.dados.busca.inicio === '13:30' &&
    agLt.dados.entrega && agLt.dados.entrega.inicio === '14:45', JSON.stringify(agLt.dados));

  const dia = await chamar('GET', `/api/agenda/dia?data=${dataTeste}`, { token: tokenA });
  verificar('painel do dia traz os 5 blocos (3 serviços + busca + entrega)',
    dia.dados.agendamentos.length === 5 && dia.dados.recursos.length === 2);

  const cancelar = await chamar('PUT', `/api/agenda/agendamentos/${agLt.dados.agendamento.id}`, { token: tokenA, corpo: { acao: 'CANCELAR' } });
  const diaAposCancelar = await chamar('GET', `/api/agenda/dia?data=${dataTeste}`, { token: tokenA });
  const cancelados = diaAposCancelar.dados.agendamentos.filter(a => a.status === 'CANCELADO');
  verificar('cancelar o serviço cancela busca e entrega juntas',
    cancelar.status === 200 && cancelados.length === 3);

  const excecao = await chamar('POST', '/api/agenda/excecoes', { token: tokenA, corpo: { data: dataFechada, motivo: 'Feriado' } });
  verificar('fechar dia informa quantos agendamentos são afetados',
    excecao.dados.agendamentos_afetados === 0);
  const livresFechado = await chamar('GET', `/api/agenda/horarios-livres?data=${dataFechada}&servico_id=${banhoId}`, { token: tokenA });
  const agFechado = await chamar('POST', '/api/agenda/agendamentos', { token: tokenA, corpo: {
    cliente_id: clienteId, servico_id: banhoId, data: dataFechada, inicio: '09:00',
  }});
  verificar('dia de exceção fecha a agenda', excecao.status === 201 &&
    livresFechado.dados.horarios.length === 0 && agFechado.status === 409);

  const agPassado = await chamar('POST', '/api/agenda/agendamentos', { token: tokenA, corpo: {
    cliente_id: clienteId, servico_id: banhoId, data: '2020-01-01', inicio: '09:00',
  }});
  verificar('agendar no passado dá 400', agPassado.status === 400);

  console.log('\n— Concluir agendamento consumindo crédito —');
  const concluir = await chamar('PUT', `/api/agenda/agendamentos/${ag1.dados.agendamento.id}`, { token: tokenA, corpo: { acao: 'CONCLUIR' } });
  verificar('concluir consome 1 crédito de tosa do pacote', concluir.status === 200 &&
    concluir.dados.baixa && concluir.dados.sem_credito === false, JSON.stringify(concluir.dados));
  const concluirDuplo = await chamar('PUT', `/api/agenda/agendamentos/${ag1.dados.agendamento.id}`, { token: tokenA, corpo: { acao: 'CONCLUIR' } });
  verificar('concluir duas vezes dá 409', concluirDuplo.status === 409);

  const agCarlos = await chamar('POST', '/api/agenda/agendamentos', { token: tokenA, corpo: {
    cliente_id: carlosId, servico_id: tosaId, data: dataTeste, inicio: '11:30',
  }});
  const concluirSemCredito = await chamar('PUT', `/api/agenda/agendamentos/${agCarlos.dados.agendamento.id}`, { token: tokenA, corpo: { acao: 'CONCLUIR' } });
  verificar('concluir sem crédito do serviço avisa (cobrar na hora)',
    concluirSemCredito.status === 200 && concluirSemCredito.dados.sem_credito === true);

  console.log('\n— Guardas do catálogo e dos recursos —');
  const recursoAtendimento = configInicial.dados.recursos[0];
  const desativarOcupado = await chamar('PUT', `/api/agenda/recursos/${recursoAtendimento.id}`, { token: tokenA, corpo: {
    nome: recursoAtendimento.nome, ativo: false,
  }});
  verificar('recurso com agendamentos futuros não pode ser desativado (409)',
    desativarOcupado.status === 409, JSON.stringify(desativarOcupado.dados));

  await chamar('PUT', `/api/servicos/${tosaId}`, { token: tokenA, corpo: {
    nome: 'Banho e tosa', duracao_minutos: 45, preco_centavos: 8000, ativo: false,
  }});
  const vendaComInativo = await chamar('POST', '/api/pacotes', { token: tokenA, corpo: {
    cliente_id: clienteId, modelo_id: modelo.dados.id,
  }});
  verificar('vender modelo com serviço desativado dá 409', vendaComInativo.status === 409);
  await chamar('PUT', `/api/servicos/${tosaId}`, { token: tokenA, corpo: {
    nome: 'Banho e tosa', duracao_minutos: 45, preco_centavos: 8000, ativo: true,
  }});

  console.log('\n— Ficha, portal e painel —');
  const ficha = await chamar('GET', `/api/clientes/${clienteId}`, { token: tokenA });
  verificar('ficha traz itens do pacote e agendamentos futuros',
    ficha.dados.pacotes[0].itens.length === 2 && ficha.dados.agendamentos.length === 1 &&
    ficha.dados.agendamentos[0].inicio === '10:45');

  const portal = await chamar('GET', `/api/portal/${cli.dados.token_portal}`);
  verificar('portal mostra créditos por serviço e próximos agendamentos',
    portal.status === 200 && portal.dados.pacotes[0].itens.length === 2 &&
    portal.dados.agendamentos.length === 1);

  const painel = await chamar('GET', '/api/dashboard', { token: tokenA });
  verificar('painel traz os contadores novos da agenda',
    painel.status === 200 && Number.isInteger(painel.dados.agendados_hoje) &&
    Number.isInteger(painel.dados.retiradas_hoje));

  console.log('\n— Isolamento entre petshops —');
  const regB = await chamar('POST', '/api/auth/registrar', { corpo: {
    empresa_nome: 'Outro Pet', nome: 'Dono B', email: 'b@teste.com', senha: 'senha-forte-2',
  }});
  const tokenB = regB.dados.token;
  const cliB = await chamar('POST', '/api/clientes', { token: tokenB, corpo: { nome: 'Cliente do B' } });

  const diaB = await chamar('GET', `/api/agenda/dia?data=${dataTeste}`, { token: tokenB });
  verificar('B não vê a agenda do A', diaB.dados.agendamentos.length === 0);
  const acaoCruzada = await chamar('PUT', `/api/agenda/agendamentos/${ag2.dados.agendamento.id}`, { token: tokenB, corpo: { acao: 'CANCELAR' } });
  verificar('B não mexe em agendamento do A', acaoCruzada.status === 404);
  const livresCruzado = await chamar('GET', `/api/agenda/horarios-livres?data=${dataTeste}&servico_id=${tosaId}`, { token: tokenB });
  verificar('B não usa serviço do A', livresCruzado.status === 404);
  const baixaCruzada = await chamar('POST', '/api/baixas', { token: tokenB, corpo: {
    cliente_id: clienteId, itens: [{ servico_id: banhoId }],
  }});
  verificar('B não dá baixa em cliente do A', baixaCruzada.status === 404);
  const fichaCruzada = await chamar('GET', `/api/clientes/${clienteId}`, { token: tokenB });
  verificar('B não abre ficha de cliente do A', fichaCruzada.status === 404);

  console.log('\n— Permissões —');
  const novoAtendente = await chamar('POST', '/api/empresa/usuarios', { token: tokenA, corpo: {
    nome: 'Atendente', email: 'atendente@teste.com', senha: 'senha-forte-3',
  }});
  const loginAt = await chamar('POST', '/api/auth/login', { corpo: { email: 'atendente@teste.com', senha: 'senha-forte-3' } });
  const tokenAt = loginAt.dados.token;
  verificar('admin cria atendente e ele entra', novoAtendente.status === 201 && loginAt.status === 200);

  const configNegada = await chamar('PUT', '/api/agenda/config', { token: tokenAt, corpo: {
    horarios: horariosSemana, tempo_deslocamento_minutos: 30, intervalo_grade_minutos: 15,
  }});
  const servicoNegado = await chamar('POST', '/api/servicos', { token: tokenAt, corpo: {
    nome: 'Golpe', duracao_minutos: 10, preco_centavos: 0,
  }});
  verificar('atendente não mexe em configuração nem catálogo (403)',
    configNegada.status === 403 && servicoNegado.status === 403);

  const agAt = await chamar('POST', '/api/agenda/agendamentos', { token: tokenAt, corpo: {
    cliente_id: clienteId, servico_id: banhoId, data: dataTeste, inicio: '16:00',
  }});
  verificar('atendente agenda normalmente', agAt.status === 201);

  const baixaAt = await chamar('POST', '/api/baixas', { token: tokenAt, corpo: {
    cliente_id: clienteId, itens: [{ servico_id: banhoId }],
  }});
  const estornoAt = await chamar('POST', `/api/baixas/${baixaAt.dados.baixas[0].id}/estornar`, { token: tokenAt });
  verificar('atendente dá baixa e estorna no mesmo dia', baixaAt.status === 201 && estornoAt.status === 200);

  console.log('\n— Enforcement de acesso —');
  await pool.query(`UPDATE empresas SET acesso_ate = '2020-01-01T00:00:00Z' WHERE nome = 'Outro Pet'`);
  const bloqueado = await chamar('GET', '/api/clientes', { token: tokenB });
  const meVencido = await chamar('GET', '/api/auth/me', { token: tokenB });
  const portalB = await chamar('GET', `/api/portal/${cliB.dados.token_portal}`);
  verificar('acesso vencido: 402 nas rotas, /me avisa, portal sai do ar',
    bloqueado.status === 402 && meVencido.dados.empresa.acesso_vigente === false && portalB.status === 503);

  console.log('\n— Fase 2: credenciais, compra e webhook —');
  {
    const crypto = await import('crypto');
    const cripto = require(path.join(raiz, 'backend', 'util', 'cripto.js'));
    const mp = require(path.join(raiz, 'backend', 'util', 'mercadopago.js'));

    const cifrado = cripto.cifrar('APP_USR-segredo-do-petshop');
    verificar('cifra e decifra credencial (AES-GCM)',
      cifrado !== 'APP_USR-segredo-do-petshop' && cripto.decifrar(cifrado) === 'APP_USR-segredo-do-petshop');
    verificar('dado adulterado não decifra (retorna null)',
      cripto.decifrar(cifrado.slice(0, -4) + 'AAAA') === null);

    // HMAC do webhook, nos dois formatos de template aceitos.
    const segredoMP = 'a'.repeat(64);
    const ts = '1700000000';
    const dataId = '123456';
    const requestId = 'req-abc';
    const base = `id:${dataId};request-id:${requestId};ts:${ts}`;
    for (const [nome, template] of [['sem ponto-e-vírgula final', base], ['com ponto-e-vírgula final', `${base};`]]) {
      const v1 = crypto.createHmac('sha256', Buffer.from(segredoMP, 'hex')).update(template).digest('hex');
      verificar(`webhook aceita assinatura válida (${nome})`,
        mp.validarAssinatura({ segredo: segredoMP, xSignature: `ts=${ts},v1=${v1}`, xRequestId: requestId, dataId }));
    }
    verificar('webhook recusa assinatura forjada',
      !mp.validarAssinatura({ segredo: segredoMP, xSignature: `ts=${ts},v1=${'b'.repeat(64)}`, xRequestId: requestId, dataId }));
    verificar('webhook recusa sem segredo configurado',
      !mp.validarAssinatura({ segredo: null, xSignature: `ts=${ts},v1=abcdef`, xRequestId: requestId, dataId }));
    verificar('webhook recusa sem cabeçalho de assinatura',
      !mp.validarAssinatura({ segredo: segredoMP, xSignature: null, xRequestId: requestId, dataId }));
  }

  // Rota do webhook fecha por padrão (empresa A ainda não configurou nada).
  const webhookSemSegredo = await fetch(`${base}/api/pagamentos/webhook/1`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'payment', data: { id: '1' } }),
  });
  verificar('webhook sem segredo configurado responde 503', webhookSemSegredo.status === 503);

  const webhookEmpresaInexistente = await fetch(`${base}/api/pagamentos/webhook/99999`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'payment', data: { id: '1' } }),
  });
  verificar('webhook de empresa inexistente responde 404', webhookEmpresaInexistente.status === 404);

  const salvarMP = await chamar('PUT', '/api/empresa/pagamento', { token: tokenA, corpo: {
    mp_access_token: 'APP_USR-token-de-teste', mp_webhook_secret: 'b'.repeat(64),
  }});
  verificar('admin salva credenciais do Mercado Pago', salvarMP.status === 200);

  const tokenInvalido = await chamar('PUT', '/api/empresa/pagamento', { token: tokenA, corpo: {
    mp_access_token: 'token-qualquer',
  }});
  verificar('access token fora do padrão é recusado', tokenInvalido.status === 400);

  const empConfig = await chamar('GET', '/api/empresa', { token: tokenA });
  verificar('credencial nunca volta em claro (só o final mascarado)',
    empConfig.dados.mp_access_token_final === '••••-teste' &&
    empConfig.dados.mp_webhook_configurado === true &&
    !JSON.stringify(empConfig.dados).includes('APP_USR-token-de-teste'),
    JSON.stringify(empConfig.dados.mp_access_token_final));

  // Sem o segredo do webhook, comprar leva o cliente a pagar sem receber
  // crédito — o botão não pode aparecer.
  await chamar('PUT', '/api/empresa/pagamento', { token: tokenA, corpo: { mp_webhook_secret: '' } });
  const semWebhook = await chamar('GET', `/api/portal/${cli.dados.token_portal}`);
  verificar('sem o segredo do webhook, a compra fica indisponível para o cliente',
    semWebhook.dados.petshop.pagamento_disponivel === false);
  await chamar('PUT', '/api/empresa/pagamento', { token: tokenA, corpo: { mp_webhook_secret: 'b'.repeat(64) } });

  const webhookAssinaturaRuim = await fetch(`${base}/api/pagamentos/webhook/1`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-signature': 'ts=1,v1=deadbeef', 'x-request-id': 'r' },
    body: JSON.stringify({ type: 'payment', data: { id: '9' } }),
  });
  verificar('webhook com assinatura inválida responde 401', webhookAssinaturaRuim.status === 401);

  console.log('\n— Fase 2: o cliente agenda sozinho —');
  // aceita_online nasce DESLIGADO: nenhum petshop passa a aceitar pedidos
  // do cliente sem ligar a chave.
  const portalDesligado = await chamar('GET', `/api/portal/${cli.dados.token_portal}`);
  verificar('agendamento online nasce desligado',
    portalDesligado.dados.petshop.aceita_online === false &&
    portalDesligado.dados.petshop.pagamento_disponivel === false);

  const agendarDesligado = await chamar('POST', `/api/portal/${cli.dados.token_portal}/agendar`, { corpo: {
    servico_id: banhoId, data: dataTeste, inicio: '09:00',
  }});
  verificar('com a chave desligada, o cliente não agenda (409)', agendarDesligado.status === 409);

  await chamar('PUT', '/api/empresa', { token: tokenA, corpo: {
    nome: 'Salva Patas', whatsapp: '67999990000', aceita_online: true,
  }});

  const portalDados = await chamar('GET', `/api/portal/${cli.dados.token_portal}`);
  verificar('portal traz serviços e pacotes à venda',
    portalDados.dados.servicos.length >= 2 && portalDados.dados.pacotes_a_venda.length >= 1 &&
    portalDados.dados.petshop.pagamento_disponivel === true,
    JSON.stringify({ s: portalDados.dados.servicos.length, p: portalDados.dados.pacotes_a_venda.length,
                     pag: portalDados.dados.petshop.pagamento_disponivel }));

  const livresCliente = await chamar('GET',
    `/api/portal/${cli.dados.token_portal}/horarios-livres?data=${dataTeste}&servico_id=${banhoId}`);
  verificar('cliente vê horários livres', livresCliente.status === 200 && livresCliente.dados.horarios.length > 0);

  const agCliente = await chamar('POST', `/api/portal/${cli.dados.token_portal}/agendar`, { corpo: {
    servico_id: banhoId, pet_id: mel.dados.id, data: dataTeste, inicio: livresCliente.dados.horarios[0],
  }});
  verificar('cliente agenda pelo aplicativo', agCliente.status === 201, JSON.stringify(agCliente.dados).slice(0, 160));

  const diaComCliente = await chamar('GET', `/api/agenda/dia?data=${dataTeste}`, { token: tokenA });
  const doCliente = diaComCliente.dados.agendamentos.find(a => a.id === agCliente.dados.agendamento.id);
  verificar('o petshop vê o agendamento marcado como do cliente',
    doCliente && doCliente.origem === 'CLIENTE');

  const levaTrazSemEndereco = await chamar('POST', `/api/portal/${cli.dados.token_portal}/agendar`, { corpo: {
    servico_id: banhoId, data: dataTeste, inicio: livresCliente.dados.horarios[3], leva_traz: true,
  }});
  verificar('leva-e-traz pelo app exige endereço cadastrado', levaTrazSemEndereco.status === 400);

  await chamar('PUT', `/api/portal/${cli.dados.token_portal}/dados`, { corpo: {
    telefone: '67988887777', endereco: 'Rua das Flores, 100 — Centro',
  }});
  const livresLevaTraz = await chamar('GET',
    `/api/portal/${cli.dados.token_portal}/horarios-livres?data=${dataTeste}&servico_id=${banhoId}&leva_traz=true`);
  const agLevaTraz = await chamar('POST', `/api/portal/${cli.dados.token_portal}/agendar`, { corpo: {
    servico_id: banhoId, data: dataTeste, inicio: livresLevaTraz.dados.horarios[2], leva_traz: true,
  }});
  verificar('com endereço, o cliente pede busca em casa',
    agLevaTraz.status === 201 && agLevaTraz.dados.busca, JSON.stringify(agLevaTraz.dados).slice(0, 160));

  const cancelarCliente = await chamar('POST',
    `/api/portal/${cli.dados.token_portal}/agendamentos/${agCliente.dados.agendamento.id}/cancelar`, {});
  verificar('cliente desmarca o próprio horário futuro', cancelarCliente.status === 200);

  const cancelarAlheio = await chamar('POST',
    `/api/portal/${cliB.dados.token_portal}/agendamentos/${agLevaTraz.dados.agendamento.id}/cancelar`, {});
  verificar('cliente não desmarca agendamento de outro', cancelarAlheio.status === 404 || cancelarAlheio.status === 503);

  const comprarSemModelo = await chamar('POST', `/api/pagamentos/portal/${cli.dados.token_portal}/comprar`, { corpo: {} });
  verificar('comprar sem escolher pacote dá 400', comprarSemModelo.status === 400);

  const comprarTokenErrado = await chamar('POST', '/api/pagamentos/portal/token-que-nao-existe-123456/comprar', {
    corpo: { modelo_id: modelo.dados.id },
  });
  verificar('comprar com link inválido dá 404', comprarTokenErrado.status === 404);

  console.log('\n— Fase 3: loja, estoque e entrega na rota —');
  const produto = await chamar('POST', '/api/loja/produtos', { token: tokenA, corpo: {
    nome: 'Ração Premium 10kg', preco_centavos: 25000, estoque: 5,
  }});
  verificar('admin cadastra produto', produto.status === 201 && produto.dados.estoque === 5);

  const produtoNegado = await chamar('POST', '/api/loja/produtos', { token: tokenAt, corpo: {
    nome: 'Golpe', preco_centavos: 1, estoque: 1,
  }});
  verificar('atendente não cadastra produto (403)', produtoNegado.status === 403);

  const semLojaLigada = await chamar('POST', `/api/pagamentos/portal/${cli.dados.token_portal}/pedido`, { corpo: {
    itens: [{ produto_id: produto.dados.id, quantidade: 1 }],
  }});
  verificar('loja desligada recusa pedido (409)', semLojaLigada.status === 409);

  await chamar('PUT', '/api/empresa', { token: tokenA, corpo: {
    nome: 'Salva Patas', whatsapp: '67999990000', vende_produtos: true,
    taxa_entrega_centavos: 1000, entrega_gratis_acima_centavos: 30000,
  }});

  const portalLoja = await chamar('GET', `/api/portal/${cli.dados.token_portal}`);
  verificar('vitrine aparece para o cliente com taxa e frete grátis',
    portalLoja.dados.petshop.vende_produtos === true &&
    portalLoja.dados.produtos.length === 1 &&
    portalLoja.dados.petshop.taxa_entrega_centavos === 1000);

  const estoqueDemais = await chamar('POST', `/api/pagamentos/portal/${cli.dados.token_portal}/pedido`, { corpo: {
    itens: [{ produto_id: produto.dados.id, quantidade: 10 }],
  }});
  verificar('pedido acima do estoque dá 409', estoqueDemais.status === 409,
    JSON.stringify(estoqueDemais));

  const quantidadeAbsurda = await chamar('POST', `/api/pagamentos/portal/${cli.dados.token_portal}/pedido`, { corpo: {
    itens: [{ produto_id: produto.dados.id, quantidade: 999 }],
  }});
  verificar('quantidade absurda por item é recusada (400)', quantidadeAbsurda.status === 400);

  const produtoAlheio = await chamar('POST', `/api/pagamentos/portal/${cli.dados.token_portal}/pedido`, { corpo: {
    itens: [{ produto_id: 999999, quantidade: 1 }],
  }});
  verificar('produto de outro tenant/inexistente dá 404', produtoAlheio.status === 404);

  const estoqueAntes = (await chamar('GET', '/api/loja/produtos', { token: tokenA }))
    .dados.find(p => p.id === produto.dados.id).estoque;
  // Mercado Pago fora do ar na hora de abrir o checkout: o estoque que já
  // foi reservado precisa voltar, senão o produto some do catálogo à toa.
  falharProximaPreferencia = true;
  const pedidoSemMP = await chamar('POST', `/api/pagamentos/portal/${cli.dados.token_portal}/pedido`, { corpo: {
    itens: [{ produto_id: produto.dados.id, quantidade: 2 }],
  }});
  const estoqueDepois = (await chamar('GET', '/api/loja/produtos', { token: tokenA }))
    .dados.find(p => p.id === produto.dados.id).estoque;
  verificar('falha ao abrir o pagamento devolve o estoque reservado',
    pedidoSemMP.status === 502 && estoqueDepois === estoqueAntes,
    JSON.stringify({ status: pedidoSemMP.status, antes: estoqueAntes, depois: estoqueDepois }));

  const pedidosPainel = await chamar('GET', '/api/loja/pedidos', { token: tokenA });
  verificar('painel lista os pedidos com itens', pedidosPainel.status === 200 &&
    pedidosPainel.dados.length >= 1 && Array.isArray(pedidosPainel.dados[0].itens));

  console.log('\n— Fase 4: fotos, vacinas, fila e relatórios —');
  const fotoRuim = await chamar('POST', '/api/extras/fotos', { token: tokenA, corpo: {
    cliente_id: clienteId, conteudo: 'javascript:alert(1)',
  }});
  verificar('conteúdo que não é imagem é recusado', fotoRuim.status === 400);

  const pixel = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const foto = await chamar('POST', '/api/extras/fotos', { token: tokenA, corpo: {
    cliente_id: clienteId, pet_id: mel.dados.id, conteudo: pixel, legenda: 'Mel pronta!',
  }});
  verificar('petshop publica a foto do pet pronto', foto.status === 201);

  const fotoPetAlheio = await chamar('POST', '/api/extras/fotos', { token: tokenA, corpo: {
    cliente_id: carlosId, pet_id: mel.dados.id, conteudo: pixel,
  }});
  verificar('foto com pet de outro cliente é recusada', fotoPetAlheio.status === 400);

  const vacina = await chamar('POST', '/api/extras/vacinas', { token: tokenA, corpo: {
    pet_id: mel.dados.id, nome: 'V10', aplicada_em: hoje, reforco_meses: 12,
  }});
  verificar('registra vacina com reforço calculado',
    vacina.status === 201 && vacina.dados.reforco_em && String(vacina.dados.reforco_em).slice(0, 4) === String(Number(hoje.slice(0, 4)) + 1),
    JSON.stringify(vacina.dados));

  const vacinaProxima = await chamar('POST', '/api/extras/vacinas', { token: tokenA, corpo: {
    pet_id: luna.dados.id, nome: 'Antirrábica', aplicada_em: hoje, reforco_meses: 2,
  }});
  verificar('segunda vacina registrada com reforço próximo', vacinaProxima.status === 201);

  const reforcoLonge = await chamar('GET', '/api/extras/vacinas/reforcos?dias=30', { token: tokenA });
  verificar('reforço distante fica fora da lista de avisos', reforcoLonge.dados.length === 0,
    JSON.stringify(reforcoLonge.dados).slice(0, 120));

  const reforcos = await chamar('GET', '/api/extras/vacinas/reforcos?dias=90', { token: tokenA });
  verificar('lista de reforços a vencer traz o contato do dono',
    reforcos.status === 200 && reforcos.dados.length === 1 && !!reforcos.dados[0].cliente_nome,
    JSON.stringify(reforcos).slice(0, 200));

  const filaCliente = await chamar('POST', `/api/portal/${cli.dados.token_portal}/fila`, { corpo: {
    servico_id: banhoId, data: dataTeste, periodo: 'MANHA',
  }});
  verificar('cliente entra na fila de encaixe', filaCliente.status === 201);

  const filaDuplicada = await chamar('POST', `/api/portal/${cli.dados.token_portal}/fila`, { corpo: {
    servico_id: banhoId, data: dataTeste,
  }});
  verificar('não entra duas vezes na mesma fila', filaDuplicada.status === 409);

  const filaPainel = await chamar('GET', '/api/extras/fila', { token: tokenA });
  verificar('painel vê a fila com quem avisar',
    filaPainel.status === 200 && filaPainel.dados.length === 1 && !!filaPainel.dados[0].telefone);

  const extrasCliente = await chamar('GET', `/api/portal/${cli.dados.token_portal}/extras`);
  verificar('cliente vê fotos e carteirinha no aplicativo',
    extrasCliente.status === 200 && extrasCliente.dados.fotos.length === 1 &&
    extrasCliente.dados.vacinas.length === 2,
    JSON.stringify({ fotos: extrasCliente.dados.fotos.length, vacinas: extrasCliente.dados.vacinas.length }));
  verificar('cliente é convidado a avaliar o atendimento concluído',
    extrasCliente.dados.a_avaliar && Number.isInteger(extrasCliente.dados.a_avaliar.id),
    JSON.stringify(extrasCliente.dados.a_avaliar));

  const avaliar = await chamar('POST', `/api/portal/${cli.dados.token_portal}/avaliar`, { corpo: {
    agendamento_id: extrasCliente.dados.a_avaliar.id, nota: 5, comentario: 'Ficou linda!',
  }});
  verificar('cliente avalia o atendimento', avaliar.status === 201);

  const avaliarDeNovo = await chamar('POST', `/api/portal/${cli.dados.token_portal}/avaliar`, { corpo: {
    agendamento_id: extrasCliente.dados.a_avaliar.id, nota: 1,
  }});
  verificar('avaliar duas vezes o mesmo atendimento dá 409', avaliarDeNovo.status === 409);

  const notaInvalida = await chamar('POST', `/api/portal/${cli.dados.token_portal}/avaliar`, { corpo: {
    agendamento_id: extrasCliente.dados.a_avaliar.id, nota: 9,
  }});
  verificar('nota fora de 1–5 é recusada', notaInvalida.status === 400);

  const relatorios = await chamar('GET', '/api/extras/relatorios?dias=30', { token: tokenA });
  verificar('relatório do dono traz serviços, pacotes e avaliação',
    relatorios.status === 200 &&
    Array.isArray(relatorios.dados.servicos_realizados) &&
    relatorios.dados.pacotes_vendidos.total >= 1 &&
    relatorios.dados.avaliacoes.total === 1 && relatorios.dados.avaliacoes.media === 5,
    JSON.stringify(relatorios.dados.avaliacoes));

  console.log('\n— Isolamento das fases 3 e 4 —');
  const fotoCruzada = await chamar('POST', '/api/extras/fotos', { token: tokenB, corpo: {
    cliente_id: clienteId, conteudo: pixel,
  }});
  verificar('B não publica foto em cliente do A', fotoCruzada.status === 404 || fotoCruzada.status === 402);
  const vacinaCruzada = await chamar('POST', '/api/extras/vacinas', { token: tokenB, corpo: {
    pet_id: mel.dados.id, nome: 'Invasão',
  }});
  verificar('B não registra vacina em pet do A', vacinaCruzada.status === 404 || vacinaCruzada.status === 402);
  const produtoCruzado = await chamar('PUT', `/api/loja/produtos/${produto.dados.id}`, { token: tokenB, corpo: {
    nome: 'Invasão', preco_centavos: 1, estoque: 0,
  }});
  verificar('B não edita produto do A', produtoCruzado.status === 404 || produtoCruzado.status === 402);

  console.log('\n— Ciclo completo de pagamento (webhook com MP simulado) —');
  {
    const crypto = await import('crypto');
    const segredoWebhook = 'b'.repeat(64); // já salvo na empresa A

    // Assina como o Mercado Pago faria, com a chave em string crua.
    function assinar(dataId) {
      const ts = '1700000000';
      const requestId = 'req-teste';
      const template = `id:${dataId};request-id:${requestId};ts:${ts}`;
      const v1 = crypto.createHmac('sha256', segredoWebhook).update(template).digest('hex');
      return { 'x-signature': `ts=${ts},v1=${v1}`, 'x-request-id': requestId };
    }
    async function dispararWebhook(empresaId, paymentId) {
      const resp = await fetch(`${base}/api/pagamentos/webhook/${empresaId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...assinar(paymentId) },
        body: JSON.stringify({ type: 'payment', data: { id: paymentId } }),
      });
      // A rota responde 200 e processa depois: espera o processamento.
      await new Promise(r => setTimeout(r, 300));
      return resp.status;
    }

    // ── Compra de pacote ──
    const saldoAntes = (await chamar('GET', `/api/portal/${cli.dados.token_portal}`))
      .dados.pacotes.reduce((s, p) => s + p.saldo, 0);

    const compra = await chamar('POST', `/api/pagamentos/portal/${cli.dados.token_portal}/comprar`, {
      corpo: { modelo_id: modelo.dados.id },
    });
    verificar('compra online abre o checkout', compra.status === 201 && !!compra.dados.url,
      JSON.stringify(compra.dados));

    const paymentPacote = `pay-${preferenciasCriadas}`;
    const statusWebhook = await dispararWebhook(1, paymentPacote);
    verificar('webhook com assinatura válida (chave crua) é aceito', statusWebhook === 200);

    const portalPago = await chamar('GET', `/api/portal/${cli.dados.token_portal}`);
    const saldoDepois = portalPago.dados.pacotes.reduce((s, p) => s + p.saldo, 0);
    verificar('pagamento aprovado credita o pacote ao cliente',
      saldoDepois === saldoAntes + 24, JSON.stringify({ antes: saldoAntes, depois: saldoDepois }));

    const listaPagamentos = await chamar('GET', '/api/empresa/pagamentos', { token: tokenA });
    const aprovado = listaPagamentos.dados.find(p => p.status === 'APROVADO');
    verificar('o petshop vê o pagamento aprovado', !!aprovado);

    // ── Idempotência: o MP re-tenta o mesmo pagamento ──
    await dispararWebhook(1, paymentPacote);
    const portalRepetido = await chamar('GET', `/api/portal/${cli.dados.token_portal}`);
    const saldoRepetido = portalRepetido.dados.pacotes.reduce((s, p) => s + p.saldo, 0);
    verificar('webhook repetido NÃO credita duas vezes', saldoRepetido === saldoDepois,
      JSON.stringify({ esperado: saldoDepois, obtido: saldoRepetido }));

    // ── Pedido da loja: o bug que ficava AGUARDANDO_PAGAMENTO ──
    const pedido = await chamar('POST', `/api/pagamentos/portal/${cli.dados.token_portal}/pedido`, {
      corpo: { itens: [{ produto_id: produto.dados.id, quantidade: 1 }], entrega: 'RETIRADA' },
    });
    verificar('pedido da loja abre o checkout', pedido.status === 201, JSON.stringify(pedido.dados));

    await dispararWebhook(1, `pay-${preferenciasCriadas}`);
    const pedidosDepois = await chamar('GET', '/api/loja/pedidos', { token: tokenA });
    const pedidoPago = pedidosDepois.dados.find(p => p.id === pedido.dados.pedido_id);
    verificar('pagamento aprovado marca o PEDIDO como PAGO',
      pedidoPago && pedidoPago.status === 'PAGO',
      JSON.stringify(pedidoPago && { id: pedidoPago.id, status: pedidoPago.status }));

    // ── Pedido com entrega entra na rota do veículo ──
    await chamar('PUT', `/api/portal/${cli.dados.token_portal}/dados`, { corpo: {
      telefone: '67988887777', endereco: 'Rua das Flores, 100',
    }});
    const pedidoEntrega = await chamar('POST', `/api/pagamentos/portal/${cli.dados.token_portal}/pedido`, {
      corpo: { itens: [{ produto_id: produto.dados.id, quantidade: 1 }], entrega: 'ENTREGA' },
    });
    verificar('pedido com entrega soma a taxa de frete',
      pedidoEntrega.status === 201 && pedidoEntrega.dados.valor_centavos === 25000 + 1000,
      JSON.stringify(pedidoEntrega.dados));

    await dispararWebhook(1, `pay-${preferenciasCriadas}`);
    const comEntrega = (await chamar('GET', '/api/loja/pedidos', { token: tokenA }))
      .dados.find(p => p.id === pedidoEntrega.dados.pedido_id);
    verificar('pedido pago com entrega entra na agenda do veículo',
      comEntrega && comEntrega.status === 'PAGO' && !!comEntrega.agendamento_id,
      JSON.stringify(comEntrega && { status: comEntrega.status, ag: comEntrega.agendamento_id }));

    // ── Reconciliação: webhook que nunca chegou ──
    const compraPerdida = await chamar('POST', `/api/pagamentos/portal/${cli.dados.token_portal}/comprar`, {
      corpo: { modelo_id: modelo.dados.id },
    });
    verificar('segunda compra aberta', compraPerdida.status === 201);
    // Sem disparar o webhook: envelhece o registro e roda a reconciliação.
    await pool.query(
      `UPDATE pagamentos SET criado_em = NOW() - INTERVAL '30 minutes' WHERE id = ${compraPerdida.dados.pagamento_id}`
    );
    const recuperados = await rotaPagamentos.reconciliarPendentes(10);
    const portalRecuperado = await chamar('GET', `/api/portal/${cli.dados.token_portal}`);
    const saldoRecuperado = portalRecuperado.dados.pacotes.reduce((s, p) => s + p.saldo, 0);
    verificar('pagamento sem webhook é recuperado pela reconciliação',
      recuperados === 1 && saldoRecuperado === saldoRepetido + 24,
      JSON.stringify({ recuperados, saldoRecuperado, antes: saldoRepetido }));

    // ── Estoque preso em carrinho abandonado volta ──
    const estoqueAntesAbandono = (await chamar('GET', '/api/loja/produtos', { token: tokenA }))
      .dados.find(p => p.id === produto.dados.id).estoque;
    falharProximaPreferencia = false;
    const abandonado = await chamar('POST', `/api/pagamentos/portal/${cli.dados.token_portal}/pedido`, {
      corpo: { itens: [{ produto_id: produto.dados.id, quantidade: 1 }], entrega: 'RETIRADA' },
    });
    const estoqueReservado = (await chamar('GET', '/api/loja/produtos', { token: tokenA }))
      .dados.find(p => p.id === produto.dados.id).estoque;
    verificar('pedido aberto reserva o estoque', estoqueReservado === estoqueAntesAbandono - 1);

    await pool.query(
      `UPDATE pedidos SET criado_em = NOW() - INTERVAL '2 hours' WHERE id = ${abandonado.dados.pedido_id}`
    );
    const expirados = await rotaPagamentos.expirarPedidosAbandonados(60);
    const estoqueDevolvido = (await chamar('GET', '/api/loja/produtos', { token: tokenA }))
      .dados.find(p => p.id === produto.dados.id).estoque;
    verificar('carrinho abandonado devolve o estoque',
      expirados === 1 && estoqueDevolvido === estoqueAntesAbandono,
      JSON.stringify({ expirados, estoqueDevolvido, esperado: estoqueAntesAbandono }));

    // ── Valor divergente não credita ──
    const compraForjada = await chamar('POST', `/api/pagamentos/portal/${cli.dados.token_portal}/comprar`, {
      corpo: { modelo_id: modelo.dados.id },
    });
    const idForjado = `pay-${preferenciasCriadas}`;
    pagamentosSimulados.get(idForjado).transaction_amount = 1.0; // pagou R$ 1
    const saldoAntesForja = (await chamar('GET', `/api/portal/${cli.dados.token_portal}`))
      .dados.pacotes.reduce((s, p) => s + p.saldo, 0);
    await dispararWebhook(1, idForjado);
    const saldoAposForja = (await chamar('GET', `/api/portal/${cli.dados.token_portal}`))
      .dados.pacotes.reduce((s, p) => s + p.saldo, 0);
    const forjado = (await chamar('GET', '/api/empresa/pagamentos', { token: tokenA }))
      .dados.find(p => p.id === compraForjada.dados.pagamento_id);
    verificar('pagar menos que o preço do servidor NÃO credita (fica DIVERGENTE)',
      saldoAposForja === saldoAntesForja && forjado && forjado.status === 'DIVERGENTE',
      JSON.stringify({ antes: saldoAntesForja, depois: saldoAposForja, status: forjado && forjado.status }));

    // ── Pagamento que chega DEPOIS da expiração não some ──
    const pedidoTardio = await chamar('POST', `/api/pagamentos/portal/${cli.dados.token_portal}/pedido`, {
      corpo: { itens: [{ produto_id: produto.dados.id, quantidade: 1 }], entrega: 'RETIRADA' },
    });
    const paymentTardio = `pay-${preferenciasCriadas}`;
    await pool.query(
      `UPDATE pedidos SET criado_em = NOW() - INTERVAL '2 hours' WHERE id = ${pedidoTardio.dados.pedido_id}`
    );
    await rotaPagamentos.expirarPedidosAbandonados(60);
    const estoqueAposExpirar = (await chamar('GET', '/api/loja/produtos', { token: tokenA }))
      .dados.find(p => p.id === produto.dados.id).estoque;

    await dispararWebhook(1, paymentTardio); // cliente paga depois do prazo
    const estoqueAposPagarTarde = (await chamar('GET', '/api/loja/produtos', { token: tokenA }))
      .dados.find(p => p.id === produto.dados.id).estoque;
    const pedidoTardioDepois = (await chamar('GET', '/api/loja/pedidos', { token: tokenA }))
      .dados.find(p => p.id === pedidoTardio.dados.pedido_id);
    const pagamentoTardio = (await chamar('GET', '/api/empresa/pagamentos', { token: tokenA }))
      .dados.find(p => p.id === pedidoTardio.dados.pagamento_id);
    verificar('pagar depois da expiração NÃO aprova em silêncio (fica para conferência)',
      pedidoTardioDepois.status === 'CANCELADO' &&
      pagamentoTardio && pagamentoTardio.status === 'PENDENTE_MANUAL' &&
      !pedidoTardioDepois.agendamento_id &&
      estoqueAposPagarTarde === estoqueAposExpirar,
      JSON.stringify({ pedido: pedidoTardioDepois.status, pagamento: pagamentoTardio && pagamentoTardio.status,
                       ag: pedidoTardioDepois.agendamento_id, estoque: estoqueAposPagarTarde }));

    // ── Editar produto não desfaz reserva feita no meio do caminho ──
    const estoqueBase = (await chamar('GET', '/api/loja/produtos', { token: tokenA }))
      .dados.find(p => p.id === produto.dados.id).estoque;
    const reservaParalela = await chamar('POST', `/api/pagamentos/portal/${cli.dados.token_portal}/pedido`, {
      corpo: { itens: [{ produto_id: produto.dados.id, quantidade: 1 }], entrega: 'RETIRADA' },
    });
    // O admin tinha a tela aberta com o estoque ANTIGO e salva sem mexer nele.
    await chamar('PUT', `/api/loja/produtos/${produto.dados.id}`, { token: tokenA, corpo: {
      nome: 'Ração Premium 10kg', preco_centavos: 25000,
      estoque: estoqueBase, estoque_visto: estoqueBase, controla_estoque: true,
    }});
    const estoqueAposEdicao = (await chamar('GET', '/api/loja/produtos', { token: tokenA }))
      .dados.find(p => p.id === produto.dados.id).estoque;
    verificar('editar produto não desfaz a reserva de quem comprou no meio',
      estoqueAposEdicao === estoqueBase - 1,
      JSON.stringify({ base: estoqueBase, apos: estoqueAposEdicao }));

    // ── Transição de status inválida é recusada ──
    const voltarStatus = await chamar('PUT', `/api/loja/pedidos/${reservaParalela.dados.pedido_id}`, {
      token: tokenA, corpo: { status: 'ENTREGUE' },
    });
    verificar('pedido não pago não pode ir para ENTREGUE (409)', voltarStatus.status === 409,
      JSON.stringify(voltarStatus.dados));

    // ── Cliente não segura a loja com pedidos que nunca paga ──
    let bloqueou = false;
    for (let i = 0; i < 4 && !bloqueou; i++) {
      const tentativa = await chamar('POST', `/api/pagamentos/portal/${cli.dados.token_portal}/pedido`, {
        corpo: { itens: [{ produto_id: produto.dados.id, quantidade: 1 }], entrega: 'RETIRADA' },
      });
      if (tentativa.status === 409) bloqueou = true;
    }
    verificar('cliente com pedidos abertos demais é barrado', bloqueou);

    // ── Webhook de outra empresa não toca o pagamento ──
    const saldoAntesCruzado = saldoAposForja;
    const compraB = await chamar('POST', `/api/pagamentos/portal/${cli.dados.token_portal}/comprar`, {
      corpo: { modelo_id: modelo.dados.id },
    });
    await dispararWebhook(2, `pay-${preferenciasCriadas}`); // empresa B (sem segredo) → 503
    const saldoAposCruzado = (await chamar('GET', `/api/portal/${cli.dados.token_portal}`))
      .dados.pacotes.reduce((s, p) => s + p.saldo, 0);
    verificar('webhook de outra empresa não credita o pagamento',
      saldoAposCruzado === saldoAntesCruzado && compraB.status === 201);
  }

  console.log('\n— Foto de produto e logo do petshop —');
  {
    const pixelGrande = 'data:image/png;base64,' + 'A'.repeat(720 * 1024);
    const fotoRuim = await chamar('PUT', `/api/loja/produtos/${produto.dados.id}`, { token: tokenA, corpo: {
      nome: 'Ração Premium 10kg', preco_centavos: 25000, estoque: 3, foto: 'javascript:alert(1)',
    }});
    verificar('foto de produto que não é imagem é recusada', fotoRuim.status === 400);

    const fotoGrande = await chamar('PUT', `/api/loja/produtos/${produto.dados.id}`, { token: tokenA, corpo: {
      nome: 'Ração Premium 10kg', preco_centavos: 25000, estoque: 3, foto: pixelGrande,
    }});
    verificar('foto de produto acima do limite dá 413', fotoGrande.status === 413);

    const comFoto = await chamar('PUT', `/api/loja/produtos/${produto.dados.id}`, { token: tokenA, corpo: {
      nome: 'Ração Premium 10kg', preco_centavos: 25000, estoque: 3, foto: pixel,
    }});
    verificar('produto aceita foto e devolve só a marca (sem base64)',
      comFoto.status === 200 && comFoto.dados.tem_foto === true &&
      !!comFoto.dados.foto_versao && comFoto.dados.foto === undefined,
      JSON.stringify(comFoto.dados));

    // A imagem vem por rota própria, binária e cacheável.
    const rotaFoto = await fetch(`${base}/api/loja/produtos/${produto.dados.id}/foto`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    const etag = rotaFoto.headers.get('etag');
    verificar('rota serve a foto como imagem binária com ETag',
      rotaFoto.status === 200 && (rotaFoto.headers.get('content-type') || '').startsWith('image/') && !!etag);

    const rotaCache = await fetch(`${base}/api/loja/produtos/${produto.dados.id}/foto`, {
      headers: { Authorization: `Bearer ${tokenA}`, 'If-None-Match': etag },
    });
    verificar('navegador com a foto em cache recebe 304', rotaCache.status === 304);

    const semMexer = await chamar('PUT', `/api/loja/produtos/${produto.dados.id}`, { token: tokenA, corpo: {
      nome: 'Ração Premium 10kg', preco_centavos: 25000, estoque: 3,
    }});
    verificar('salvar sem mandar foto preserva a foto atual', semMexer.dados.tem_foto === true);

    const vitrine = await chamar('GET', `/api/portal/${cli.dados.token_portal}`);
    const prod = vitrine.dados.produtos.find(x => x.id === produto.dados.id);
    verificar('vitrine do cliente NÃO carrega base64 (só a marca)',
      prod && prod.tem_foto === true && prod.foto === undefined &&
      !JSON.stringify(vitrine.dados).includes('base64'),
      JSON.stringify(prod));

    const fotoCliente = await fetch(`${base}/api/portal/${cli.dados.token_portal}/produtos/${produto.dados.id}/foto`);
    verificar('cliente busca a foto pela rota do portal',
      fotoCliente.status === 200 && (fotoCliente.headers.get('content-type') || '').startsWith('image/'));

    const fotoAlheia = await fetch(`${base}/api/portal/${cliB.dados.token_portal}/produtos/${produto.dados.id}/foto`);
    verificar('cliente de outro petshop não busca a foto', fotoAlheia.status === 404 || fotoAlheia.status === 503);

    const tirouFoto = await chamar('PUT', `/api/loja/produtos/${produto.dados.id}`, { token: tokenA, corpo: {
      nome: 'Ração Premium 10kg', preco_centavos: 25000, estoque: 3, foto: null,
    }});
    verificar('mandar foto nula remove a foto', tirouFoto.dados.tem_foto === false);

    const logoRuim = await chamar('PUT', '/api/empresa', { token: tokenA, corpo: {
      nome: 'Salva Patas', logo: 'nao-e-imagem',
    }});
    verificar('logo inválida é recusada', logoRuim.status === 400);

    await chamar('PUT', '/api/empresa', { token: tokenA, corpo: { nome: 'Salva Patas', logo: pixel } });
    const empComLogo = await chamar('GET', '/api/empresa', { token: tokenA });
    const portalComLogo = await chamar('GET', `/api/portal/${cli.dados.token_portal}`);
    const meComLogo = await chamar('GET', '/api/auth/me', { token: tokenA });
    verificar('logo aparece como marca no painel, no /me e no app do cliente',
      empComLogo.dados.tem_logo === true && meComLogo.dados.empresa.tem_logo === true &&
      portalComLogo.dados.petshop.tem_logo === true,
      JSON.stringify({ emp: empComLogo.dados.tem_logo, me: meComLogo.dados.empresa.tem_logo,
                       portal: portalComLogo.dados.petshop.tem_logo }));

    verificar('a logo NÃO viaja em toda requisição autenticada',
      !JSON.stringify(meComLogo.dados).includes('base64') &&
      !JSON.stringify(portalComLogo.dados.petshop).includes('base64'));

    const rotaLogo = await fetch(`${base}/api/empresa/logo`, { headers: { Authorization: `Bearer ${tokenA}` } });
    const rotaLogoCliente = await fetch(`${base}/api/portal/${cli.dados.token_portal}/logo`);
    verificar('logo servida por rota própria nos dois apps',
      rotaLogo.status === 200 && rotaLogoCliente.status === 200 &&
      (rotaLogoCliente.headers.get('content-type') || '').startsWith('image/'));

    await chamar('PUT', '/api/empresa', { token: tokenA, corpo: { nome: 'Salva Patas' } });
    const aindaTemLogo = await chamar('GET', '/api/empresa', { token: tokenA });
    verificar('salvar sem mandar logo preserva a logo', aindaTemLogo.dados.tem_logo === true);
  }

  console.log('\n— Assinatura do petshop (cobrança da SaferSoftware) —');
  {
    const situacao = await chamar('GET', '/api/assinatura', { token: tokenA });
    verificar('tela de assinatura traz planos e dias restantes',
      situacao.status === 200 && situacao.dados.planos.length === 2 &&
      Number.isInteger(situacao.dados.dias_restantes) && situacao.dados.vigente === true,
      JSON.stringify({ planos: situacao.dados.planos && situacao.dados.planos.length, dias: situacao.dados.dias_restantes }));

    const negadaAtendente = await chamar('GET', '/api/assinatura', { token: tokenAt });
    verificar('atendente não vê a assinatura (403)', negadaAtendente.status === 403);

    const webhookFechado = await fetch(`${base}/api/assinatura/webhook`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'payment', data: { id: '1' } }),
    });
    verificar('webhook da assinatura sem segredo global responde 503', webhookFechado.status === 503);

    const cobrancaIndisponivel = await chamar('POST', '/api/assinatura/pagar', { token: tokenA, corpo: { periodo: 'MENSAL' } });
    verificar('sem credencial global, a renovação avisa em vez de quebrar',
      cobrancaIndisponivel.status === 503, JSON.stringify(cobrancaIndisponivel.dados));

    const planos = require(path.join(raiz, 'backend', 'config', 'planos.js'));
    verificar('tabela de preços do servidor tem mensal e anual',
      planos.planoDe('MENSAL').dias === 30 && planos.planoDe('ANUAL').dias === 365 &&
      planos.planoDe('inexistente') === null);

    // Reconciliação não pode travar na cabeça da fila com PENDENTE morto.
    const rotaAssinatura = require(path.join(raiz, 'backend', 'rotas', 'assinatura.js'));
    await pool.query(`INSERT INTO assinaturas (empresa_id, plano, periodo, valor_centavos, status, mp_preference_id, criado_em)
      VALUES (1, 'PRO', 'MENSAL', 14900, 'PENDENTE', 'pref-morta', NOW() - INTERVAL '48 hours')`);
    await rotaAssinatura.reconciliarAssinaturas(10);
    const mortas = await pool.query(`SELECT status FROM assinaturas WHERE mp_preference_id = 'pref-morta'`);
    verificar('cobrança sem pagamento em 24h expira e libera a fila',
      mortas.rows[0] && mortas.rows[0].status === 'EXPIRADA',
      JSON.stringify(mortas.rows[0]));
  }

  console.log('\n— Hub, saúde e limites —');
  const hub = await chamar('GET', '/api/hub/metrics', { token: 'hub-de-teste' });
  verificar('hub com token certo traz métricas no contrato do Safer Hub',
    hub.status === 200 && hub.dados.produto === 'SaferPet' &&
    hub.dados.kpis && Number.isInteger(hub.dados.kpis.total) &&
    typeof hub.dados.kpis.mrr === 'number' &&
    Array.isArray(hub.dados.usuarios) && hub.dados.usuarios.length >= 2,
    JSON.stringify(hub.dados.kpis));

  const hubHeader = await fetch(`${base}/api/hub/metrics`, { headers: { 'x-hub-secret': 'hub-de-teste' } });
  verificar('hub aceita o header x-hub-secret que o painel manda', hubHeader.status === 200);

  const hubHeaderErrado = await fetch(`${base}/api/hub/metrics`, { headers: { 'x-hub-secret': 'errado' } });
  verificar('x-hub-secret errado dá 401', hubHeaderErrado.status === 401);

  verificar('hub separa trial de pagante e traz a operação',
    hub.dados.kpis.emTrial >= 1 && hub.dados.kpis.ativos === 0 &&
    hub.dados.operacao && Number.isInteger(hub.dados.operacao.clientes),
    JSON.stringify({ trial: hub.dados.kpis.emTrial, ativos: hub.dados.kpis.ativos, op: hub.dados.operacao }));

  verificar('hub nunca devolve dado de cliente final',
    !JSON.stringify(hub.dados).includes('Mariana') && !JSON.stringify(hub.dados).includes('token_portal'));
  const saude = await chamar('GET', '/api/health');
  verificar('healthcheck toca o banco', saude.status === 200 && saude.dados.status === 'ok');

  let viu429Login = false;
  let viu401Login = false;
  for (let i = 0; i < 12 && !viu429Login; i++) {
    const tentativa = await chamar('POST', '/api/auth/login', { corpo: { email: 'a@teste.com', senha: 'errada-999' } });
    if (tentativa.status === 401) viu401Login = true;
    if (tentativa.status === 429) viu429Login = true;
  }
  verificar('força bruta no login bate no limite (429)', viu401Login && viu429Login);

  let viu429Registro = false;
  for (let i = 0; i < 6 && !viu429Registro; i++) {
    const tentativa = await chamar('POST', '/api/auth/registrar', { corpo: {
      empresa_nome: `Spam ${i}`, nome: 'Robô', email: `spam-${i}@teste.com`, senha: 'senha-forte-9',
    }});
    if (tentativa.status === 429) viu429Registro = true;
  }
  verificar('criação de conta em massa bate no limite (429)', viu429Registro);
} catch (err) {
  falhas += 1;
  console.error('\nERRO INESPERADO na bateria:', err);
} finally {
  servidor.close();
}

console.log(`\n${total - falhas}/${total} verificações passaram.`);
process.exit(falhas ? 1 : 0);
