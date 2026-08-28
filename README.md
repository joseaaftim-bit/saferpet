# SaferPet

Plataforma completa de petshop da SaferSoftware.

**Para o petshop:** serviços com duração própria (banho 30 min, banho e tosa
45 min...), pacotes pré-pagos livres (20 banhos + 4 tosas por R$ 700), agenda
que calcula os horários pela duração (45 min às 10:00 → próximo livre 10:45),
**leva-e-traz** com o veículo como recurso da agenda, loja de produtos com
entrega na mesma rota, carteirinha de vacinação, fila de encaixe e relatórios.

**Para o cliente:** um link sem senha onde ele vê os créditos, **compra pacote
e produtos pagando por Pix ou cartão**, **agenda sozinho** (inclusive pedindo
busca em casa), acompanha os pedidos, vê a foto do pet pronto e avalia o
atendimento.

O cenário que o produto precisa atender, de ponta a ponta: às 22h, com o
petshop fechado, o cliente compra um pacote pelo celular e agenda a retirada
das pets para as 10:00 do dia seguinte; de manhã a equipe encontra a venda e a
retirada no painel, busca os pets em casa, e na volta o mesmo carro entrega a
ração que ele pôs no carrinho.

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
| `CRIPTO_CHAVE` | não | 32 bytes em hex. Cifra as credenciais de Mercado Pago dos petshops. Sem ela, deriva do `JWT_SECRET` — **trocar o `JWT_SECRET` invalida as credenciais salvas** (cada petshop recadastra). |
| `TRIAL_DIAS` | não | Dias de teste ao criar petshop (padrão 14). |
| `DATABASE_SSL` | não | `true` só se usar a URL pública do Postgres. |

### Mercado Pago (por petshop)

O dinheiro do cliente vai direto para a conta do petshop: cada empresa
cadastra **as próprias credenciais** em Configurações — o access token de
produção e a chave secreta do webhook, ambos guardados cifrados (AES-256-GCM)
e nunca devolvidos em leitura. A URL do webhook aparece pronta na mesma tela
(`/api/pagamentos/webhook/:empresa_id`). Sem as **duas** credenciais, o botão
de comprar não aparece para o cliente — pagar sem o webhook configurado
significaria pagar sem receber crédito.

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

## O que está pronto

- **Fase 1** — serviços com duração, pacotes com créditos por serviço, agenda
  por recurso, leva-e-traz, exceções de funcionamento.
- **Fase 2** — app do cliente pelo link: compra de pacote (Mercado Pago do
  petshop), agendamento próprio com busca em casa, cancelamento.
- **Fase 3** — loja de produtos, carrinho, taxa e frete grátis, pedido pago
  entra na rota do veículo, painel de pedidos.
- **Fase 4** — foto do pet pronto, carteirinha de vacinação com lembrete de
  reforço, fila de encaixe, avaliação pós-atendimento, relatórios do dono.

## Roadmap

- Assinatura recorrente (plano mensal com horário fixo).
- Avisos automáticos no WhatsApp (hoje os links são montados para envio manual).
- Plugar no Safer Hub (rota `/api/hub/metrics` já pronta, falta o card no Hub).

## Armadilhas conhecidas (leia antes de mexer)

- **`FOR UPDATE` em join externo precisa de `OF`** nos lados internos. O
  pg-mem da bateria não valida a cláusula (os harnesses a removem), então o
  erro só aparece em produção — três rotas já quebraram assim.
- **pg-mem não faz subquery correlacionada** nem aritmética com parâmetro sem
  cast: use `$1::int` e junção em JS quando precisar.
- **O webhook não pode confiar em nada que venha no corpo**: valor, produto e
  destino saem sempre do servidor. A bateria simula o Mercado Pago inteiro
  (`scripts/testar-local.mjs`) — inclusive pagamento repetido, valor
  divergente, webhook perdido (reconciliação) e carrinho abandonado.
