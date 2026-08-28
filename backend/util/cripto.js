'use strict';

// Cifra os segredos de terceiros guardados no banco (hoje: credenciais do
// Mercado Pago de cada petshop). AES-256-GCM com nonce por registro.
//
// A chave vem de CRIPTO_CHAVE (32 bytes em hex). Em produção o boot aborta
// sem ela — ver config/segredos.js.

const crypto = require('crypto');
const { CRIPTO_CHAVE } = require('../config/segredos');

const CHAVE = Buffer.from(CRIPTO_CHAVE, 'hex');

function cifrar(texto) {
  if (texto === null || texto === undefined || texto === '') return null;
  const nonce = crypto.randomBytes(12);
  const cifrador = crypto.createCipheriv('aes-256-gcm', CHAVE, nonce);
  const dados = Buffer.concat([cifrador.update(String(texto), 'utf8'), cifrador.final()]);
  const tag = cifrador.getAuthTag();
  return `v1.${nonce.toString('base64url')}.${tag.toString('base64url')}.${dados.toString('base64url')}`;
}

function decifrar(guardado) {
  if (!guardado) return null;
  const partes = String(guardado).split('.');
  if (partes.length !== 4 || partes[0] !== 'v1') return null;
  try {
    const nonce = Buffer.from(partes[1], 'base64url');
    const tag = Buffer.from(partes[2], 'base64url');
    const dados = Buffer.from(partes[3], 'base64url');
    const decifrador = crypto.createDecipheriv('aes-256-gcm', CHAVE, nonce);
    decifrador.setAuthTag(tag);
    return Buffer.concat([decifrador.update(dados), decifrador.final()]).toString('utf8');
  } catch (_err) {
    // Chave trocada ou dado adulterado: trata como ausente, nunca lança
    // para não derrubar rota de leitura.
    console.error('[cripto] Falha ao decifrar um segredo guardado.');
    return null;
  }
}

// Mostra só o final, para a tela de configuração confirmar o que está salvo.
function mascarar(valor) {
  if (!valor) return null;
  const texto = String(valor);
  return texto.length <= 6 ? '••••' : `••••${texto.slice(-6)}`;
}

module.exports = { cifrar, decifrar, mascarar };
