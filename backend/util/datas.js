'use strict';

// Datas do domínio são sempre 'AAAA-MM-DD' no fuso do petshop.
// O pg devolve colunas DATE como objeto Date (meia-noite LOCAL do servidor);
// dataISO normaliza qualquer formato para a string comparável.

function hojeSaoPaulo() {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Sao_Paulo' })
    .format(new Date());
}

function dataISO(valor) {
  if (!valor) return null;
  if (valor instanceof Date) {
    const ano = valor.getFullYear();
    const mes = String(valor.getMonth() + 1).padStart(2, '0');
    const dia = String(valor.getDate()).padStart(2, '0');
    return `${ano}-${mes}-${dia}`;
  }
  return String(valor).slice(0, 10);
}

// Soma meses sobre as partes da data, com o dia travado no fim do mês
// (31/01 + 1 mês = 28/02, nunca 03/03).
function somarMeses(iso, meses) {
  const [ano, mes, dia] = String(iso).split('-').map(Number);
  const totalMeses = ano * 12 + (mes - 1) + meses;
  const anoAlvo = Math.floor(totalMeses / 12);
  const mesAlvo = totalMeses % 12; // 0-based
  const ultimoDia = new Date(Date.UTC(anoAlvo, mesAlvo + 1, 0)).getUTCDate();
  const diaAlvo = Math.min(dia, ultimoDia);
  return `${anoAlvo}-${String(mesAlvo + 1).padStart(2, '0')}-${String(diaAlvo).padStart(2, '0')}`;
}

function vencido(validadeAte, hoje) {
  const validade = dataISO(validadeAte);
  return validade !== null && validade < (hoje || hojeSaoPaulo());
}

module.exports = { hojeSaoPaulo, dataISO, somarMeses, vencido };
