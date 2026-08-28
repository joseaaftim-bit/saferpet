'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const { executeQuery } = require('../database');
const { somenteAdmin } = require('../middlewares/autenticacao');
const { cifrar, decifrar, mascarar } = require('../util/cripto');
const { APP_URL } = require('../config/segredos');

const router = express.Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

router.get('/', somenteAdmin, async (req, res, next) => {
  try {
    const [usuarios, config] = await Promise.all([
      executeQuery(
        `SELECT id, nome, email, permissoes, ativo, criado_em
           FROM usuarios WHERE empresa_id = $1 ORDER BY nome`,
        [req.usuario.empresa_id]),
      executeQuery(
        `SELECT aceita_online, mp_access_token, mp_webhook_secret,
                vende_produtos, taxa_entrega_centavos, entrega_gratis_acima_centavos, logo
           FROM empresas WHERE id = $1`,
        [req.usuario.empresa_id]),
    ]);
    const c = config.recordset[0];
    res.json({
      id: req.empresa.id,
      nome: req.empresa.nome,
      whatsapp: req.empresa.whatsapp,
      plano: req.empresa.plano,
      acesso_ate: req.empresa.acesso_ate,
      aceita_online: !!c.aceita_online,
      logo: c.logo || null,
      vende_produtos: !!c.vende_produtos,
      taxa_entrega_centavos: c.taxa_entrega_centavos || 0,
      entrega_gratis_acima_centavos: c.entrega_gratis_acima_centavos,
      // Nunca devolve o segredo: só a marca de que existe e o final dele.
      mp_access_token_final: mascarar(decifrar(c.mp_access_token)),
      mp_webhook_configurado: !!decifrar(c.mp_webhook_secret),
      url_webhook: `${APP_URL}/api/pagamentos/webhook/${req.empresa.id}`,
      usuarios: usuarios.recordset,
    });
  } catch (err) {
    next(err);
  }
});

router.put('/', somenteAdmin, async (req, res, next) => {
  try {
    const { nome, whatsapp, aceita_online, vende_produtos,
            taxa_entrega_centavos, entrega_gratis_acima_centavos, logo } = req.body || {};
    if (!nome || !String(nome).trim()) {
      return res.status(400).json({ erro: 'Informe o nome do petshop.' });
    }

    // Logo: reduzida no navegador, mas o limite vale no servidor.
    let logoValidada;
    if (logo === null || logo === '') {
      logoValidada = null;
    } else if (typeof logo === 'string') {
      if (!/^data:image\/(jpeg|jpg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(logo)) {
        return res.status(400).json({ erro: 'Imagem da logo inválida.' });
      }
      if (logo.length > 400 * 1024) {
        return res.status(413).json({ erro: 'Logo muito grande. Use uma imagem menor.' });
      }
      logoValidada = logo;
    }

    const taxa = taxa_entrega_centavos === undefined ? null : parseInt(taxa_entrega_centavos, 10);
    if (taxa !== null && (!Number.isInteger(taxa) || taxa < 0)) {
      return res.status(400).json({ erro: 'Taxa de entrega inválida.' });
    }
    const gratisAcima = entrega_gratis_acima_centavos === undefined ? undefined
      : (entrega_gratis_acima_centavos === null || entrega_gratis_acima_centavos === ''
        ? null : parseInt(entrega_gratis_acima_centavos, 10));
    if (gratisAcima !== undefined && gratisAcima !== null &&
        (!Number.isInteger(gratisAcima) || gratisAcima < 0)) {
      return res.status(400).json({ erro: 'Valor de frete grátis inválido.' });
    }

    await executeQuery(
      `UPDATE empresas SET nome = $1, whatsapp = $2,
              aceita_online = COALESCE($3, aceita_online),
              vende_produtos = COALESCE($4, vende_produtos),
              taxa_entrega_centavos = COALESCE($5, taxa_entrega_centavos),
              entrega_gratis_acima_centavos = CASE WHEN $6::boolean THEN $7::int
                                                   ELSE entrega_gratis_acima_centavos END,
              logo = CASE WHEN $8::boolean THEN $9 ELSE logo END
        WHERE id = $10`,
      [String(nome).trim(), String(whatsapp || '').trim() || null,
       typeof aceita_online === 'boolean' ? aceita_online : null,
       typeof vende_produtos === 'boolean' ? vende_produtos : null,
       taxa,
       gratisAcima !== undefined, gratisAcima === undefined ? null : gratisAcima,
       logoValidada !== undefined, logoValidada === undefined ? null : logoValidada,
       req.usuario.empresa_id]
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ─── Credenciais do Mercado Pago do petshop ────────────────────────
// Guardadas cifradas; nunca voltam em leitura. Enviar string vazia apaga.

router.put('/pagamento', somenteAdmin, async (req, res, next) => {
  try {
    const { mp_access_token, mp_webhook_secret } = req.body || {};

    if (mp_access_token !== undefined) {
      const valor = String(mp_access_token).trim();
      if (valor && !/^(APP_USR-|TEST-)/.test(valor)) {
        return res.status(400).json({
          erro: 'Access token inválido. Copie o token de produção (APP_USR-…) do painel do Mercado Pago.',
        });
      }
      await executeQuery('UPDATE empresas SET mp_access_token = $1 WHERE id = $2',
        [valor ? cifrar(valor) : null, req.usuario.empresa_id]);
    }

    if (mp_webhook_secret !== undefined) {
      const valor = String(mp_webhook_secret).trim();
      await executeQuery('UPDATE empresas SET mp_webhook_secret = $1 WHERE id = $2',
        [valor ? cifrar(valor) : null, req.usuario.empresa_id]);
    }

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Pagamentos recebidos (para o petshop conferir as vendas online).
router.get('/pagamentos', somenteAdmin, async (req, res, next) => {
  try {
    const r = await executeQuery(
      `SELECT p.id, p.tipo, p.pedido_id, p.valor_centavos, p.status, p.criado_em, p.aprovado_em,
              c.id AS cliente_id, c.nome AS cliente_nome, m.nome AS pacote_nome
         FROM pagamentos p
         JOIN clientes c ON c.id = p.cliente_id
         LEFT JOIN pacotes_modelo m ON m.id = p.modelo_id
        WHERE p.empresa_id = $1
        ORDER BY p.criado_em DESC LIMIT 50`,
      [req.usuario.empresa_id]
    );
    res.json(r.recordset);
  } catch (err) {
    next(err);
  }
});

router.post('/usuarios', somenteAdmin, async (req, res, next) => {
  try {
    const { nome, email, senha, permissoes } = req.body || {};
    const emailLimpo = String(email || '').trim().toLowerCase();
    const papel = permissoes === 'ADMINISTRADOR' ? 'ADMINISTRADOR' : 'ATENDENTE';

    if (!nome || !String(nome).trim()) return res.status(400).json({ erro: 'Informe o nome.' });
    if (!EMAIL_RE.test(emailLimpo)) return res.status(400).json({ erro: 'E-mail inválido.' });
    if (!senha || String(senha).length < 8) {
      return res.status(400).json({ erro: 'A senha precisa ter pelo menos 8 caracteres.' });
    }

    const jaExiste = await executeQuery('SELECT id FROM usuarios WHERE email = $1', [emailLimpo]);
    if (jaExiste.recordset.length) {
      return res.status(409).json({ erro: 'Já existe uma conta com este e-mail.' });
    }

    const senhaHash = await bcrypt.hash(String(senha), 10);
    const r = await executeQuery(
      `INSERT INTO usuarios (empresa_id, nome, email, senha_hash, permissoes)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, nome, email, permissoes, ativo`,
      [req.usuario.empresa_id, String(nome).trim(), emailLimpo, senhaHash, papel]
    );
    res.status(201).json(r.recordset[0]);
  } catch (err) {
    next(err);
  }
});

router.put('/usuarios/:id', somenteAdmin, async (req, res, next) => {
  try {
    const usuarioId = parseInt(req.params.id, 10);
    const { permissoes, ativo, senha } = req.body || {};
    if (!Number.isInteger(usuarioId)) return res.status(404).json({ erro: 'Usuário não encontrado.' });

    if (usuarioId === req.usuario.id && (ativo === false || (permissoes && permissoes !== 'ADMINISTRADOR'))) {
      return res.status(409).json({ erro: 'Você não pode rebaixar ou desativar a si mesmo.' });
    }
    if (permissoes !== undefined && !['ADMINISTRADOR', 'ATENDENTE'].includes(permissoes)) {
      return res.status(400).json({ erro: 'Permissão inválida.' });
    }
    if (senha !== undefined && String(senha).length < 8) {
      return res.status(400).json({ erro: 'A senha precisa ter pelo menos 8 caracteres.' });
    }

    const senhaHash = senha !== undefined ? await bcrypt.hash(String(senha), 10) : null;
    const r = await executeQuery(
      `UPDATE usuarios SET
          permissoes = COALESCE($1, permissoes),
          ativo = COALESCE($2, ativo),
          senha_hash = COALESCE($3, senha_hash)
        WHERE id = $4 AND empresa_id = $5
        RETURNING id, nome, email, permissoes, ativo`,
      [permissoes || null,
       typeof ativo === 'boolean' ? ativo : null,
       senhaHash, usuarioId, req.usuario.empresa_id]
    );
    if (!r.recordset.length) return res.status(404).json({ erro: 'Usuário não encontrado.' });
    res.json(r.recordset[0]);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
