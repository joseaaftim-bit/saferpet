'use strict';

// Fotos e logos vivem no banco como data URI base64. Servi-las dentro do
// JSON das listagens fazia a tela inicial do cliente pesar megabytes no
// 4G — agora cada imagem tem rota própria, binária e cacheável.

const crypto = require('crypto');

const DATA_URI = /^data:(image\/(?:jpeg|jpg|png|webp));base64,(.+)$/;

/** Marca curta que muda quando a imagem muda (para o cache do navegador). */
function versaoDe(dataUri) {
  if (!dataUri) return null;
  return crypto.createHash('sha1').update(String(dataUri)).digest('hex').slice(0, 12);
}

/**
 * Responde a imagem como binário, com ETag e cache. Devolve 404 quando não
 * há imagem — o front só pede quando a listagem disse que existe.
 */
function responderImagem(res, dataUri, req) {
  if (!dataUri) return res.status(404).end();
  const m = DATA_URI.exec(String(dataUri));
  if (!m) return res.status(404).end();

  const binario = Buffer.from(m[2], 'base64');
  const etag = '"' + crypto.createHash('sha1').update(binario).digest('hex') + '"';

  if (req && req.headers['if-none-match'] === etag) return res.status(304).end();

  res.set('ETag', etag);
  // Privado: a foto pertence àquele petshop; nada de cache compartilhado.
  res.set('Cache-Control', 'private, max-age=86400');
  res.type(m[1]);
  return res.send(binario);
}

module.exports = { versaoDe, responderImagem };
