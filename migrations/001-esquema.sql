-- SaferPet — schema inicial.
-- Multi-tenant por coluna: toda tabela de negócio carrega empresa_id.

CREATE TABLE IF NOT EXISTS empresas (
  id          SERIAL PRIMARY KEY,
  nome        VARCHAR(120) NOT NULL,
  whatsapp    VARCHAR(20),
  plano       VARCHAR(20) NOT NULL DEFAULT 'TRIAL',
  acesso_ate  TIMESTAMPTZ NOT NULL,
  ativo       BOOLEAN NOT NULL DEFAULT TRUE,
  criado_em   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS usuarios (
  id          SERIAL PRIMARY KEY,
  empresa_id  INTEGER NOT NULL REFERENCES empresas(id),
  nome        VARCHAR(120) NOT NULL,
  email       VARCHAR(160) NOT NULL UNIQUE,
  senha_hash  VARCHAR(100) NOT NULL,
  permissoes  VARCHAR(20) NOT NULL DEFAULT 'ATENDENTE',
  ativo       BOOLEAN NOT NULL DEFAULT TRUE,
  criado_em   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS clientes (
  id           SERIAL PRIMARY KEY,
  empresa_id   INTEGER NOT NULL REFERENCES empresas(id),
  nome         VARCHAR(120) NOT NULL,
  telefone     VARCHAR(20),
  email        VARCHAR(160),
  observacoes  TEXT,
  token_portal VARCHAR(64) NOT NULL UNIQUE,
  ativo        BOOLEAN NOT NULL DEFAULT TRUE,
  criado_em    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pets (
  id           SERIAL PRIMARY KEY,
  empresa_id   INTEGER NOT NULL REFERENCES empresas(id),
  cliente_id   INTEGER NOT NULL REFERENCES clientes(id),
  nome         VARCHAR(80) NOT NULL,
  raca         VARCHAR(80),
  porte        VARCHAR(20),
  observacoes  TEXT,
  ativo        BOOLEAN NOT NULL DEFAULT TRUE,
  criado_em    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Catálogo de pacotes que o petshop vende (ex.: 24 banhos por R$ 700).
CREATE TABLE IF NOT EXISTS pacotes_modelo (
  id             SERIAL PRIMARY KEY,
  empresa_id     INTEGER NOT NULL REFERENCES empresas(id),
  nome           VARCHAR(120) NOT NULL,
  qtd_banhos     INTEGER NOT NULL CHECK (qtd_banhos > 0),
  valor_centavos INTEGER NOT NULL CHECK (valor_centavos >= 0),
  validade_meses INTEGER,
  ativo          BOOLEAN NOT NULL DEFAULT TRUE,
  criado_em      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Pacote vendido a um cliente. O saldo vive aqui e só muda em transação.
CREATE TABLE IF NOT EXISTS pacotes (
  id             SERIAL PRIMARY KEY,
  empresa_id     INTEGER NOT NULL REFERENCES empresas(id),
  cliente_id     INTEGER NOT NULL REFERENCES clientes(id),
  nome           VARCHAR(120) NOT NULL,
  qtd_banhos     INTEGER NOT NULL CHECK (qtd_banhos > 0),
  valor_centavos INTEGER NOT NULL CHECK (valor_centavos >= 0),
  saldo          INTEGER NOT NULL CHECK (saldo >= 0),
  status         VARCHAR(20) NOT NULL DEFAULT 'ATIVO',
  comprado_em    DATE NOT NULL,
  validade_ate   DATE,
  criado_por     INTEGER REFERENCES usuarios(id),
  criado_em      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Registro de cada banho debitado. Append-only: estorno marca a linha,
-- nunca apaga (o histórico é a garantia contra o "caderno com rasura").
CREATE TABLE IF NOT EXISTS baixas (
  id             SERIAL PRIMARY KEY,
  empresa_id     INTEGER NOT NULL REFERENCES empresas(id),
  pacote_id      INTEGER NOT NULL REFERENCES pacotes(id),
  pet_id         INTEGER REFERENCES pets(id),
  servico        VARCHAR(120) NOT NULL DEFAULT 'Banho',
  observacao     TEXT,
  saldo_apos     INTEGER NOT NULL,
  registrado_por INTEGER NOT NULL REFERENCES usuarios(id),
  registrado_em  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  estornada      BOOLEAN NOT NULL DEFAULT FALSE,
  estornada_por  INTEGER REFERENCES usuarios(id),
  estornada_em   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_usuarios_empresa       ON usuarios (empresa_id);
CREATE INDEX IF NOT EXISTS idx_clientes_empresa       ON clientes (empresa_id);
CREATE INDEX IF NOT EXISTS idx_pets_empresa           ON pets (empresa_id);
CREATE INDEX IF NOT EXISTS idx_pets_cliente           ON pets (cliente_id);
CREATE INDEX IF NOT EXISTS idx_pacotes_modelo_empresa ON pacotes_modelo (empresa_id);
CREATE INDEX IF NOT EXISTS idx_pacotes_empresa        ON pacotes (empresa_id);
CREATE INDEX IF NOT EXISTS idx_pacotes_cliente        ON pacotes (cliente_id);
CREATE INDEX IF NOT EXISTS idx_baixas_empresa         ON baixas (empresa_id);
CREATE INDEX IF NOT EXISTS idx_baixas_pacote          ON baixas (pacote_id);
CREATE INDEX IF NOT EXISTS idx_baixas_registrado_em   ON baixas (registrado_em);
