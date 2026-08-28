-- Foto de produto na loja + cobrança da assinatura do petshop.
-- A assinatura é da SaferSoftware (credenciais globais), diferente do
-- pagamento do cliente final (credenciais de cada petshop).

ALTER TABLE produtos ADD COLUMN IF NOT EXISTS foto TEXT;

-- Logo do petshop: aparece no app do cliente e no topo do painel.
ALTER TABLE empresas ADD COLUMN IF NOT EXISTS logo TEXT;

-- Cobranças da mensalidade. mp_payment_id é UNIQUE: webhook repetido não
-- estende o acesso duas vezes.
CREATE TABLE IF NOT EXISTS assinaturas (
  id               SERIAL PRIMARY KEY,
  empresa_id       INTEGER NOT NULL REFERENCES empresas(id),
  plano            VARCHAR(20) NOT NULL,
  periodo          VARCHAR(10) NOT NULL,
  valor_centavos   INTEGER NOT NULL CHECK (valor_centavos >= 0),
  status           VARCHAR(20) NOT NULL DEFAULT 'PENDENTE',
  mp_preference_id VARCHAR(120),
  mp_payment_id    VARCHAR(60) UNIQUE,
  acesso_de        TIMESTAMPTZ,
  acesso_ate       TIMESTAMPTZ,
  criado_em        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  aprovado_em      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_assinaturas_empresa ON assinaturas (empresa_id);
CREATE INDEX IF NOT EXISTS idx_assinaturas_status  ON assinaturas (empresa_id, status);
