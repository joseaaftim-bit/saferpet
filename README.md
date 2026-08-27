# SaferPet

SaaS de controle de **pacotes pré-pagos de banho** para petshop. Substitui o
caderno a caneta: o cliente compra um pacote (ex.: 24 banhos por R$ 700), cada
banho vira uma **baixa** registrada com quem/quando, e o saldo nunca se perde.
O cliente acompanha tudo por um **link de portal** sem senha.

Produto da SaferSoftware. Primeiro caso de uso: Salva Patas Pet Spa & Vet
(Campo Grande/MS).

## Arquitetura

Monorepo de origem única, sem build step:

- `backend/` — API Express (CommonJS) + PostgreSQL via `pg`. Migrations SQL
  numeradas em `migrations/`, aplicadas no boot por `backend/migrate.js`.
- `public/` — painel e portal em HTML/CSS/JS puro, servidos pelo próprio
  Express na mesma origem (`/` login, `/app` painel, `/portal/:token` cliente).
- Multi-tenant **por coluna**: toda tabela de negócio tem `empresa_id` e toda
  query filtra por ele (o id sai do JWT, nunca do corpo da requisição).

## Fluxo

1. Petshop cria a conta (`/`) — nasce com plano `TRIAL` (14 dias).
2. Cadastra clientes e pets; monta o catálogo de pacotes (aba Pacotes).
3. Vende um pacote ao cliente (do catálogo ou avulso) — o pagamento acontece
   no balcão do petshop; o sistema registra valor e saldo.
4. A cada banho, **Dar baixa**: escolhe os pets, o saldo desconta em transação
   com as linhas dos pacotes travadas (`FOR UPDATE`) — sem corrida, sem saldo
   negativo. Com mais de um pacote ativo, consome-se o mais antigo primeiro e,
   se ele não cobrir tudo, o resto **transborda** para o pacote seguinte na
   mesma operação (1 banho no velho + 24 no novo dá baixa das duas pets de uma vez).
5. Registro errado se resolve com **estorno** (marca a baixa e devolve o
   saldo; nada é apagado). Atendente estorna só no mesmo dia; admin, sempre.
6. Pacote vencido bloqueia a baixa na hora (não depende do cron); o admin
   **reativa** pelo botão na ficha, definindo validade nova. Cancelamento por
   engano também se desfaz por ali.
7. O cliente acompanha pelo link do portal (botão "Link do portal" na ficha).

## Variáveis de ambiente (Railway)

| Variável | Obrigatória | Descrição |
|---|---|---|
| `DATABASE_URL` | sim | `${{Postgres.DATABASE_URL}}` |
| `JWT_SECRET` | sim | 48+ bytes aleatórios. Sem ela o boot **aborta** em produção. |
| `NODE_ENV` | sim | `production` |
| `APP_URL` | sim | `https://pet.safersoftware.com.br` (monta o link do portal) |
| `HUB_TOKEN` | não | Token para o Safer Hub ler `/api/hub/metrics`. Sem ela a rota responde 503. |
| `TRIAL_DIAS` | não | Dias de teste ao criar petshop (padrão 14). |
| `DATABASE_SSL` | não | `true` só se usar a URL pública do Postgres. |

Gerar segredos:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

## Rodar local

```bash
npm install
npm run teste:local        # bateria completa em Postgres na memória (pg-mem)
npm start                  # exige um Postgres local (PGHOST/PGDATABASE/...)
```

Fumaça contra ambiente publicado (só leitura; `--completo` cria um petshop
marcado com "(TESTE)"):

```bash
node scripts/testar-api.mjs https://pet.safersoftware.com.br
```

## Segurança (padrão da casa)

- Segredo **sem fallback** no código: `backend/config/segredos.js` aborta o
  boot em produção quando `JWT_SECRET` falta.
- `empresa_id` do JWT em **toda** query; update/delete com o filtro no WHERE
  (id de outro tenant não encontra a linha).
- Quem manda no acesso é `empresas.acesso_ate` no banco (middleware
  `exigirAcessoVigente`, HTTP 402), não o campo `plano` do token.
- Baixa e estorno em transação com `FOR UPDATE`; `saldo >= 0` também é
  CHECK no banco.
- Venda pelo catálogo ignora valor/quantidade vindos do cliente — preço sai
  do servidor.
- Erros: log completo no servidor, mensagem genérica na resposta (chave `erro`).
- Rate limiting nas rotas de auth (login 10/15min por IP+e-mail; registro
  5/h por IP) e login em tempo constante (bcrypt roda mesmo sem usuário).
- Datas do domínio são `AAAA-MM-DD` no fuso de São Paulo (`backend/util/datas.js`);
  o `pg` devolve DATE como string (type parser registrado em `database.js`).
- `/api/health` faz `SELECT 1` de verdade.
- Portal do cliente: token aleatório de 24 bytes é a credencial; admin pode
  regenerar (invalida o link antigo). Sem pagamento online no v1 — não há
  webhook exposto.

## Roadmap curto

- Cobrança da assinatura do petshop (Mercado Pago, no padrão da casa:
  webhook fecha por padrão, preço na tabela do servidor, liberação em transação).
- Plugar no Safer Hub (rota `/api/hub/metrics` já pronta, falta o card no Hub).
- Agenda de banhos (hoje o agendamento segue pelo WhatsApp).
