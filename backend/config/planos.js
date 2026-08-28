'use strict';

// Tabela de preços da assinatura — a ÚNICA fonte de verdade. O webhook
// confere o valor pago contra ela; nada vem do cliente.
//
// Para mudar o preço, mexa aqui (ou nas variáveis de ambiente) e reinicie.

const MENSAL_CENTAVOS = parseInt(process.env.PRECO_MENSAL_CENTAVOS || '14900', 10);
const ANUAL_CENTAVOS = parseInt(process.env.PRECO_ANUAL_CENTAVOS || '149000', 10);

const PLANOS = {
  MENSAL: {
    periodo: 'MENSAL',
    plano: 'PRO',
    nome: 'SaferPet mensal',
    valor_centavos: MENSAL_CENTAVOS,
    dias: 30,
    descricao: 'Agenda, pacotes, loja e app do cliente — sem limite de clientes.',
  },
  ANUAL: {
    periodo: 'ANUAL',
    plano: 'PRO',
    nome: 'SaferPet anual',
    valor_centavos: ANUAL_CENTAVOS,
    dias: 365,
    descricao: 'O mesmo do mensal, com dois meses de desconto.',
  },
};

function planoDe(periodo) {
  return PLANOS[String(periodo || '').toUpperCase()] || null;
}

function listarPlanos() {
  return Object.values(PLANOS);
}

module.exports = { PLANOS, planoDe, listarPlanos };
