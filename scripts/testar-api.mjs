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
  console.log('\n— Ciclo completo com petshop de teste —');
  const sufixo = Date.now();
  const reg = await chamar('POST', '/api/auth/registrar', { corpo: {
    empresa_nome: `Petshop (TESTE) ${sufixo}`, nome: 'Robô de teste',
    email: `teste-${sufixo}@safersoftware.com.br`, senha: `Teste-${sufixo}!`,
  }});
  verificar('registrar petshop de teste', reg.status === 201, JSON.stringify(reg.dados));
  const token = reg.dados.token;

  const cli = await chamar('POST', '/api/clientes', { token, corpo: { nome: 'Cliente (TESTE)' } });
  const pacote = await chamar('POST', '/api/pacotes', { token, corpo: {
    cliente_id: cli.dados.id, nome: 'Pacote (TESTE)', qtd_banhos: 3, valor_centavos: 100,
  }});
  verificar('vender pacote de teste', pacote.status === 201 && pacote.dados.saldo === 3);

  const baixa = await chamar('POST', '/api/baixas', { token, corpo: {
    pacote_id: pacote.dados.id, itens: [{}],
  }});
  verificar('baixa desconta saldo (3 → 2)', baixa.status === 201 && baixa.dados.saldo === 2);

  const estorno = await chamar('POST', `/api/baixas/${baixa.dados.baixas[0].id}/estornar`, { token });
  verificar('estorno devolve saldo (2 → 3)', estorno.status === 200 && estorno.dados.saldo === 3);

  const portal = await chamar('GET', `/api/portal/${cli.dados.token_portal}`);
  verificar('portal do cliente de teste abre', portal.status === 200);

  console.log('\nPetshop de teste criado — apagar depois no banco:');
  console.log(`  e-mail: teste-${sufixo}@safersoftware.com.br`);
}

console.log(`\n${falhas ? `${falhas} falha(s).` : 'Tudo certo.'}`);
process.exit(falhas ? 1 : 0);
