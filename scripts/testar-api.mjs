// Fumaça contra um ambiente publicado (Railway):
//   node scripts/testar-api.mjs https://pet.safersoftware.com.br
// Só toca rotas sem efeito colateral + um ciclo completo de cadastro de
// teste que fica marcado com "(TESTE)" no nome para limpeza manual.

const base = (process.argv[2] || 'http://localhost:4600').replace(/\/+$/, '');
const executarCicloCompleto = process.argv.includes('--completo');

let falhas = 0;
function verificar(nome, cond, detalhe) {
  if (cond) console.log(`  ok  ${nome}`);
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

console.log(`Testando ${base}\n`);

const saude = await chamar('GET', '/api/health');
verificar('healthcheck responde ok', saude.status === 200 && saude.dados.status === 'ok', JSON.stringify(saude.dados));

const semToken = await chamar('GET', '/api/clientes');
verificar('rota de negócio sem token dá 401', semToken.status === 401);

const hubAberto = await chamar('GET', '/api/hub/metrics');
verificar('hub fechado sem credencial (401 ou 503)', hubAberto.status === 401 || hubAberto.status === 503);

const portal404 = await chamar('GET', '/api/portal/token-invalido-1234567890');
verificar('portal com token inválido dá 404', portal404.status === 404);

if (executarCicloCompleto) {
  // Ciclo completo contra o banco REAL. Existe porque o pg-mem da bateria
  // local não valida FOR UPDATE nem o planner do Postgres: os caminhos de
  // concluir agendamento e estornar baixa SÓ quebram aqui.
  console.log('\n— Ciclo completo da Fase 1 com petshop de teste —');
  const sufixo = Date.now();
  const reg = await chamar('POST', '/api/auth/registrar', { corpo: {
    empresa_nome: `Petshop (TESTE) ${sufixo}`, nome: 'Robô de teste',
    email: `teste-${sufixo}@safersoftware.com.br`, senha: `Teste-${sufixo}!`,
  }});
  verificar('registrar petshop de teste', reg.status === 201, JSON.stringify(reg.dados));
  const token = reg.dados.token;

  const servicos = await chamar('GET', '/api/servicos', { token });
  verificar('empresa nova nasce com o serviço Banho',
    servicos.status === 200 && servicos.dados.length === 1, JSON.stringify(servicos.dados));
  const banhoId = servicos.dados[0].id;

  const config = await chamar('GET', '/api/agenda/config', { token });
  verificar('empresa nova nasce com horários e recurso de atendimento',
    config.dados.horarios.length === 6 && config.dados.recursos.length === 1);

  const tosa = await chamar('POST', '/api/servicos', { token, corpo: {
    nome: 'Banho e tosa (TESTE)', duracao_minutos: 45, preco_centavos: 8000,
  }});
  verificar('criar serviço com duração própria', tosa.status === 201);

  const cli = await chamar('POST', '/api/clientes', { token, corpo: { nome: 'Cliente (TESTE)' } });
  const pet = await chamar('POST', '/api/pets', { token, corpo: { cliente_id: cli.dados.id, nome: 'Pet (TESTE)' } });
  const pacote = await chamar('POST', '/api/pacotes', { token, corpo: {
    cliente_id: cli.dados.id, nome: 'Pacote (TESTE)', valor_centavos: 100,
    itens: [{ servico_id: banhoId, quantidade: 2 }, { servico_id: tosa.dados.id, quantidade: 2 }],
  }});
  verificar('vender pacote com créditos de dois serviços',
    pacote.status === 201 && pacote.dados.saldo === 4 && pacote.dados.itens.length === 2);

  // Agenda: dia útil daqui a 3 dias (evita domingo/exceção).
  const alvo = new Date(Date.now() + 3 * 86400000);
  const data = alvo.toISOString().slice(0, 10);
  const livres = await chamar('GET', `/api/agenda/horarios-livres?data=${data}&servico_id=${tosa.dados.id}`, { token });
  verificar('horários livres calculados no banco real',
    livres.status === 200 && Array.isArray(livres.dados.horarios), JSON.stringify(livres.dados).slice(0, 200));

  if (livres.dados.horarios && livres.dados.horarios.length) {
    const inicio = livres.dados.horarios[0];
    const ag = await chamar('POST', '/api/agenda/agendamentos', { token, corpo: {
      cliente_id: cli.dados.id, pet_id: pet.dados.id, servico_id: tosa.dados.id, data, inicio,
    }});
    verificar('criar agendamento (transação com trava de empresa)',
      ag.status === 201 && ag.dados.agendamento.fim > inicio, JSON.stringify(ag.dados).slice(0, 200));

    const livresDepois = await chamar('GET', `/api/agenda/horarios-livres?data=${data}&servico_id=${tosa.dados.id}`, { token });
    verificar('o horário agendado sai da grade',
      !livresDepois.dados.horarios.includes(inicio));

    // ESTE é o teste que o pg-mem não faz: FOR UPDATE OF em LEFT JOIN.
    const concluir = await chamar('PUT', `/api/agenda/agendamentos/${ag.dados.agendamento.id}`, { token, corpo: { acao: 'CONCLUIR' } });
    verificar('CONCLUIR agendamento funciona no Postgres real (FOR UPDATE OF a)',
      concluir.status === 200 && concluir.dados.baixa, JSON.stringify(concluir.dados).slice(0, 200));

    if (concluir.dados && concluir.dados.baixa) {
      const estornoAg = await chamar('POST', `/api/baixas/${concluir.dados.baixa.id}/estornar`, { token });
      verificar('ESTORNAR baixa funciona no Postgres real (FOR UPDATE OF b, p)',
        estornoAg.status === 200 && estornoAg.dados.saldo === 4, JSON.stringify(estornoAg.dados).slice(0, 200));
    }
  } else {
    console.log('  (dia sem horário livre — pulei os testes de agendamento)');
  }

  const baixa = await chamar('POST', '/api/baixas', { token, corpo: {
    cliente_id: cli.dados.id, itens: [{ servico_id: banhoId, pet_id: pet.dados.id }],
  }});
  verificar('baixa manual por serviço desconta crédito (4 → 3)',
    baixa.status === 201 && baixa.dados.saldo === 3, JSON.stringify(baixa.dados).slice(0, 200));

  const estorno = await chamar('POST', `/api/baixas/${baixa.dados.baixas[0].id}/estornar`, { token });
  verificar('estorno da baixa manual devolve o crédito (3 → 4)',
    estorno.status === 200 && estorno.dados.saldo === 4);

  const portal = await chamar('GET', `/api/portal/${cli.dados.token_portal}`);
  verificar('portal do cliente mostra créditos por serviço',
    portal.status === 200 && portal.dados.pacotes[0].itens.length === 2);
  verificar('agendamento online nasce desligado (sem o petshop pedir)',
    portal.dados.petshop.aceita_online === false &&
    portal.dados.petshop.pagamento_disponivel === false);

  console.log('\n— Fases 3 e 4 no banco real —');
  const produto = await chamar('POST', '/api/loja/produtos', { token, corpo: {
    nome: 'Ração (TESTE)', preco_centavos: 25000, estoque: 3,
  }});
  verificar('cadastrar produto na loja', produto.status === 201 && produto.dados.estoque === 3);

  const pedidos = await chamar('GET', '/api/loja/pedidos', { token });
  verificar('painel de pedidos responde', pedidos.status === 200 && Array.isArray(pedidos.dados));

  const semMP = await chamar('POST', `/api/pagamentos/portal/${cli.dados.token_portal}/pedido`, { corpo: {
    itens: [{ produto_id: produto.dados.id, quantidade: 1 }],
  }});
  verificar('sem credencial do Mercado Pago, o pedido é recusado (503)', semMP.status === 503,
    JSON.stringify(semMP.dados));

  const pixel = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const foto = await chamar('POST', '/api/extras/fotos', { token, corpo: {
    cliente_id: cli.dados.id, pet_id: pet.dados.id, conteudo: pixel, legenda: 'teste',
  }});
  verificar('publicar foto do pet', foto.status === 201);

  const vacina = await chamar('POST', '/api/extras/vacinas', { token, corpo: {
    pet_id: pet.dados.id, nome: 'V10 (TESTE)', reforco_meses: 2,
  }});
  verificar('registrar vacina com reforço', vacina.status === 201 && !!vacina.dados.reforco_em);

  const reforcos = await chamar('GET', '/api/extras/vacinas/reforcos?dias=90', { token });
  verificar('lista de reforços a vencer', reforcos.status === 200 && reforcos.dados.length === 1);

  const relatorios = await chamar('GET', '/api/extras/relatorios?dias=30', { token });
  verificar('relatórios do dono no banco real',
    relatorios.status === 200 && relatorios.dados.pacotes_vendidos.total >= 1,
    JSON.stringify(relatorios.dados && relatorios.dados.pacotes_vendidos));

  const extrasCliente = await chamar('GET', `/api/portal/${cli.dados.token_portal}/extras`);
  verificar('cliente vê foto e carteirinha',
    extrasCliente.status === 200 && extrasCliente.dados.fotos.length === 1 &&
    extrasCliente.dados.vacinas.length === 1);

  console.log('\nPetshop de teste criado — apagar depois com:');
  console.log('  DATABASE_URL="..." node scripts/limpar-testes.mjs --aplicar');
  console.log(`  (e-mail: teste-${sufixo}@safersoftware.com.br)`);
}

console.log(`\n${falhas ? `${falhas} falha(s).` : 'Tudo certo.'}`);
process.exit(falhas ? 1 : 0);
