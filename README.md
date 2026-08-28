# SaferPet

Plataforma de petshop da SaferSoftware: **pacotes pré-pagos com créditos por
serviço** e **agenda inteligente por duração**. O petshop cadastra os serviços
que quiser (banho 30 min, banho e tosa 45 min...), monta pacotes livres
(ex.: 20 banhos + 4 tosas por R$ 700), e a agenda calcula os horários pela
duração: agendou 45 min às 10:00, o próximo livre é 10:45. **Leva-e-traz** de
verdade: o veículo é um recurso com agenda própria — a busca bloqueia o
deslocamento antes do serviço e a entrega entra no primeiro encaixe depois.
O cliente acompanha créditos e agendamentos por um **link de portal** sem senha.

Primeiro caso de uso: Salva Patas Pet Spa & Vet (Campo Grande/MS).

## Arquitetura

Monorepo de origem única, sem build step:

- `backend/` — API Express (CommonJS) + PostgreSQL via `pg`. Migrations SQL
  numeradas em `migrations/`, aplicadas no boot por `backend/migrate.js`.
- `public/` — painel e portal em HTML/CSS/JS puro, servidos pelo próprio
  Express na mesma origem (`/` login, `/app` painel, `/portal/:token` cliente).
- Multi-tenant **por coluna**: toda tabela de negócio tem `empresa_id` e toda
  query filtra por ele (o id sai do JWT, nunca do corpo da requisição).

## Fluxo

1. Petshop cria a conta (`/`) — nasce com plano `TRIAL` (14 dias), o serviço
   "Banho", uma linha de atendimento e horário comercial padrão.
2. **Catálogo**: serviços com duração e preço próprios; modelos de pacote com
   itens de qualquer serviço (20 banhos + 4 tosas).
3. **Configurações**: dias/períodos de funcionamento, linhas de atendimento
   simultâneo, veículos do leva-e-traz, tempo de deslocamento, dias fechados.
4. **Agenda**: grade do dia por recurso; horários ofertados são calculados
   pela duração do serviço e pela agenda do veículo (leva-e-traz exige o
   deslocamento livre ANTES do início). Criação revalida o horário dentro de
   transação com trava por empresa — duas atendentes não agendam o mesmo slot.
5. **Concluir** um atendimento consome 1 crédito daquele serviço (FIFO entre
   pacotes, pacote vencido não conta); sem crédito, avisa para cobrar na hora.
   Baixa manual no balcão também existe, por serviço.
6. Registro errado se resolve com **estorno** (devolve o crédito ao item;
   nada é apagado). Atendente estorna só no mesmo dia; admin, sempre.
7. Pacote vencido bloqueia baixa na hora; admin **reativa** pela ficha com
   validade nova. Recurso com agendamentos futuros não pode ser desativado.
8. O cliente acompanha créditos por serviço e próximos agendamentos pelo
   link do portal (botão "Link do portal" na ficha).

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

## Roadmap (plano SaferPet 2.0)

- **Fase 2** — conta do cliente: compra de pacote online (Mercado Pago do
  petshop, webhook fecha por padrão), agendamento pelo próprio cliente,
  avisos no WhatsApp.
- **Fase 3** — loja de produtos com entrega na rota do leva-e-traz.
- **Fase 4** — foto do pet pronto, assinatura recorrente, carteirinha de
  vacinação, fila de encaixe, relatórios.
- Plugar no Safer Hub (rota `/api/hub/metrics` já pronta, falta o card no Hub).

Nota de teste: o pg-mem não valida `FOR UPDATE` (os harnesses removem a
cláusula). Toda query nova com `FOR UPDATE` sobre join precisa de `OF` nos
lados internos — conferir manualmente ou na fumaça contra Postgres real.
