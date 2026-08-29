'use strict';

// O telefone virou a identidade do dono de pet (é com ele que entra na
// conta). Guardamos os dígitos numa coluna própria: o cadastro do balcão
// vem "(67) 99999-1234" e o cliente digita "67999991234" — o mesmo número.

function soDigitos(valor) {
  return String(valor == null ? '' : valor).replace(/\D/g, '') || null;
}

function telefoneValido(digitos) {
  return !!digitos && digitos.length >= 10 && digitos.length <= 13;
}

/**
 * Recusa cadastrar o mesmo número em dois clientes da mesma empresa —
 * senão o login por telefone fica ambíguo. `ignorarId` é o próprio
 * cliente na edição.
 *
 * Só vale para número NOVO: um cadastro antigo com duplicata (o caderno
 * tinha) não pode travar a edição do nome ou do endereço.
 */
async function telefoneEmUso(query, empresaId, digitos, ignorarId) {
  if (!digitos) return false;
  const r = await query(
    `SELECT id FROM clientes
      WHERE empresa_id = $1 AND telefone_digitos = $2 AND ativo AND id <> $3
      LIMIT 1`,
    [empresaId, digitos, ignorarId || 0]
  );
  return r.recordset.length > 0;
}

/** O telefone que está gravado hoje para este cliente. */
async function telefoneAtual(query, empresaId, clienteId) {
  const r = await query(
    'SELECT telefone_digitos FROM clientes WHERE id = $1 AND empresa_id = $2',
    [clienteId, empresaId]
  );
  return r.recordset.length ? r.recordset[0].telefone_digitos : null;
}

module.exports = { soDigitos, telefoneValido, telefoneEmUso, telefoneAtual };
