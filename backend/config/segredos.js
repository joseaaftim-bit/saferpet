'use strict';

// Centraliza os segredos da aplicação. Em produção não existe valor
// default: se a env faltar, o boot falha aqui em vez de subir com um
// segredo público (o repositório é público no GitHub).

const PRODUCAO = process.env.NODE_ENV === 'production';

const DEV_DEFAULTS = {
  JWT_SECRET: 'dev-only-jwt-secret',
  APP_URL: 'http://localhost:4600',
};

function obrigatorioEmProducao(nome) {
  const valor = process.env[nome];
  if (valor) return valor;

  if (PRODUCAO) {
    console.error(
      `[boot] FATAL: ${nome} não definida. ` +
      'Defina a variável de ambiente antes de subir em produção.'
    );
    process.exit(1);
  }
  console.warn(`[boot] ${nome} ausente — usando valor de desenvolvimento.`);
  return DEV_DEFAULTS[nome];
}

module.exports = {
  PRODUCAO,
  JWT_SECRET: obrigatorioEmProducao('JWT_SECRET'),

  // Token do Safer Hub. Opcional: sem ele a rota /api/hub/metrics responde 503.
  HUB_TOKEN: process.env.HUB_TOKEN || null,

  // Dias de teste gratuito ao criar um petshop novo.
  TRIAL_DIAS: parseInt(process.env.TRIAL_DIAS || '14', 10),

  // URL pública do app — monta o link do portal do cliente. Obrigatória em
  // produção: com fallback, o petshop mandaria link de localhost por WhatsApp.
  APP_URL: obrigatorioEmProducao('APP_URL').replace(/\/+$/, ''),
};
