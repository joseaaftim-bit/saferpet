// Bateria local do SaferPet contra um Postgres em memória (pg-mem).
// Roda sem banco instalado: npm run teste:local
// Cobre a função principal (saldo de pacote), isolamento entre petshops,
// permissões e o portal do cliente.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'segredo-de-teste';
process.env.HUB_TOKEN = 'hub-de-teste';
process.env.APP_URL = 'http://localhost:4600';

import { createRequire } from 'module';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { newDb } from 'pg-mem';

const require = createRequire(import.meta.url);
const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ─── Banco em memória ────────────────────────────────────────────────
const db = newDb();

// pg-mem não implementa FOR UPDATE: reescreve a consulta sem o sufixo.
db.public.interceptQueries((sql) => {
  const m = /^([\s\S]*?)\s+FOR\s+UPDATE(\s+OF\s+[\w,\s]+)?\s*;?\s*$/i.exec(sql);
  if (m) return db.public.query(m[1]).rows;
  return null;
});

const { Pool } = db.adapters.createPg();
const pool = new Pool();

const database = require(path.join(raiz, 'backend', 'database.js'));
database.injetarPoolParaTestes(pool);

// Schema direto (sem CREATE INDEX, que o pg-mem não garante).
const esquema = readFileSync(path.join(raiz, 'migrations', '001-esquema.sql'), 'utf-8')
  .split('\n')
  .filter(linha => !/^\s*CREATE INDEX/i.test(linha))
  .join('\n');
await pool.query(esquema);

const { app } = require(path.join(raiz, 'backend', 'server.js'));
const servidor = app.listen(0);
const base = `http://127.0.0.1:${servidor.address().port}`;

// ─── Ferramentas ─────────────────────────────────────────────────────
let total = 0;
let falhas = 0;

function verificar(nome, condicao, detalhe) {
  total += 1;
  if (condicao) {
    console.log(`  ok  ${nome}`);
  } else {
    falhas += 1;
    console.error(`FALHA ${nome}${detalhe ? ` — ${detalhe}` : ''}`);
  }
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

// ─── Bateria ─────────────────────────────────────────────────────────
try {
  console.log('\n— Cadastro e autenticação —');
  const regA = await chamar('POST', '/api/auth/registrar', { corpo: {
    empresa_nome: 'Salva Patas', whatsapp: '67999990000',
    nome: 'Dona A', email: 'a@teste.com', senha: 'senha-forte-1',
  }});
  verificar('registrar petshop A', regA.status === 201 && !!regA.dados.token, JSON.stringify(regA.dados));
  const tokenA = regA.dados.token;

  const loginErrado = await chamar('POST', '/api/auth/login', { corpo: { email: 'a@teste.com', senha: 'errada-123' } });
  verificar('login com senha errada dá 401', loginErrado.status === 401);

  const semToken = await chamar('GET', '/api/clientes');
  verificar('rota de negócio sem token dá 401', semToken.status === 401);

  const me = await chamar('GET', '/api/auth/me', { token: tokenA });
  verificar('/me traz empresa e acesso vigente', me.status === 200 && me.dados.empresa.acesso_vigente === true);

  console.log('\n— Função principal: pacote e saldo —');
  const cli = await chamar('POST', '/api/clientes', { token: tokenA, corpo: {
    nome: 'Mariana Souza', telefone: '67988887777',
  }});
  verificar('criar cliente', cli.status === 201 && !!cli.dados.token_portal);
  const clienteId = cli.dados.id;

  const mel = await chamar('POST', '/api/pets', { token: tokenA, corpo: { cliente_id: clienteId, nome: 'Mel', raca: 'Shih-tzu' } });
  const luna = await chamar('POST', '/api/pets', { token: tokenA, corpo: { cliente_id: clienteId, nome: 'Luna', raca: 'Shih-tzu' } });
  verificar('criar pets', mel.status === 201 && luna.status === 201);

  const modelo = await chamar('POST', '/api/pacotes/modelos', { token: tokenA, corpo: {
    nome: 'Pacote 24 banhos', qtd_banhos: 24, valor_centavos: 70000, validade_meses: 12,
  }});
  verificar('criar modelo no catálogo', modelo.status === 201);

  const venda = await chamar('POST', '/api/pacotes', { token: tokenA, corpo: {
    cliente_id: clienteId, modelo_id: modelo.dados.id,
    // Tentativa de forjar valor/quantidade por fora — o servidor deve ignorar:
    qtd_banhos: 999, valor_centavos: 1,
  }});
  verificar('vender pacote pelo catálogo', venda.status === 201 && venda.dados.saldo === 24);
  verificar('valor e quantidade saem do catálogo, não do corpo',
    venda.dados.qtd_banhos === 24 && venda.dados.valor_centavos === 70000,
    JSON.stringify(venda.dados));
  const pacoteId = venda.dados.id;

  const baixa2 = await chamar('POST', '/api/baixas', { token: tokenA, corpo: {
    pacote_id: pacoteId,
    itens: [{ pet_id: mel.dados.id }, { pet_id: luna.dados.id, servico: 'Banho + hidratação' }],
  }});
  verificar('baixa dupla desconta 2 (24 → 22)', baixa2.status === 201 && baixa2.dados.saldo === 22, JSON.stringify(baixa2.dados));
  verificar('cada baixa registra o saldo_apos correto',
    baixa2.dados.baixas.length === 2 &&
    baixa2.dados.baixas[0].saldo_apos === 23 && baixa2.dados.baixas[1].saldo_apos === 22);

  console.log('\n— Estorno —');
  const idBaixaLuna = baixa2.dados.baixas[1].id;
  const estorno = await chamar('POST', `/api/baixas/${idBaixaLuna}/estornar`, { token: tokenA });
  verificar('estorno devolve 1 ao saldo (22 → 23)', estorno.status === 200 && estorno.dados.saldo === 23, JSON.stringify(estorno.dados));

  const estornoDuplo = await chamar('POST', `/api/baixas/${idBaixaLuna}/estornar`, { token: tokenA });
  verificar('estornar duas vezes dá 409', estornoDuplo.status === 409);

  console.log('\n— Esgotamento, transbordo FIFO e validade (cliente Carlos) —');
  const carlos = await chamar('POST', '/api/clientes', { token: tokenA, corpo: { nome: 'Carlos Henrique' } });
  const carlosId = carlos.dados.id;

  const velho = await chamar('POST', '/api/pacotes', { token: tokenA, corpo: {
    cliente_id: carlosId, nome: 'Banho avulso pré-pago', qtd_banhos: 1, valor_centavos: 5000,
  }});
  verificar('vender pacote avulso de 1 banho', velho.status === 201 && velho.dados.saldo === 1);

  const insuficiente = await chamar('POST', '/api/baixas', { token: tokenA, corpo: {
    pacote_id: velho.dados.id, itens: [{}, {}],
  }});
  verificar('saldo insuficiente dá 409 e não desconta', insuficiente.status === 409);

  const esgota = await chamar('POST', '/api/baixas', { token: tokenA, corpo: {
    pacote_id: velho.dados.id, itens: [{}],
  }});
  verificar('última baixa esgota o pacote', esgota.status === 201 && esgota.dados.saldo === 0 && esgota.dados.status === 'ESGOTADO');

  const baixaEsgotado = await chamar('POST', '/api/baixas', { token: tokenA, corpo: {
    pacote_id: velho.dados.id, itens: [{}],
  }});
  verificar('baixa em pacote esgotado dá 409', baixaEsgotado.status === 409);

  const estornoEsgotado = await chamar('POST', `/api/baixas/${esgota.dados.baixas[0].id}/estornar`, { token: tokenA });
  verificar('estorno reativa pacote esgotado', estornoEsgotado.status === 200 && estornoEsgotado.dados.status === 'ATIVO');

  const novo = await chamar('POST', '/api/pacotes', { token: tokenA, corpo: {
    cliente_id: carlosId, nome: 'Pacote 12 banhos', qtd_banhos: 12, valor_centavos: 40000,
  }});
  const transbordo = await chamar('POST', '/api/baixas', { token: tokenA, corpo: {
    pacote_id: velho.dados.id, itens: [{}, {}],
  }});
  verificar('transbordo FIFO: 1 do velho + 1 do novo, saldo total 11',
    transbordo.status === 201 && transbordo.dados.saldo === 11 &&
    transbordo.dados.baixas[0].pacote_id === velho.dados.id &&
    transbordo.dados.baixas[1].pacote_id === novo.dados.id &&
    transbordo.dados.baixas[1].saldo_apos === 11,
    JSON.stringify(transbordo.dados));

  await pool.query(`UPDATE pacotes SET validade_ate = '2020-01-01' WHERE id = ${novo.dados.id}`);
  const baixaVencido = await chamar('POST', '/api/baixas', { token: tokenA, corpo: {
    pacote_id: novo.dados.id, itens: [{}],
  }});
  verificar('baixa em pacote com validade estourada dá 409 mesmo antes do cron',
    baixaVencido.status === 409 && /vencido/i.test(baixaVencido.dados.erro || ''),
    JSON.stringify(baixaVencido.dados));

  await pool.query(`UPDATE pacotes SET status = 'VENCIDO' WHERE id = ${novo.dados.id}`);
  const reativarSemData = await chamar('PUT', `/api/pacotes/${novo.dados.id}`, { token: tokenA, corpo: { status: 'ATIVO' } });
  verificar('reativar pacote vencido sem nova validade dá 409', reativarSemData.status === 409);

  const reativar = await chamar('PUT', `/api/pacotes/${novo.dados.id}`, { token: tokenA, corpo: {
    status: 'ATIVO', validade_ate: '2030-01-01',
  }});
  verificar('reativar com validade futura volta a ATIVO', reativar.status === 200 && reativar.dados.status === 'ATIVO');

  const baixaPosReativacao = await chamar('POST', '/api/baixas', { token: tokenA, corpo: {
    pacote_id: novo.dados.id, itens: [{}],
  }});
  verificar('baixa funciona após reativação (11 → 10)', baixaPosReativacao.status === 201 && baixaPosReativacao.dados.saldo === 10);

  console.log('\n— Listagens —');
  const lista = await chamar('GET', '/api/clientes', { token: tokenA });
  const linMariana = lista.dados.find(c => c.nome === 'Mariana Souza') || {};
  verificar('lista mostra saldo, saldo_total e pets', lista.status === 200 && lista.dados.length === 2 &&
    linMariana.saldo === 23 && linMariana.saldo_total === 23 && linMariana.pets === 'Luna e Mel',
    JSON.stringify(linMariana));

  const busca = await chamar('GET', '/api/clientes?busca=luna', { token: tokenA });
  verificar('busca por nome de pet encontra o cliente', busca.dados.length === 1);

  const ficha = await chamar('GET', `/api/clientes/${clienteId}`, { token: tokenA });
  verificar('ficha traz pacotes e histórico', ficha.status === 200 &&
    ficha.dados.pacotes.length === 1 && ficha.dados.baixas.length === 2);

  // Não-estornadas de hoje: Mel (1) + transbordo do Carlos (2) + pós-reativação (1).
  const painel = await chamar('GET', '/api/dashboard', { token: tokenA });
  verificar('painel: banhos de hoje contam só não-estornadas (4)', painel.dados.banhos_hoje === 4, JSON.stringify(painel.dados));
  verificar('painel: 2 pacotes ativos e nenhum acabando', painel.dados.pacotes_ativos === 2 && painel.dados.saldos_acabando === 0);

  console.log('\n— Portal do cliente —');
  const portal = await chamar('GET', `/api/portal/${cli.dados.token_portal}`);
  verificar('portal abre sem login e mostra o saldo', portal.status === 200 &&
    portal.dados.pacotes[0].saldo === 23 && portal.dados.petshop.nome === 'Salva Patas');
  verificar('portal não vaza baixas estornadas',
    portal.dados.ultimas_baixas.every(b => b.saldo_apos !== undefined) &&
    portal.dados.ultimas_baixas.length === 1);

  const portalErrado = await chamar('GET', '/api/portal/token-que-nao-existe-1234567');
  verificar('token errado dá 404', portalErrado.status === 404);

  console.log('\n— Isolamento entre petshops —');
  const regB = await chamar('POST', '/api/auth/registrar', { corpo: {
    empresa_nome: 'Outro Pet', nome: 'Dono B', email: 'b@teste.com', senha: 'senha-forte-2',
  }});
  const tokenB = regB.dados.token;
  const cliB = await chamar('POST', '/api/clientes', { token: tokenB, corpo: { nome: 'Cliente do B' } });

  const listaB = await chamar('GET', '/api/clientes', { token: tokenB });
  verificar('B só vê os próprios clientes', listaB.dados.length === 1 && listaB.dados[0].nome === 'Cliente do B');

  const fichaCruzada = await chamar('GET', `/api/clientes/${clienteId}`, { token: tokenB });
  verificar('B não abre ficha de cliente do A', fichaCruzada.status === 404);

  const baixaCruzada = await chamar('POST', '/api/baixas', { token: tokenB, corpo: { pacote_id: pacoteId, itens: [{}] } });
  verificar('B não dá baixa em pacote do A', baixaCruzada.status === 404);

  const editarCruzado = await chamar('PUT', `/api/clientes/${clienteId}`, { token: tokenB, corpo: { nome: 'Invasão' } });
  verificar('B não edita cliente do A', editarCruzado.status === 404);

  const estornoCruzado = await chamar('POST', `/api/baixas/${idBaixaLuna}/estornar`, { token: tokenB });
  verificar('B não estorna baixa do A', estornoCruzado.status === 404);

  console.log('\n— Permissões —');
  const novoAtendente = await chamar('POST', '/api/empresa/usuarios', { token: tokenA, corpo: {
    nome: 'Atendente', email: 'atendente@teste.com', senha: 'senha-forte-3',
  }});
  verificar('admin cria atendente', novoAtendente.status === 201 && novoAtendente.dados.permissoes === 'ATENDENTE');

  const loginAt = await chamar('POST', '/api/auth/login', { corpo: { email: 'atendente@teste.com', senha: 'senha-forte-3' } });
  const tokenAt = loginAt.dados.token;

  const modeloNegado = await chamar('POST', '/api/pacotes/modelos', { token: tokenAt, corpo: {
    nome: 'Golpe', qtd_banhos: 1, valor_centavos: 0,
  }});
  verificar('atendente não mexe no catálogo (403)', modeloNegado.status === 403);

  const configNegada = await chamar('GET', '/api/empresa', { token: tokenAt });
  verificar('atendente não vê configurações (403)', configNegada.status === 403);

  const baixaAt = await chamar('POST', '/api/baixas', { token: tokenAt, corpo: {
    pacote_id: pacoteId, itens: [{ pet_id: mel.dados.id }],
  }});
  verificar('atendente dá baixa normalmente', baixaAt.status === 201 && baixaAt.dados.saldo === 22);

  const estornoAt = await chamar('POST', `/api/baixas/${baixaAt.dados.baixas[0].id}/estornar`, { token: tokenAt });
  verificar('atendente estorna baixa do mesmo dia', estornoAt.status === 200 && estornoAt.dados.saldo === 23);

  console.log('\n— Enforcement de acesso (acesso_ate manda, não o token) —');
  await pool.query(`UPDATE empresas SET acesso_ate = '2020-01-01T00:00:00Z' WHERE nome = 'Outro Pet'`);
  const bloqueado = await chamar('GET', '/api/clientes', { token: tokenB });
  verificar('acesso vencido dá 402 mesmo com token válido', bloqueado.status === 402);

  const meVencido = await chamar('GET', '/api/auth/me', { token: tokenB });
  verificar('/me continua acessível para mostrar o aviso', meVencido.status === 200 && meVencido.dados.empresa.acesso_vigente === false);

  const portalB = await chamar('GET', `/api/portal/${cliB.dados.token_portal}`);
  verificar('portal do petshop vencido sai do ar (503)', portalB.status === 503);

  console.log('\n— Hub e saúde —');
  const hubSemToken = await chamar('GET', '/api/hub/metrics');
  verificar('hub sem token dá 401', hubSemToken.status === 401);
  const hubErrado = await chamar('GET', '/api/hub/metrics', { token: 'token-errado' });
  verificar('hub com token errado dá 401', hubErrado.status === 401);
  const hub = await chamar('GET', '/api/hub/metrics', { token: 'hub-de-teste' });
  verificar('hub com token certo traz métricas', hub.status === 200 && hub.dados.empresas === 2);

  const saude = await chamar('GET', '/api/health');
  verificar('healthcheck toca o banco', saude.status === 200 && saude.dados.status === 'ok');

  console.log('\n— Limites de tentativa (rodar por último: polui os contadores) —');
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
