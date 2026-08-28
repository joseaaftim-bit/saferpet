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

const { app } = require(path.join(raiz, 'backend', 'server.js'));
const motor = require(path.join(raiz, 'backend', 'util', 'agenda.js'));
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

  console.log('\n— Hub, saúde e limites —');
  const hub = await chamar('GET', '/api/hub/metrics', { token: 'hub-de-teste' });
  verificar('hub com token certo traz métricas', hub.status === 200 && hub.dados.empresas >= 2);
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
