-- Um pedido de confirmação PENDENTE por cliente: dois cadastros
-- simultâneos com o mesmo telefone não podem virar dois cards de
-- confirmação (a rota trata a violação como "aguarde", não como erro).
CREATE UNIQUE INDEX IF NOT EXISTS idx_vinculos_um_pendente
  ON vinculos_pendentes (empresa_id, cliente_id) WHERE status = 'PENDENTE';
