-- Fase 1: serviços com duração, pacotes genéricos (créditos por serviço),
-- recursos (equipe/veículo) e agenda. Migra os dados existentes: pacotes
-- antigos viram itens de crédito do serviço "Banho".

CREATE TABLE IF NOT EXISTS servicos (
  id              SERIAL PRIMARY KEY,
  empresa_id      INTEGER NOT NULL REFERENCES empresas(id),
  nome            VARCHAR(120) NOT NULL,
  duracao_minutos INTEGER NOT NULL CHECK (duracao_minutos > 0),
  preco_centavos  INTEGER NOT NULL DEFAULT 0 CHECK (preco_centavos >= 0),
  ativo           BOOLEAN NOT NULL DEFAULT TRUE,
  criado_em       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Itens do modelo: um pacote do catálogo é um conjunto de créditos
-- (ex.: 20 banhos + 4 banho e tosa).
CREATE TABLE IF NOT EXISTS pacotes_modelo_itens (
  id         SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  modelo_id  INTEGER NOT NULL REFERENCES pacotes_modelo(id),
  servico_id INTEGER NOT NULL REFERENCES servicos(id),
  quantidade INTEGER NOT NULL CHECK (quantidade > 0)
);

-- Créditos do pacote vendido, por serviço. O saldo de cada serviço vive
-- aqui; pacotes.saldo passa a ser o TOTAL (soma dos itens), mantido junto.
CREATE TABLE IF NOT EXISTS pacotes_itens (
  id           SERIAL PRIMARY KEY,
  empresa_id   INTEGER NOT NULL REFERENCES empresas(id),
  pacote_id    INTEGER NOT NULL REFERENCES pacotes(id),
  servico_id   INTEGER REFERENCES servicos(id),
  servico_nome VARCHAR(120) NOT NULL,
  quantidade   INTEGER NOT NULL CHECK (quantidade > 0),
  saldo        INTEGER NOT NULL CHECK (saldo >= 0)
);

ALTER TABLE baixas ADD COLUMN IF NOT EXISTS pacote_item_id INTEGER REFERENCES pacotes_itens(id);
ALTER TABLE baixas ADD COLUMN IF NOT EXISTS agendamento_id INTEGER;

-- Recursos que ocupam agenda: quem atende (banhista/box) e quem dirige.
CREATE TABLE IF NOT EXISTS recursos (
  id         SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  nome       VARCHAR(80) NOT NULL,
  tipo       VARCHAR(20) NOT NULL DEFAULT 'ATENDIMENTO', -- ATENDIMENTO | VEICULO
  ativo      BOOLEAN NOT NULL DEFAULT TRUE,
  criado_em  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Períodos de funcionamento por dia da semana (0=domingo ... 6=sábado).
-- Horários como 'HH:MM' — comparação lexicográfica funciona e é portátil.
CREATE TABLE IF NOT EXISTS agenda_horarios (
  id         SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  dia_semana INTEGER NOT NULL CHECK (dia_semana BETWEEN 0 AND 6),
  inicio     VARCHAR(5) NOT NULL,
  fim        VARCHAR(5) NOT NULL
);

-- Dias fechados fora do padrão (feriado, reforma).
CREATE TABLE IF NOT EXISTS agenda_excecoes (
  id         SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL REFERENCES empresas(id),
  data       DATE NOT NULL,
  motivo     VARCHAR(120)
);

CREATE TABLE IF NOT EXISTS agendamentos (
  id                 SERIAL PRIMARY KEY,
  empresa_id         INTEGER NOT NULL REFERENCES empresas(id),
  cliente_id         INTEGER NOT NULL REFERENCES clientes(id),
  pet_id             INTEGER REFERENCES pets(id),
  servico_id         INTEGER REFERENCES servicos(id),
  recurso_id         INTEGER NOT NULL REFERENCES recursos(id),
  tipo               VARCHAR(20) NOT NULL DEFAULT 'SERVICO', -- SERVICO | BUSCA | ENTREGA
  agendamento_pai_id INTEGER REFERENCES agendamentos(id),
  data               DATE NOT NULL,
  inicio             VARCHAR(5) NOT NULL,
  fim                VARCHAR(5) NOT NULL,
  status             VARCHAR(20) NOT NULL DEFAULT 'AGENDADO', -- AGENDADO | CONCLUIDO | CANCELADO | FALTOU
  observacao         TEXT,
  criado_por         INTEGER REFERENCES usuarios(id),
  criado_em          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE empresas ADD COLUMN IF NOT EXISTS tempo_deslocamento_minutos INTEGER NOT NULL DEFAULT 30;
ALTER TABLE empresas ADD COLUMN IF NOT EXISTS intervalo_grade_minutos INTEGER NOT NULL DEFAULT 15;

CREATE INDEX IF NOT EXISTS idx_servicos_empresa        ON servicos (empresa_id);
CREATE INDEX IF NOT EXISTS idx_modelo_itens_modelo     ON pacotes_modelo_itens (modelo_id);
CREATE INDEX IF NOT EXISTS idx_pacotes_itens_pacote    ON pacotes_itens (pacote_id);
CREATE INDEX IF NOT EXISTS idx_pacotes_itens_empresa   ON pacotes_itens (empresa_id);
CREATE INDEX IF NOT EXISTS idx_recursos_empresa        ON recursos (empresa_id);
CREATE INDEX IF NOT EXISTS idx_agenda_horarios_empresa ON agenda_horarios (empresa_id);
CREATE INDEX IF NOT EXISTS idx_agendamentos_empresa    ON agendamentos (empresa_id);
CREATE INDEX IF NOT EXISTS idx_agendamentos_dia        ON agendamentos (empresa_id, data);

-- ─── Migração de dados existentes ──────────────────────────────────

-- Toda empresa ganha o serviço "Banho" (30 min) se ainda não tem serviço.
INSERT INTO servicos (empresa_id, nome, duracao_minutos, preco_centavos)
SELECT e.id, 'Banho', 30, 0
  FROM empresas e
 WHERE NOT EXISTS (SELECT 1 FROM servicos s WHERE s.empresa_id = e.id);

-- Pacotes antigos (qtd_banhos) viram um item de crédito de Banho.
INSERT INTO pacotes_itens (empresa_id, pacote_id, servico_id, servico_nome, quantidade, saldo)
SELECT p.empresa_id, p.id,
       (SELECT s.id FROM servicos s WHERE s.empresa_id = p.empresa_id ORDER BY s.id LIMIT 1),
       'Banho', p.qtd_banhos, p.saldo
  FROM pacotes p
 WHERE NOT EXISTS (SELECT 1 FROM pacotes_itens i WHERE i.pacote_id = p.id);

INSERT INTO pacotes_modelo_itens (empresa_id, modelo_id, servico_id, quantidade)
SELECT m.empresa_id, m.id,
       (SELECT s.id FROM servicos s WHERE s.empresa_id = m.empresa_id ORDER BY s.id LIMIT 1),
       m.qtd_banhos
  FROM pacotes_modelo m
 WHERE NOT EXISTS (SELECT 1 FROM pacotes_modelo_itens i WHERE i.modelo_id = m.id);

UPDATE baixas b
   SET pacote_item_id = (SELECT i.id FROM pacotes_itens i WHERE i.pacote_id = b.pacote_id ORDER BY i.id LIMIT 1)
 WHERE b.pacote_item_id IS NULL;

-- Toda empresa ganha um recurso de atendimento para a agenda funcionar.
INSERT INTO recursos (empresa_id, nome, tipo)
SELECT e.id, 'Atendimento 1', 'ATENDIMENTO'
  FROM empresas e
 WHERE NOT EXISTS (SELECT 1 FROM recursos r WHERE r.empresa_id = e.id AND r.tipo = 'ATENDIMENTO');

-- Horário padrão para empresas que ainda não configuraram a agenda:
-- segunda a sexta 08:00–18:00, sábado 08:00–12:00 (o petshop edita depois).
INSERT INTO agenda_horarios (empresa_id, dia_semana, inicio, fim)
SELECT e.id, 1, '08:00', '18:00' FROM empresas e
 WHERE NOT EXISTS (SELECT 1 FROM agenda_horarios h WHERE h.empresa_id = e.id AND h.dia_semana = 1);
INSERT INTO agenda_horarios (empresa_id, dia_semana, inicio, fim)
SELECT e.id, 2, '08:00', '18:00' FROM empresas e
 WHERE NOT EXISTS (SELECT 1 FROM agenda_horarios h WHERE h.empresa_id = e.id AND h.dia_semana = 2);
INSERT INTO agenda_horarios (empresa_id, dia_semana, inicio, fim)
SELECT e.id, 3, '08:00', '18:00' FROM empresas e
 WHERE NOT EXISTS (SELECT 1 FROM agenda_horarios h WHERE h.empresa_id = e.id AND h.dia_semana = 3);
INSERT INTO agenda_horarios (empresa_id, dia_semana, inicio, fim)
SELECT e.id, 4, '08:00', '18:00' FROM empresas e
 WHERE NOT EXISTS (SELECT 1 FROM agenda_horarios h WHERE h.empresa_id = e.id AND h.dia_semana = 4);
INSERT INTO agenda_horarios (empresa_id, dia_semana, inicio, fim)
SELECT e.id, 5, '08:00', '18:00' FROM empresas e
 WHERE NOT EXISTS (SELECT 1 FROM agenda_horarios h WHERE h.empresa_id = e.id AND h.dia_semana = 5);
INSERT INTO agenda_horarios (empresa_id, dia_semana, inicio, fim)
SELECT e.id, 6, '08:00', '12:00' FROM empresas e
 WHERE NOT EXISTS (SELECT 1 FROM agenda_horarios h WHERE h.empresa_id = e.id AND h.dia_semana = 6);
