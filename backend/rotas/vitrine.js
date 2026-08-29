'use strict';

// Endereço público do petshop (/salvapatas) e a conta do dono de pet.
// Tudo aqui é aberto — nenhuma rota exige login, porque é justamente onde
// o cliente ainda não tem conta. O que sai é só o que o petshop quer
// mostrar na vitrine; nada de dado de outro cliente.

const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { executeQuery, comTransacao } = require('../database');
const { responderImagem } = require('../util/imagens');
const { gerarTokenCliente } = require('../middlewares/clienteAuth');
const { soDigitos, telefoneValido } = require('../util/telefone');

const router = express.Router();

const emTeste = process.env.NODE_ENV === 'test';

// Cadastro e login são as portas mais atacadas de todo o sistema.
const limiteConta = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: emTeste ? 1000 : 12,
  message: { erro: 'Muitas tentativas. Aguarde alguns minutos.' },
  standardHeaders: false, legacyHeaders: false, validate: false,
});
const limiteVitrine = rateLimit({
  windowMs: 60 * 1000,
  limit: emTeste ? 1000 : 90,
  message: { erro: 'Muitas requisições. Aguarde um instante.' },
  standardHeaders: false, legacyHeaders: false, validate: false,
});


async function petshopPorSlug(slug) {
  const r = await executeQuery(
    `SELECT id, nome, whatsapp, slug, acesso_ate, ativo, aceita_online, vende_produtos,
            (logo IS NOT NULL) AS tem_logo, logo_versao,
            (mp_access_token IS NOT NULL) AS tem_token,
            (mp_webhook_secret IS NOT NULL) AS tem_segredo
       FROM empresas WHERE slug = $1`,
    [String(slug || '').toLowerCase()]
  );
  const petshop = r.recordset[0];
  if (!petshop || !petshop.ativo) return null;
  if (new Date(petshop.acesso_ate).getTime() < Date.now()) return { indisponivel: true };
  return petshop;
}

// ─── Vitrine pública ───────────────────────────────────────────────

router.get('/:slug', limiteVitrine, async (req, res, next) => {
  try {
    const petshop = await petshopPorSlug(req.params.slug);
    if (!petshop) return res.status(404).json({ erro: 'Petshop não encontrado.' });
    if (petshop.indisponivel) {
      return res.status(503).json({ erro: 'Esta página está temporariamente indisponível.' });
    }

    const pagamentoPronto = !!petshop.tem_token && !!petshop.tem_segredo;
    const [servicos, modelos, itensModelo, produtos] = await Promise.all([
      executeQuery(
        `SELECT id, nome, duracao_minutos, preco_centavos FROM servicos
          WHERE empresa_id = $1 AND ativo ORDER BY nome LIMIT 50`,
        [petshop.id]),
      executeQuery(
        `SELECT id, nome, valor_centavos, validade_meses FROM pacotes_modelo
          WHERE empresa_id = $1 AND ativo AND valor_centavos > 0
          ORDER BY valor_centavos LIMIT 20`,
        [petshop.id]),
      executeQuery(
        `SELECT i.modelo_id, i.quantidade, s.nome AS servico_nome
           FROM pacotes_modelo_itens i JOIN servicos s ON s.id = i.servico_id
          WHERE i.empresa_id = $1 AND s.ativo ORDER BY i.id`,
        [petshop.id]),
      executeQuery(
        `SELECT id, nome, descricao, preco_centavos,
                (foto IS NOT NULL) AS tem_foto, foto_versao
           FROM produtos
          WHERE empresa_id = $1 AND ativo AND (NOT controla_estoque OR estoque > 0)
          ORDER BY nome LIMIT 60`,
        [petshop.id]),
    ]);

    const porModelo = new Map();
    for (const item of itensModelo.recordset) {
      if (!porModelo.has(item.modelo_id)) porModelo.set(item.modelo_id, []);
      porModelo.get(item.modelo_id).push(item);
    }

    res.json({
      petshop: {
        nome: petshop.nome,
        slug: petshop.slug,
        whatsapp: petshop.whatsapp,
        tem_logo: !!petshop.tem_logo,
        logo_versao: petshop.logo_versao,
        aceita_online: !!petshop.aceita_online,
        pagamento_disponivel: !!petshop.aceita_online && pagamentoPronto,
        vende_produtos: !!petshop.vende_produtos && pagamentoPronto,
      },
      servicos: servicos.recordset,
      pacotes: modelos.recordset.map(m => ({ ...m, itens: porModelo.get(m.id) || [] })),
      produtos: produtos.recordset,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/:slug/logo', limiteVitrine, async (req, res, next) => {
  try {
    const petshop = await petshopPorSlug(req.params.slug);
    if (!petshop || petshop.indisponivel) return res.status(404).end();
    const r = await executeQuery('SELECT logo FROM empresas WHERE id = $1', [petshop.id]);
    return responderImagem(res, r.recordset[0] && r.recordset[0].logo, req);
  } catch (err) {
    next(err);
  }
});

router.get('/:slug/produtos/:id/foto', limiteVitrine, async (req, res, next) => {
  try {
    const petshop = await petshopPorSlug(req.params.slug);
    if (!petshop || petshop.indisponivel) return res.status(404).end();
    const produtoId = parseInt(req.params.id, 10);
    if (!Number.isInteger(produtoId)) return res.status(404).end();
    const r = await executeQuery(
      'SELECT foto FROM produtos WHERE id = $1 AND empresa_id = $2 AND ativo',
      [produtoId, petshop.id]
    );
    return responderImagem(res, r.recordset[0] && r.recordset[0].foto, req);
  } catch (err) {
    next(err);
  }
});

// ─── Criar conta ───────────────────────────────────────────────────
// Telefone novo: cria o cliente e entra na hora (não há histórico a
// proteger). Telefone JÁ CADASTRADO no petshop: fica pendente até o
// petshop confirmar no balcão — senão qualquer um assumiria o histórico
// de quem tem aquele número.

router.post('/:slug/conta', limiteConta, async (req, res, next) => {
  try {
    const petshop = await petshopPorSlug(req.params.slug);
    if (!petshop) return res.status(404).json({ erro: 'Petshop não encontrado.' });
    if (petshop.indisponivel) {
      return res.status(503).json({ erro: 'Esta página está temporariamente indisponível.' });
    }

    const nome = String((req.body || {}).nome || '').trim();
    const telefone = soDigitos((req.body || {}).telefone);
    const email = String((req.body || {}).email || '').trim().toLowerCase() || null;
    const senha = String((req.body || {}).senha || '');

    if (nome.length < 2) return res.status(400).json({ erro: 'Informe o seu nome.' });
    if (!telefoneValido(telefone)) {
      return res.status(400).json({ erro: 'Informe o telefone com DDD.' });
    }
    if (senha.length < 6) {
      return res.status(400).json({ erro: 'A senha precisa ter pelo menos 6 caracteres.' });
    }

    const senhaHash = await bcrypt.hash(senha, 10);

    const resultado = await comTransacao(async (query) => {
      const existente = await query(
        `SELECT id, nome, conta_ativa FROM clientes
          WHERE empresa_id = $1 AND telefone_digitos = $2 AND ativo
          ORDER BY conta_ativa DESC, id LIMIT 1`,
        [petshop.id, telefone]
      );
      const cliente = existente.recordset[0];

      // Já tem conta com esse telefone: manda entrar, não cria outra.
      if (cliente && cliente.conta_ativa) {
        return { jaTemConta: true };
      }

      // Cadastro do petshop sem conta: precisa da confirmação dele.
      if (cliente) {
        const jaPendente = await query(
          `SELECT id FROM vinculos_pendentes
            WHERE empresa_id = $1 AND cliente_id = $2 AND status = 'PENDENTE'`,
          [petshop.id, cliente.id]
        );
        if (jaPendente.recordset.length) return { pendente: true, repetido: true };

        await query(
          `INSERT INTO vinculos_pendentes (empresa_id, cliente_id, nome, telefone, email, senha_hash)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [petshop.id, cliente.id, nome, telefone, email, senhaHash]
        );
        return { pendente: true };
      }

      // Telefone novo: cliente novo, entra direto.
      const token = crypto.randomBytes(24).toString('base64url');
      const novo = await query(
        `INSERT INTO clientes (empresa_id, nome, telefone, telefone_digitos, email, token_portal,
                               senha_hash, conta_ativa, conta_criada_em)
         VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE, NOW())
         RETURNING id, nome, empresa_id`,
        [petshop.id, nome, telefone, telefone, email, token, senhaHash]
      );
      return { cliente: novo.recordset[0] };
    });

    if (resultado.jaTemConta) {
      return res.status(409).json({
        erro: 'Já existe uma conta com este telefone. Entre com a sua senha.',
        ja_tem_conta: true,
      });
    }
    if (resultado.pendente) {
      return res.status(202).json({
        pendente: true,
        mensagem: resultado.repetido
          ? 'Seu pedido já está com o petshop. Assim que confirmarem, você entra com a sua senha.'
          // Não afirma que aquele número é cliente: a página é pública e
          // qualquer um poderia sondar a agenda do petshop por telefone.
          : `Para proteger o histórico de quem já é cliente, o ${petshop.nome} confere ` +
            'este telefone antes de liberar. Assim que confirmarem, você entra com a senha ' +
            'que acabou de criar.',
      });
    }

    res.status(201).json({
      token: gerarTokenCliente(resultado.cliente),
      cliente: { nome: resultado.cliente.nome },
    });
  } catch (err) {
    // Dois cadastros simultâneos com o mesmo telefone: o índice único
    // derruba o segundo — para quem pediu, é o mesmo "aguarde".
    if (err && err.code === '23505') {
      return res.status(202).json({
        pendente: true,
        mensagem: 'Já existe um pedido de confirmação para este telefone. ' +
          'Fale com o petshop no balcão para concluir o seu acesso.',
      });
    }
    next(err);
  }
});

// ─── Entrar ────────────────────────────────────────────────────────

router.post('/:slug/entrar', limiteConta, async (req, res, next) => {
  try {
    const petshop = await petshopPorSlug(req.params.slug);
    if (!petshop) return res.status(404).json({ erro: 'Petshop não encontrado.' });
    if (petshop.indisponivel) {
      return res.status(503).json({ erro: 'Esta página está temporariamente indisponível.' });
    }

    const telefone = soDigitos((req.body || {}).telefone);
    const senha = String((req.body || {}).senha || '');

    const r = await executeQuery(
      `SELECT id, nome, empresa_id, senha_hash, conta_ativa FROM clientes
        WHERE empresa_id = $1 AND telefone_digitos = $2 AND ativo
        ORDER BY conta_ativa DESC, id LIMIT 1`,
      [petshop.id, telefone]
    );
    const cliente = r.recordset[0];

    // bcrypt roda sempre: telefone inexistente responde no mesmo tempo.
    const referencia = (cliente && cliente.senha_hash) || HASH_DUMMY;
    const senhaOk = await bcrypt.compare(senha, referencia);

    if (!cliente || !cliente.conta_ativa || !senhaOk) {
      return res.status(401).json({ erro: 'Telefone ou senha inválidos.' });
    }

    res.json({
      token: gerarTokenCliente(cliente),
      cliente: { nome: cliente.nome },
    });
  } catch (err) {
    next(err);
  }
});

const HASH_DUMMY = bcrypt.hashSync('senha-dummy-para-tempo-constante', 10);

module.exports = router;
