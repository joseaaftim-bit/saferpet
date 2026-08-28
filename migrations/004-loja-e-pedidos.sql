-- Fase 3: loja de produtos com entrega na rota do leva-e-traz.
-- O pedido pago vira uma parada do veículo, no mesmo motor de agenda.

CREATE TABLE IF NOT EXISTS produtos (
  id             SERIAL PRIMARY KEY,
  empresa_id     INTEGER NOT NULL REFERENCES empresas(id),
  nome           VARCHAR(120) NOT NULL,
  descricao      TEXT,
  preco_centavos INTEGER NOT NULL CHECK (preco_centavos >= 0),
  estoque        INTEGER NOT NULL DEFAULT 0 CHECK (estoque >= 0),
  controla_estoque BOOLEAN NOT NULL DEFAULT TRUE,
  ativo          BOOLEAN NOT NULL DEFAULT TRUE,
  criado_em      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pedidos (
  id             SERIAL PRIMARY KEY,
  empresa_id     INTEGER NOT NULL REFERENCES empresas(id),
  cliente_id     INTEGER NOT NULL REFERENCES clientes(id),
  valor_centavos INTEGER NOT NULL CHECK (valor_centavos >= 0),
  status         VARCHAR(30) NOT NULL DEFAULT 'AGUARDANDO_PAGAMENTO',
  entrega        VARCHAR(20) NOT NULL DEFAULT 'RETIRADA',
  endereco       TEXT,
  observacao     TEXT,
  agendamento_id INTEGER REFERENCES agendamentos(id),
  criado_em      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  entregue_em    TIMESTAMPTZ
);

-- Preço e nome congelados na hora do pedido: mudar o catálogo depois não
-- reescreve o histórico do cliente.
CREATE TABLE IF NOT EXISTS pedidos_itens (
  id             SERIAL PRIMARY KEY,
  empresa_id     INTEGER NOT NULL REFERENCES empresas(id),
  pedido_id      INTEGER NOT NULL REFERENCES pedidos(id),
  produto_id     INTEGER REFERENCES produtos(id),
  produto_nome   VARCHAR(120) NOT NULL,
  preco_centavos INTEGER NOT NULL CHECK (preco_centavos >= 0),
  quantidade     INTEGER NOT NULL CHECK (quantidade > 0)
);

ALTER TABLE empresas ADD COLUMN IF NOT EXISTS vende_produtos BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE empresas ADD COLUMN IF NOT EXISTS entrega_gratis_acima_centavos INTEGER;
ALTER TABLE empresas ADD COLUMN IF NOT EXISTS taxa_entrega_centavos INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_produtos_empresa      ON produtos (empresa_id);
CREATE INDEX IF NOT EXISTS idx_pedidos_empresa       ON pedidos (empresa_id);
CREATE INDEX IF NOT EXISTS idx_pedidos_cliente       ON pedidos (cliente_id);
CREATE INDEX IF NOT EXISTS idx_pedidos_status        ON pedidos (empresa_id, status);
CREATE INDEX IF NOT EXISTS idx_pedidos_itens_pedido  ON pedidos_itens (pedido_id);
