'use strict';

// App do cliente: acesso público por token único (link enviado por
// WhatsApp). Sem senha — o token de 24 bytes aleatórios É a credencial.
// Tudo que sai e entra aqui é filtrado pelo cliente dono do token.

const express = require('express');
const rateLimit = require('express-rate-limit');
const { executeQuery, comTransacao } = require('../database');
const { hojeSaoPaulo } = require('../util/datas');
const { calcularHorariosLivres, criarAgendamento } = require('../util/agendamentos');
const { porTokenDoPortal, porSessao } = require('../middlewares/clienteAuth');
const { responderImagem } = require('../util/imagens');
const { soDigitos, telefoneEmUso, telefoneAtual } = require('../util/telefone');

const router = express.Router();

const DATA_RE = /^\d{4}-\d{2}-\d{2}$/;

// Rotas públicas (só token): limita abuso por IP. Leitura é generosa;
// escrita é apertada.
const limiteLeitura = rateLimit({
  windowMs: 60 * 1000, limit: 120,
  message: { erro: 'Muitas requisições. Aguarde um instante.' },
  standardHeaders: false, legacyHeaders: false, validate: false,
});
const limiteEscrita = rateLimit({
  windowMs: 10 * 60 * 1000, limit: 30,
  message: { erro: 'Muitas tentativas. Aguarde alguns minutos.' },
  standardHeaders: false, legacyHeaders: false, validate: false,
});
router.use(limiteLeitura);

/**
 * Resolve o token e devolve o cliente + empresa. Retorna null (404) para
 * token inválido e { indisponivel: true } (503) quando o petshop está com
 * acesso vencido — o cliente não pode ser punido com erro obscuro.
 */
async function resolverToken(token) {
  return porTokenDoPortal(token);
}

/**
 * As rotas do app do cliente atendem as duas portas: o link (com :token na
 * URL) e a conta (com a sessão no cabeçalho). Uma função só para as duas.
 */
async function resolverCliente(req) {
  if (req.params && req.params.token && req.params.token !== 'conta') {
    return porTokenDoPortal(String(req.params.token));
  }
  return porSessao(req.headers.authorization);
}

function responderToken(res, cliente) {
  if (!cliente) { res.status(404).json({ erro: 'Link inválido.' }); return false; }
  if (cliente.indisponivel) {
    res.status(503).json({ erro: 'Portal temporariamente indisponível. Fale direto com o petshop.' });
    return false;
  }
  return true;
}

// ─── Visão geral do cliente ────────────────────────────────────────

router.get('/:token', async (req, res, next) => {
  try {
    const cliente = await resolverCliente(req);
    if (!responderToken(res, cliente)) return;

    const [pets, pacotes, itens, baixas, agendamentos, servicos, modelos,
           produtos, pedidos, configLoja] = await Promise.all([
      executeQuery(
        `SELECT id, nome, raca, porte FROM pets
          WHERE cliente_id = $1 AND empresa_id = $2 AND ativo ORDER BY nome`,
        [cliente.id, cliente.empresa_id]),
      executeQuery(
        `SELECT id, nome, qtd_banhos, saldo, status, validade_ate FROM pacotes
          WHERE cliente_id = $1 AND empresa_id = $2 AND status IN ('ATIVO', 'ESGOTADO')
          ORDER BY CASE WHEN status = 'ATIVO' THEN 0 ELSE 1 END, criado_em
          LIMIT 3`,
        [cliente.id, cliente.empresa_id]),
      executeQuery(
        `SELECT i.pacote_id, i.servico_id, i.servico_nome, i.quantidade, i.saldo
           FROM pacotes_itens i
           JOIN pacotes p ON p.id = i.pacote_id
          WHERE p.cliente_id = $1 AND i.empresa_id = $2
          ORDER BY i.id`,
        [cliente.id, cliente.empresa_id]),
      executeQuery(
        `SELECT b.servico, b.saldo_apos, b.registrado_em, p.nome AS pet_nome
           FROM baixas b
           JOIN pacotes pa ON pa.id = b.pacote_id
           LEFT JOIN pets p ON p.id = b.pet_id
          WHERE pa.cliente_id = $1 AND b.empresa_id = $2 AND b.estornada = FALSE
          ORDER BY b.registrado_em DESC LIMIT 10`,
        [cliente.id, cliente.empresa_id]),
      executeQuery(
        `SELECT a.id, a.data, a.inicio, a.status, a.tipo, a.agendamento_pai_id,
                p.nome AS pet_nome, s.nome AS servico_nome
           FROM agendamentos a
           LEFT JOIN pets p ON p.id = a.pet_id
           LEFT JOIN servicos s ON s.id = a.servico_id
          WHERE a.cliente_id = $1 AND a.empresa_id = $2
            AND a.status = 'AGENDADO' AND a.data >= $3
          ORDER BY a.data, a.inicio LIMIT 15`,
        [cliente.id, cliente.empresa_id, hojeSaoPaulo()]),
      executeQuery(
        `SELECT id, nome, duracao_minutos, preco_centavos FROM servicos
          WHERE empresa_id = $1 AND ativo ORDER BY nome`,
        [cliente.empresa_id]),
      executeQuery(
        `SELECT id, nome, valor_centavos, validade_meses FROM pacotes_modelo
          WHERE empresa_id = $1 AND ativo AND valor_centavos > 0 ORDER BY valor_centavos`,
        [cliente.empresa_id]),
      // Sem a base64 aqui: a imagem vai por rota própria, cacheada. Antes
      // esta única resposta chegava a megabytes no celular do cliente.
      executeQuery(
        `SELECT id, nome, descricao, preco_centavos, estoque, controla_estoque,
                (foto IS NOT NULL) AS tem_foto, foto_versao
           FROM produtos
          WHERE empresa_id = $1 AND ativo
            AND (NOT controla_estoque OR estoque > 0)
          ORDER BY nome LIMIT 200`,
        [cliente.empresa_id]),
      executeQuery(
        `SELECT p.id, p.valor_centavos, p.status, p.entrega, p.criado_em,
                a.data AS entrega_data, a.inicio AS entrega_inicio
           FROM pedidos p
           LEFT JOIN agendamentos a ON a.id = p.agendamento_id
          WHERE p.cliente_id = $1 AND p.empresa_id = $2
            AND p.status NOT IN ('CANCELADO')
          ORDER BY p.criado_em DESC LIMIT 5`,
        [cliente.id, cliente.empresa_id]),
      executeQuery(
        `SELECT vende_produtos, taxa_entrega_centavos, entrega_gratis_acima_centavos
           FROM empresas WHERE id = $1`,
        [cliente.empresa_id]),
    ]);

    const itensPorPacote = new Map();
    for (const item of itens.recordset) {
      if (!itensPorPacote.has(item.pacote_id)) itensPorPacote.set(item.pacote_id, []);
      itensPorPacote.get(item.pacote_id).push({
        servico_id: item.servico_id, servico_nome: item.servico_nome,
        quantidade: item.quantidade, saldo: item.saldo,
      });
    }

    const comBusca = new Set(
      agendamentos.recordset
        .filter(a => a.tipo === 'BUSCA' && a.agendamento_pai_id)
        .map(a => a.agendamento_pai_id)
    );
    const futuros = agendamentos.recordset
      .filter(a => a.tipo === 'SERVICO')
      .slice(0, 5)
      .map(a => ({
        id: a.id, data: a.data, inicio: a.inicio, status: a.status,
        pet_nome: a.pet_nome, servico_nome: a.servico_nome,
        leva_traz: comBusca.has(a.id),
      }));

    // Itens de modelo, para a vitrine descrever o que o pacote inclui.
    const itensModelo = modelos.recordset.length
      ? await executeQuery(
        `SELECT i.modelo_id, i.quantidade, s.nome AS servico_nome
           FROM pacotes_modelo_itens i JOIN servicos s ON s.id = i.servico_id
          WHERE i.empresa_id = $1 AND s.ativo ORDER BY i.id`,
        [cliente.empresa_id])
      : { recordset: [] };
    const porModelo = new Map();
    for (const item of itensModelo.recordset) {
      if (!porModelo.has(item.modelo_id)) porModelo.set(item.modelo_id, []);
      porModelo.get(item.modelo_id).push(item);
    }

    res.json({
      petshop: {
        nome: cliente.petshop_nome,
        whatsapp: cliente.petshop_whatsapp,
        // O apelido serve para as fotos: no modo conta o <img> não manda
        // cabeçalho, então a imagem sai pela rota pública da vitrine.
        slug: cliente.slug || null,
        tem_logo: !!cliente.tem_logo,
        logo_versao: cliente.logo_versao || null,
        aceita_online: !!cliente.aceita_online,
        // Pagar exige as DUAS credenciais: sem o segredo do webhook o
        // dinheiro sai e o crédito nunca entra.
        pagamento_disponivel: !!cliente.aceita_online &&
          !!cliente.mp_access_token && !!cliente.mp_webhook_secret,
        vende_produtos: !!configLoja.recordset[0].vende_produtos &&
          !!cliente.mp_access_token && !!cliente.mp_webhook_secret,
        taxa_entrega_centavos: configLoja.recordset[0].taxa_entrega_centavos || 0,
        entrega_gratis_acima_centavos: configLoja.recordset[0].entrega_gratis_acima_centavos,
      },
      cliente: {
        nome: cliente.nome, telefone: cliente.telefone,
        email: cliente.email, endereco: cliente.endereco,
      },
      pets: pets.recordset,
      pacotes: pacotes.recordset.map(p => ({ ...p, itens: itensPorPacote.get(p.id) || [] })),
      ultimas_baixas: baixas.recordset,
      agendamentos: futuros,
      servicos: servicos.recordset,
      pacotes_a_venda: modelos.recordset.map(m => ({ ...m, itens: porModelo.get(m.id) || [] })),
      produtos: produtos.recordset.map(p => ({
        id: p.id, nome: p.nome, descricao: p.descricao,
        preco_centavos: p.preco_centavos, estoque: p.estoque,
        controla_estoque: p.controla_estoque,
        tem_foto: !!p.tem_foto, foto_versao: p.foto_versao,
      })),
      pedidos: pedidos.recordset,
    });
  } catch (err) {
    next(err);
  }
});

// ─── Imagens (rotas próprias, cacheadas pelo navegador) ────────────

router.get('/:token/logo', async (req, res, next) => {
  try {
    const cliente = await resolverCliente(req);
    if (!cliente || cliente.indisponivel) return res.status(404).end();
    const r = await executeQuery('SELECT logo FROM empresas WHERE id = $1',
      [cliente.empresa_id]);
    return responderImagem(res, r.recordset[0] && r.recordset[0].logo, req);
  } catch (err) {
    next(err);
  }
});

router.get('/:token/produtos/:id/foto', async (req, res, next) => {
  try {
    const cliente = await resolverCliente(req);
    if (!cliente || cliente.indisponivel) return res.status(404).end();
    const produtoId = parseInt(req.params.id, 10);
    if (!Number.isInteger(produtoId)) return res.status(404).end();
    const r = await executeQuery(
      'SELECT foto FROM produtos WHERE id = $1 AND empresa_id = $2 AND ativo',
      [produtoId, cliente.empresa_id]
    );
    return responderImagem(res, r.recordset[0] && r.recordset[0].foto, req);
  } catch (err) {
    next(err);
  }
});

// ─── Fotos, carteirinha e avaliação (Fase 4) ───────────────────────

router.get('/:token/extras', async (req, res, next) => {
  try {
    const cliente = await resolverCliente(req);
    if (!responderToken(res, cliente)) return;

    const [fotos, vacinas, aAvaliar] = await Promise.all([
      // 6 fotos: cada uma é base64 no corpo da resposta, e o app é aberto
      // no celular em 4G.
      executeQuery(
        `SELECT f.id, f.conteudo, f.legenda, f.criado_em, p.nome AS pet_nome
           FROM fotos f LEFT JOIN pets p ON p.id = f.pet_id
          WHERE f.cliente_id = $1 AND f.empresa_id = $2
          ORDER BY f.criado_em DESC LIMIT 6`,
        [cliente.id, cliente.empresa_id]),
      executeQuery(
        `SELECT v.id, v.nome, v.aplicada_em, v.reforco_em, p.nome AS pet_nome
           FROM vacinas v JOIN pets p ON p.id = v.pet_id
          WHERE p.cliente_id = $1 AND v.empresa_id = $2 AND p.ativo
          ORDER BY v.aplicada_em DESC LIMIT 30`,
        [cliente.id, cliente.empresa_id]),
      executeQuery(
        `SELECT a.id, a.data, s.nome AS servico_nome, p.nome AS pet_nome
           FROM agendamentos a
           LEFT JOIN servicos s ON s.id = a.servico_id
           LEFT JOIN pets p ON p.id = a.pet_id
           LEFT JOIN avaliacoes v ON v.agendamento_id = a.id
          WHERE a.cliente_id = $1 AND a.empresa_id = $2
            AND a.tipo = 'SERVICO' AND a.status = 'CONCLUIDO'
            AND v.id IS NULL
          ORDER BY a.data DESC LIMIT 1`,
        [cliente.id, cliente.empresa_id]),
    ]);

    res.json({
      fotos: fotos.recordset,
      vacinas: vacinas.recordset,
      a_avaliar: aAvaliar.recordset[0] || null,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/:token/avaliar', limiteEscrita, async (req, res, next) => {
  try {
    const cliente = await resolverCliente(req);
    if (!responderToken(res, cliente)) return;

    const agendamentoId = parseInt((req.body || {}).agendamento_id, 10);
    const nota = parseInt((req.body || {}).nota, 10);
    if (!Number.isInteger(agendamentoId) || !Number.isInteger(nota) || nota < 1 || nota > 5) {
      return res.status(400).json({ erro: 'Dê uma nota de 1 a 5.' });
    }

    const ra = await executeQuery(
      `SELECT id FROM agendamentos
        WHERE id = $1 AND empresa_id = $2 AND cliente_id = $3 AND status = 'CONCLUIDO'`,
      [agendamentoId, cliente.empresa_id, cliente.id]
    );
    if (!ra.recordset.length) return res.status(404).json({ erro: 'Atendimento não encontrado.' });

    try {
      await executeQuery(
        `INSERT INTO avaliacoes (empresa_id, cliente_id, agendamento_id, nota, comentario)
         VALUES ($1, $2, $3, $4, $5)`,
        [cliente.empresa_id, cliente.id, agendamentoId, nota,
         String((req.body || {}).comentario || '').trim().slice(0, 500) || null]
      );
    } catch (err) {
      // Índice único (23505) = já avaliado. Outro erro é falha de verdade
      // e não pode ser reportado ao cliente como "já avaliou".
      if (err && (err.code === '23505' || /duplic|unique/i.test(err.message || ''))) {
        return res.status(409).json({ erro: 'Você já avaliou este atendimento.' });
      }
      throw err;
    }
    res.status(201).json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Cliente entra na fila de encaixe de um dia cheio.
router.post('/:token/fila', limiteEscrita, async (req, res, next) => {
  try {
    const cliente = await resolverCliente(req);
    if (!responderToken(res, cliente)) return;
    if (!cliente.aceita_online) {
      return res.status(409).json({ erro: 'Este petshop não aceita pedidos pelo aplicativo.' });
    }

    const servicoId = parseInt((req.body || {}).servico_id, 10);
    const data = String((req.body || {}).data || '');
    const petId = (req.body || {}).pet_id ? parseInt((req.body || {}).pet_id, 10) : null;
    const periodo = ['MANHA', 'TARDE', 'QUALQUER'].includes((req.body || {}).periodo)
      ? (req.body || {}).periodo : 'QUALQUER';

    if (!Number.isInteger(servicoId) || !DATA_RE.test(data)) {
      return res.status(400).json({ erro: 'Informe o serviço e o dia.' });
    }
    if (data < hojeSaoPaulo()) return res.status(400).json({ erro: 'Escolha um dia futuro.' });

    const rs = await executeQuery(
      'SELECT id FROM servicos WHERE id = $1 AND empresa_id = $2 AND ativo',
      [servicoId, cliente.empresa_id]
    );
    if (!rs.recordset.length) return res.status(404).json({ erro: 'Serviço não encontrado.' });

    if (petId !== null) {
      const rp = await executeQuery(
        'SELECT id FROM pets WHERE id = $1 AND empresa_id = $2 AND cliente_id = $3 AND ativo',
        [petId, cliente.empresa_id, cliente.id]
      );
      if (!rp.recordset.length) return res.status(400).json({ erro: 'Pet não confere.' });
    }

    const jaNaFila = await executeQuery(
      `SELECT id FROM fila_espera
        WHERE cliente_id = $1 AND empresa_id = $2 AND servico_id = $3
          AND data = $4 AND status = 'ESPERANDO'`,
      [cliente.id, cliente.empresa_id, servicoId, data]
    );
    if (jaNaFila.recordset.length) {
      return res.status(409).json({ erro: 'Você já está na fila deste dia.' });
    }

    const r = await executeQuery(
      `INSERT INTO fila_espera (empresa_id, cliente_id, pet_id, servico_id, data, periodo)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, data, periodo`,
      [cliente.empresa_id, cliente.id, petId, servicoId, data, periodo]
    );
    res.status(201).json(r.recordset[0]);
  } catch (err) {
    next(err);
  }
});

// ─── Cliente atualiza os próprios dados (endereço do leva-e-traz) ──

router.put('/:token/dados', limiteEscrita, async (req, res, next) => {
  try {
    const cliente = await resolverCliente(req);
    if (!responderToken(res, cliente)) return;

    const { telefone, email, endereco } = req.body || {};

    // O telefone é o login da conta: não pode colidir com outro cliente
    // do mesmo petshop, senão a entrada fica ambígua.
    const digitos = soDigitos(telefone);
    const anterior = await telefoneAtual(executeQuery, cliente.empresa_id, cliente.id);
    if (digitos !== anterior &&
        await telefoneEmUso(executeQuery, cliente.empresa_id, digitos, cliente.id)) {
      return res.status(409).json({
        erro: 'Este telefone já está cadastrado no petshop. Fale com eles para ajustar.',
      });
    }

    await executeQuery(
      `UPDATE clientes SET telefone = $1, telefone_digitos = $2, email = $3, endereco = $4
        WHERE id = $5 AND empresa_id = $6`,
      [String(telefone || '').trim() || null,
       digitos,
       String(email || '').trim() || null,
       String(endereco || '').trim().slice(0, 500) || null,
       cliente.id, cliente.empresa_id]
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ─── Cliente cadastra o próprio pet ────────────────────────────────

router.post('/:token/pets', limiteEscrita, async (req, res, next) => {
  try {
    const cliente = await resolverCliente(req);
    if (!responderToken(res, cliente)) return;

    const nome = String((req.body || {}).nome || '').trim();
    if (!nome) return res.status(400).json({ erro: 'Informe o nome do pet.' });

    const quantos = await executeQuery(
      'SELECT COUNT(*)::int AS total FROM pets WHERE cliente_id = $1 AND empresa_id = $2 AND ativo',
      [cliente.id, cliente.empresa_id]
    );
    if (quantos.recordset[0].total >= 20) {
      return res.status(409).json({ erro: 'Limite de pets atingido. Fale com o petshop.' });
    }

    const r = await executeQuery(
      `INSERT INTO pets (empresa_id, cliente_id, nome, raca, porte)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, nome, raca, porte`,
      [cliente.empresa_id, cliente.id, nome.slice(0, 80),
       String((req.body || {}).raca || '').trim().slice(0, 80) || null,
       String((req.body || {}).porte || '').trim().slice(0, 20) || null]
    );
    res.status(201).json(r.recordset[0]);
  } catch (err) {
    next(err);
  }
});

// ─── Horários livres para o cliente ────────────────────────────────

router.get('/:token/horarios-livres', async (req, res, next) => {
  try {
    const cliente = await resolverCliente(req);
    if (!responderToken(res, cliente)) return;
    if (!cliente.aceita_online) {
      return res.status(409).json({ erro: 'Este petshop não aceita agendamento pelo aplicativo.' });
    }

    const data = String(req.query.data || '');
    const servicoId = parseInt(req.query.servico_id, 10);
    if (!DATA_RE.test(data) || !Number.isInteger(servicoId)) {
      return res.status(400).json({ erro: 'Informe data e serviço.' });
    }
    const resultado = await calcularHorariosLivres(executeQuery, {
      empresaId: cliente.empresa_id,
      data, servicoId,
      levaTraz: String(req.query.leva_traz) === 'true',
    });
    res.json(resultado);
  } catch (err) {
    if (err.statusHttp) return res.status(err.statusHttp).json({ erro: err.message });
    next(err);
  }
});

// ─── Cliente agenda ────────────────────────────────────────────────

router.post('/:token/agendar', limiteEscrita, async (req, res, next) => {
  try {
    const cliente = await resolverCliente(req);
    if (!responderToken(res, cliente)) return;
    if (!cliente.aceita_online) {
      return res.status(409).json({ erro: 'Este petshop não aceita agendamento pelo aplicativo.' });
    }

    const { pet_id, servico_id, data, inicio, leva_traz, observacao } = req.body || {};
    const empresaId = cliente.empresa_id;

    const resultado = await comTransacao(async (query) => {
      await query('SELECT id FROM empresas WHERE id = $1 FOR UPDATE', [empresaId]);

      // Trava simples contra abuso: no máximo 10 agendamentos futuros.
      const abertos = await query(
        `SELECT COUNT(*)::int AS total FROM agendamentos
          WHERE cliente_id = $1 AND empresa_id = $2 AND tipo = 'SERVICO'
            AND status = 'AGENDADO' AND data >= $3`,
        [cliente.id, empresaId, hojeSaoPaulo()]
      );
      if (abertos.recordset[0].total >= 10) {
        throw Object.assign(
          new Error('Você já tem muitos agendamentos abertos. Fale com o petshop.'),
          { statusHttp: 409 }
        );
      }

      // Leva-e-traz pelo app exige endereço cadastrado.
      if (leva_traz === true && !cliente.endereco) {
        throw Object.assign(
          new Error('Cadastre o endereço para pedir busca em casa.'),
          { statusHttp: 400 }
        );
      }

      return criarAgendamento(query, {
        empresaId,
        clienteId: cliente.id,
        petId: pet_id === null || pet_id === undefined || pet_id === '' ? null : parseInt(pet_id, 10),
        servicoId: parseInt(servico_id, 10),
        data: String(data),
        inicio: String(inicio),
        levaTraz: leva_traz === true,
        observacao,
        usuarioId: null,
        origem: 'CLIENTE',
      });
    });

    res.status(201).json(resultado);
  } catch (err) {
    if (err.statusHttp) return res.status(err.statusHttp).json({ erro: err.message });
    next(err);
  }
});

// ─── Cliente cancela o próprio agendamento ─────────────────────────

router.post('/:token/agendamentos/:id/cancelar', async (req, res, next) => {
  try {
    const cliente = await resolverCliente(req);
    if (!responderToken(res, cliente)) return;

    const agendamentoId = parseInt(req.params.id, 10);
    if (!Number.isInteger(agendamentoId)) return res.status(404).json({ erro: 'Agendamento não encontrado.' });

    const resultado = await comTransacao(async (query) => {
      const ra = await query(
        `SELECT id, status, data, tipo FROM agendamentos
          WHERE id = $1 AND empresa_id = $2 AND cliente_id = $3
          FOR UPDATE`,
        [agendamentoId, cliente.empresa_id, cliente.id]
      );
      const ag = ra.recordset[0];
      if (!ag) throw Object.assign(new Error('Agendamento não encontrado.'), { statusHttp: 404 });
      if (ag.status !== 'AGENDADO') {
        throw Object.assign(new Error('Este agendamento não está mais aberto.'), { statusHttp: 409 });
      }
      if (String(ag.data).slice(0, 10) <= hojeSaoPaulo()) {
        throw Object.assign(
          new Error('Para desmarcar hoje ou algo já em andamento, fale com o petshop.'),
          { statusHttp: 409 }
        );
      }

      await query(
        `UPDATE agendamentos SET status = 'CANCELADO' WHERE id = $1 AND empresa_id = $2`,
        [agendamentoId, cliente.empresa_id]
      );
      await query(
        `UPDATE agendamentos SET status = 'CANCELADO'
          WHERE agendamento_pai_id = $1 AND empresa_id = $2 AND status = 'AGENDADO'`,
        [agendamentoId, cliente.empresa_id]
      );
      return { ok: true };
    });

    res.json(resultado);
  } catch (err) {
    if (err.statusHttp) return res.status(err.statusHttp).json({ erro: err.message });
    next(err);
  }
});

module.exports = router;
