-- Fase 2: o cliente compra e agenda sozinho.
-- Credenciais do Mercado Pago são POR PETSHOP (o dinheiro cai na conta
-- dele), guardadas cifradas. O portal por token vira o app do cliente.

ALTER TABLE clientes ADD COLUMN IF NOT EXISTS endereco TEXT;
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS senha_hash VARCHAR(100);

ALTER TABLE empresas ADD COLUMN IF NOT EXISTS mp_access_token TEXT;
ALTER TABLE empresas ADD COLUMN IF NOT EXISTS mp_webhook_secret TEXT;
-- Nasce DESLIGADO: nenhum petshop passa a aceitar agendamento pelo app sem
-- ligar a chave nas configurações.
ALTER TABLE empresas ADD COLUMN IF NOT EXISTS aceita_online BOOLEAN NOT NULL DEFAULT FALSE;

-- Pagamentos online. mp_payment_id é único: o webhook repetido não credita
-- duas vezes (idempotência garantida pelo banco, não só pelo código).
CREATE TABLE IF NOT EXISTS pagamentos (
  id               SERIAL PRIMARY KEY,
  empresa_id       INTEGER NOT NULL REFERENCES empresas(id),
  cliente_id       INTEGER NOT NULL REFERENCES clientes(id),
  tipo             VARCHAR(20) NOT NULL DEFAULT 'PACOTE',
  modelo_id        INTEGER REFERENCES pacotes_modelo(id),
  pedido_id        INTEGER,
  valor_centavos   INTEGER NOT NULL CHECK (valor_centavos >= 0),
  status           VARCHAR(20) NOT NULL DEFAULT 'PENDENTE',
  mp_preference_id VARCHAR(120),
  mp_payment_id    VARCHAR(60) UNIQUE,
  pacote_id        INTEGER REFERENCES pacotes(id),
  criado_em        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  aprovado_em      TIMESTAMPTZ
);

-- Agendamento feito pelo próprio cliente fica marcado (o painel mostra).
ALTER TABLE agendamentos ADD COLUMN IF NOT EXISTS origem VARCHAR(20) NOT NULL DEFAULT 'PETSHOP';

CREATE INDEX IF NOT EXISTS idx_pagamentos_empresa ON pagamentos (empresa_id);
CREATE INDEX IF NOT EXISTS idx_pagamentos_cliente ON pagamentos (cliente_id);
CREATE INDEX IF NOT EXISTS idx_pagamentos_status  ON pagamentos (status);
