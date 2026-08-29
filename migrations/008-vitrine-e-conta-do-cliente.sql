-- Degrau 1: cada petshop ganha um endereço público (/apelido).
-- Degrau 2: o dono de pet cria a própria conta dentro daquele petshop.

ALTER TABLE empresas ADD COLUMN IF NOT EXISTS slug VARCHAR(40);
CREATE UNIQUE INDEX IF NOT EXISTS idx_empresas_slug ON empresas (slug);

-- A conta do cliente reaproveita a linha que o petshop já cadastrou:
-- senha_hash veio na migração 003; aqui marcamos quem realmente ativou.
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS conta_ativa BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS conta_criada_em TIMESTAMPTZ;

-- Quando alguém tenta criar conta com um telefone QUE JÁ EXISTE no petshop,
-- não damos acesso ao histórico sem confirmação: fica pendente até o
-- petshop aprovar no balcão (é o petshop que conhece o cliente).
CREATE TABLE IF NOT EXISTS vinculos_pendentes (
  id          SERIAL PRIMARY KEY,
  empresa_id  INTEGER NOT NULL REFERENCES empresas(id),
  cliente_id  INTEGER NOT NULL REFERENCES clientes(id),
  nome        VARCHAR(120) NOT NULL,
  telefone    VARCHAR(20) NOT NULL,
  email       VARCHAR(160),
  senha_hash  VARCHAR(100) NOT NULL,
  status      VARCHAR(20) NOT NULL DEFAULT 'PENDENTE',
  criado_em   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decidido_em TIMESTAMPTZ,
  decidido_por INTEGER REFERENCES usuarios(id)
);

CREATE INDEX IF NOT EXISTS idx_vinculos_empresa ON vinculos_pendentes (empresa_id, status);
-- Telefone só com dígitos: é assim que o dono de pet entra (ele digita
-- com ou sem parêntese, e o cadastro do petshop veio de qualquer jeito).
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS telefone_digitos VARCHAR(15);
CREATE INDEX IF NOT EXISTS idx_clientes_telefone ON clientes (empresa_id, telefone_digitos);

-- Apelido inicial para quem já existe: o petshop troca depois se quiser.
UPDATE empresas SET slug = 'petshop-' || id::text WHERE slug IS NULL;

-- Preenche os telefones que já existem.
UPDATE clientes SET telefone_digitos = regexp_replace(telefone, '[^0-9]', '', 'g')
 WHERE telefone IS NOT NULL AND telefone_digitos IS NULL;
