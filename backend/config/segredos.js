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

  // Credenciais do Mercado Pago DA SAFERSOFTWARE, para cobrar a
  // assinatura dos petshops. Diferente das credenciais de cada petshop
  // (que cobram o cliente final). Sem elas, a tela de assinatura avisa
  // que a renovação ainda não está disponível.
  MP_ACCESS_TOKEN: process.env.MP_ACCESS_TOKEN || null,
  MP_WEBHOOK_SECRET: process.env.MP_WEBHOOK_SECRET || null,

  // Cifra as credenciais de Mercado Pago de cada petshop guardadas no
  // banco. Opcional: sem ela, deriva do JWT_SECRET (que já é forte e
  // secreto) — assim nenhum ambiente quebra por falta de variável nova.
  // Trocar a chave (ou o JWT_SECRET, quando derivada) invalida as
  // credenciais salvas e cada petshop precisa recadastrar.
  CRIPTO_CHAVE: resolverChaveCripto(),
};

function resolverChaveCripto() {
  const informada = process.env.CRIPTO_CHAVE;
  if (informada) {
    if (!/^[0-9a-f]{64}$/i.test(informada)) {
      console.error('[boot] FATAL: CRIPTO_CHAVE precisa ter 32 bytes em hex (64 caracteres).');
      process.exit(1);
    }
    return informada;
  }
  const base = process.env.JWT_SECRET || DEV_DEFAULTS.JWT_SECRET;
  return require('crypto')
    .createHash('sha256')
    .update(`saferpet-cripto-v1:${base}`)
    .digest('hex');
}
