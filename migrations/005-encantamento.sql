-- Fase 4: o que faz o cliente falar do petshop.
-- Foto do pet pronto, carteirinha de vacinação, fila de encaixe e
-- avaliação pós-atendimento.

-- Foto guardada como base64 no banco. Escolha deliberada: sem bucket
-- externo, sem credencial de storage, backup junto com o resto. O limite
-- de tamanho é imposto na rota (a imagem é reduzida no navegador antes).
CREATE TABLE IF NOT EXISTS fotos (
  id             SERIAL PRIMARY KEY,
  empresa_id     INTEGER NOT NULL REFERENCES empresas(id),
  cliente_id     INTEGER NOT NULL REFERENCES clientes(id),
  pet_id         INTEGER REFERENCES pets(id),
  agendamento_id INTEGER REFERENCES agendamentos(id),
  conteudo       TEXT NOT NULL,
  legenda        VARCHAR(200),
  criado_por     INTEGER REFERENCES usuarios(id),
  criado_em      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS vacinas (
  id           SERIAL PRIMARY KEY,
  empresa_id   INTEGER NOT NULL REFERENCES empresas(id),
  pet_id       INTEGER NOT NULL REFERENCES pets(id),
  nome         VARCHAR(120) NOT NULL,
  aplicada_em  DATE NOT NULL,
  reforco_em   DATE,
  lote         VARCHAR(60),
  observacao   TEXT,
  registrado_por INTEGER REFERENCES usuarios(id),
  criado_em    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Fila de encaixe: quem quer um horário que está ocupado. Ao cancelar um
-- agendamento, o petshop vê quem avisar.
CREATE TABLE IF NOT EXISTS fila_espera (
  id          SERIAL PRIMARY KEY,
  empresa_id  INTEGER NOT NULL REFERENCES empresas(id),
  cliente_id  INTEGER NOT NULL REFERENCES clientes(id),
  pet_id      INTEGER REFERENCES pets(id),
  servico_id  INTEGER NOT NULL REFERENCES servicos(id),
  data        DATE NOT NULL,
  periodo     VARCHAR(20) NOT NULL DEFAULT 'QUALQUER',
  status      VARCHAR(20) NOT NULL DEFAULT 'ESPERANDO',
  criado_em   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS avaliacoes (
  id             SERIAL PRIMARY KEY,
  empresa_id     INTEGER NOT NULL REFERENCES empresas(id),
  cliente_id     INTEGER NOT NULL REFERENCES clientes(id),
  agendamento_id INTEGER NOT NULL REFERENCES agendamentos(id),
  nota           INTEGER NOT NULL CHECK (nota BETWEEN 1 AND 5),
  comentario     TEXT,
  criado_em      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_avaliacao_por_agendamento ON avaliacoes (agendamento_id);
CREATE INDEX IF NOT EXISTS idx_fotos_cliente   ON fotos (cliente_id);
CREATE INDEX IF NOT EXISTS idx_fotos_empresa   ON fotos (empresa_id);
CREATE INDEX IF NOT EXISTS idx_vacinas_pet     ON vacinas (pet_id);
CREATE INDEX IF NOT EXISTS idx_vacinas_reforco ON vacinas (empresa_id, reforco_em);
CREATE INDEX IF NOT EXISTS idx_fila_empresa    ON fila_espera (empresa_id, data, status);
CREATE INDEX IF NOT EXISTS idx_avaliacoes_empresa ON avaliacoes (empresa_id);
