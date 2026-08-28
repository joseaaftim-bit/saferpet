'use strict';

// Consumo de créditos de pacote, por serviço, em FIFO entre pacotes
// (gasta primeiro o pacote mais antigo que tenha crédito daquele serviço).
// SEMPRE chamado dentro de uma transação (recebe o `query` dela).

const { hojeSaoPaulo, vencido } = require('./datas');

/**
 * Consome 1 crédito do serviço para o cliente. Retorna a baixa criada ou
 * null quando não há crédito disponível (pacote ativo, não vencido, com
 * saldo daquele serviço).
 */
async function consumirUmCredito(query, opts) {
  const {
    empresaId, clienteId, servicoId, servicoNome,
    petId = null, observacao = null, usuarioId, agendamentoId = null,
  } = opts;
  const hoje = opts.hoje || hojeSaoPaulo();

  const r = await query(
    `SELECT i.id AS item_id, i.saldo AS item_saldo, i.servico_nome,
            p.id AS pacote_id, p.saldo AS pacote_saldo, p.validade_ate
       FROM pacotes_itens i
       JOIN pacotes p ON p.id = i.pacote_id
      WHERE p.cliente_id = $1 AND p.empresa_id = $2 AND p.status = 'ATIVO'
        AND i.servico_id = $3 AND i.saldo > 0
      ORDER BY p.criado_em, p.id, i.id
      FOR UPDATE`,
    [clienteId, empresaId, servicoId]
  );

  const fonte = r.recordset.find(linha => !vencido(linha.validade_ate, hoje));
  if (!fonte) return null;

  const novoSaldoItem = fonte.item_saldo - 1;
  const novoSaldoPacote = fonte.pacote_saldo - 1;

  await query(
    'UPDATE pacotes_itens SET saldo = $1 WHERE id = $2 AND empresa_id = $3',
    [novoSaldoItem, fonte.item_id, empresaId]
  );
  await query(
    'UPDATE pacotes SET saldo = $1, status = $2 WHERE id = $3 AND empresa_id = $4',
    [novoSaldoPacote, novoSaldoPacote === 0 ? 'ESGOTADO' : 'ATIVO', fonte.pacote_id, empresaId]
  );

  const rb = await query(
    `INSERT INTO baixas (empresa_id, pacote_id, pacote_item_id, pet_id, servico,
                         observacao, saldo_apos, registrado_por, agendamento_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id, pacote_id, pacote_item_id, pet_id, servico, saldo_apos, registrado_em`,
    [empresaId, fonte.pacote_id, fonte.item_id, petId,
     servicoNome || fonte.servico_nome, observacao, novoSaldoItem, usuarioId, agendamentoId]
  );
  return rb.recordset[0];
}

/**
 * Saldo disponível por serviço para um cliente (pacotes ativos e não
 * vencidos). Retorna Map servico_id -> total.
 */
async function saldosPorServico(query, empresaId, clienteId) {
  const hoje = hojeSaoPaulo();
  const r = await query(
    `SELECT i.servico_id, i.saldo, p.validade_ate
       FROM pacotes_itens i
       JOIN pacotes p ON p.id = i.pacote_id
      WHERE p.cliente_id = $1 AND p.empresa_id = $2 AND p.status = 'ATIVO' AND i.saldo > 0`,
    [clienteId, empresaId]
  );
  const totais = new Map();
  for (const linha of r.recordset) {
    if (vencido(linha.validade_ate, hoje)) continue;
    totais.set(linha.servico_id, (totais.get(linha.servico_id) || 0) + linha.saldo);
  }
  return totais;
}

module.exports = { consumirUmCredito, saldosPorServico };
