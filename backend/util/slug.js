'use strict';

// Apelido do petshop no endereço público: /salvapatas
// Precisa ser previsível de digitar e nunca colidir com as rotas do app.

const RESERVADOS = new Set([
  'api', 'app', 'portal', 'admin', 'painel', 'login', 'entrar', 'sair',
  'js', 'css', 'estilo', 'assets', 'static', 'favicon', 'index',
  'saferpet', 'safersoftware', 'suporte', 'ajuda', 'sobre', 'termos',
  'privacidade', 'conta', 'cliente', 'clientes', 'petshop', 'petshops',
]);

function normalizarSlug(texto) {
  return String(texto || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')  // tira acento
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

/** Retorna { ok: true, slug } ou { ok: false, erro }. */
function validarSlug(texto) {
  const slug = normalizarSlug(texto);
  if (slug.length < 3) {
    return { ok: false, erro: 'O endereço precisa ter ao menos 3 letras.' };
  }
  if (RESERVADOS.has(slug)) {
    return { ok: false, erro: 'Este endereço é reservado pelo sistema. Escolha outro.' };
  }
  if (/^petshop-\d+$/.test(slug)) {
    return { ok: false, erro: 'Escolha um endereço com o nome do petshop.' };
  }
  return { ok: true, slug };
}

module.exports = { normalizarSlug, validarSlug, RESERVADOS };
