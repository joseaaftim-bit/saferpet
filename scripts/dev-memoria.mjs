// Sobe o SaferPet com Postgres em memória (pg-mem) para desenvolvimento
// e teste visual local, SEM banco instalado: node scripts/dev-memoria.mjs
// Já monta um petshop de exemplo — vitrine, painel e app do cliente ficam
// navegáveis na hora. Nada é persistido: ao derrubar o processo, some.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'segredo-dev-memoria';
process.env.HUB_TOKEN = 'hub-dev-memoria';
// Credenciais simuladas da SaferSoftware, para a tela de assinatura ficar
// completa no ambiente de desenvolvimento.
process.env.MP_ACCESS_TOKEN = 'APP_USR-simulado-dev';
process.env.MP_WEBHOOK_SECRET = 'b'.repeat(64);
const PORTA = parseInt(process.env.PORT || '4600', 10);
process.env.APP_URL = `http://localhost:${PORTA}`;

import { createRequire } from 'module';
import { readFileSync, readdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { newDb } from 'pg-mem';

const require = createRequire(import.meta.url);
const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const db = newDb();

// pg-mem traz pouquíssimas funções nativas — o Postgres real tem estas.
db.public.registerFunction({
  name: 'regexp_replace', args: ['text', 'text', 'text', 'text'], returns: 'text',
  implementation: (v, p, t, f) => (v == null ? null : String(v).replace(new RegExp(p, f || ''), t)),
});

function removerForUpdate(sql) {
  const m = /^([\s\S]*?)\s+FOR\s+UPDATE(\s+OF\s+[\w,\s]+)?\s*;?\s*$/i.exec(sql);
  return m ? m[1] : sql;
}

// O adaptador do pg-mem ignora ROLLBACK; emulamos com backup/restore.
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
const pool = embrulharPool(new Pool());
const database = require(path.join(raiz, 'backend', 'database.js'));
database.injetarPoolParaTestes(pool);

for (const arquivo of readdirSync(path.join(raiz, 'migrations')).filter(f => f.endsWith('.sql')).sort()) {
  const sql = readFileSync(path.join(raiz, 'migrations', arquivo), 'utf-8')
    .split('Migração de dados existentes')[0]
    .split('\n').filter(l => !/^\s*CREATE INDEX/i.test(l)).join('\n')
    .replace(/ADD COLUMN IF NOT EXISTS/gi, 'ADD COLUMN');
  await pool.query(sql);
}

const { app } = require(path.join(raiz, 'backend', 'server.js'));
const servidor = app.listen(PORTA);
const base = `http://127.0.0.1:${PORTA}`;

async function chamar(caminho, opcoes = {}) {
  const resp = await fetch(base + caminho, {
    method: opcoes.metodo || 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(opcoes.cracha ? { Authorization: `Bearer ${opcoes.cracha}` } : {}),
    },
    body: opcoes.corpo ? JSON.stringify(opcoes.corpo) : undefined,
  });
  const corpo = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(`${caminho} → ${resp.status} ${JSON.stringify(corpo)}`);
  return corpo;
}

// ─── Petshop de exemplo ──────────────────────────────────────────────

const cadastro = await chamar('/api/auth/registrar', {
  metodo: 'POST',
  corpo: {
    empresa_nome: 'Salva Patas', whatsapp: '67999990000', nome: 'Dona do petshop',
    email: 'dona@salvapatas.local', senha: 'senha-de-demonstracao',
  },
});
const cracha = cadastro.token;

await chamar('/api/empresa', {
  metodo: 'PUT', cracha,
  corpo: {
    nome: 'Salva Patas', whatsapp: '67999990000', slug: 'salvapatas',
    aceita_online: true, vende_produtos: true,
  },
});

const servicos = [];
for (const s of [
  { nome: 'Banho', duracao_minutos: 60, preco_centavos: 5000 },
  { nome: 'Banho e tosa', duracao_minutos: 120, preco_centavos: 9000 },
  { nome: 'Tosa higiênica', duracao_minutos: 45, preco_centavos: 4000 },
]) {
  servicos.push(await chamar('/api/servicos', { metodo: 'POST', cracha, corpo: s }));
}

await chamar('/api/pacotes/modelos', {
  metodo: 'POST', cracha,
  corpo: {
    nome: '24 banhos', valor_centavos: 70000, validade_meses: 12,
    itens: [{ servico_id: servicos[0].id, quantidade: 24 }],
  },
});
await chamar('/api/pacotes/modelos', {
  metodo: 'POST', cracha,
  corpo: {
    nome: 'Combo mensal', valor_centavos: 30000, validade_meses: 3,
    itens: [
      { servico_id: servicos[0].id, quantidade: 4 },
      { servico_id: servicos[2].id, quantidade: 1 },
    ],
  },
});

for (const p of [
  { nome: 'Ração Premium 10kg', preco_centavos: 18900, descricao: 'Adulto, sabor frango.' },
  { nome: 'Shampoo neutro 500ml', preco_centavos: 3500, descricao: 'Para pelagem sensível.' },
  { nome: 'Coleira antipulgas', preco_centavos: 8900, descricao: 'Proteção por 6 meses.' },
]) {
  await chamar('/api/loja/produtos', { metodo: 'POST', cracha, corpo: { ...p, estoque: 0, controla_estoque: false } });
}

// Cliente cadastrado no balcão (sem conta): serve para testar o pedido
// de confirmação, que é o caminho mais delicado do degrau 2.
const cliente = await chamar('/api/clientes', {
  metodo: 'POST', cracha,
  corpo: { nome: 'José', telefone: '(67) 98888-7777', email: 'jose@exemplo.local' },
});

console.log(`
SaferPet no ar em ${process.env.APP_URL}

  Vitrine pública    ${process.env.APP_URL}/salvapatas
  Painel do petshop  ${process.env.APP_URL}/app
     e-mail  dona@salvapatas.local
     senha   senha-de-demonstracao
  App do cliente     ${process.env.APP_URL}/portal/${cliente.token_portal}

  Cliente já no balcão (para testar a confirmação): (67) 98888-7777
  Ctrl+C encerra. O banco é em memória: nada fica salvo.
`);

process.on('SIGINT', () => { servidor.close(); process.exit(0); });
