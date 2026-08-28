'use strict';

// Métricas para o Safer Hub (painel super-admin da fábrica).
// Cross-tenant por natureza, por isso fecha por padrão: sem segredo
// configurado responde 503; segredo errado responde 401. Nunca devolve
// dado de cliente final — só contagens e a lista de petshops.

const express = require('express');
const crypto = require('crypto');
const { executeQuery } = require('../database');
const { HUB_TOKEN } = require('../config/segredos');
const { planoDe } = require('../config/planos');

const router = express.Router();

// O Hub manda x-hub-secret; o Bearer continua aceito por compatibilidade
// com o que já está configurado no Railway.
function segredoDaRequisicao(req) {
  const header = req.headers['x-hub-secret'];
  if (header) return String(header);
  const auth = req.headers.authorization || '';
  return auth.startsWith('Bearer ') ? auth.slice(7) : null;
}

function segredoConfere(recebido) {
  if (!recebido || !HUB_TOKEN) return false;
  const a = Buffer.from(String(recebido));
  const b = Buffer.from(HUB_TOKEN);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

router.get('/metrics', async (req, res, next) => {
  try {
    if (!HUB_TOKEN) {
      return res.status(503).json({ erro: 'Hub não configurado neste ambiente.' });
    }
    if (!segredoConfere(segredoDaRequisicao(req))) {
      return res.status(401).json({ erro: 'Não autorizado.' });
    }

    const semanaAtras = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const seteDias = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const trintaDias = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    const [empresas, assinaturas, uso] = await Promise.all([
      executeQuery(
        `SELECT e.id, e.nome, e.plano, e.acesso_ate, e.criado_em,
                e.mp_access_token IS NOT NULL AS pagamento_configurado,
                e.aceita_online, e.vende_produtos
           FROM empresas e
          WHERE e.ativo
          ORDER BY e.criado_em DESC`),
      executeQuery(
        `SELECT empresa_id, periodo, valor_centavos, aprovado_em
           FROM assinaturas
          WHERE status = 'APROVADO'
          ORDER BY aprovado_em DESC`),
      Promise.all([
        // Contagens em queries próprias: subquery escalar não é portátil.
        executeQuery('SELECT COUNT(*)::int AS total FROM clientes WHERE ativo'),
        executeQuery(`SELECT COUNT(*)::int AS total FROM pacotes WHERE status = 'ATIVO'`),
        executeQuery(
          `SELECT COUNT(*)::int AS total FROM baixas
            WHERE estornada = FALSE AND registrado_em >= $1`, [trintaDias]),
        executeQuery(
          `SELECT COUNT(*)::int AS total FROM agendamentos
            WHERE status IN ('AGENDADO','CONCLUIDO') AND criado_em >= $1`, [trintaDias]),
        executeQuery(
          `SELECT COALESCE(SUM(valor_centavos), 0)::bigint AS valor FROM pacotes
            WHERE criado_em >= $1`, [trintaDias]),
        executeQuery(
          `SELECT COALESCE(SUM(valor_centavos), 0)::bigint AS valor FROM pedidos
            WHERE status IN ('PAGO','SEPARADO','EM_ROTA','ENTREGUE') AND criado_em >= $1`,
          [trintaDias]),
      ]),
    ]);

    const agora = Date.now();
    const ultimaPorEmpresa = new Map();
    for (const a of assinaturas.recordset) {
      if (!ultimaPorEmpresa.has(a.empresa_id)) ultimaPorEmpresa.set(a.empresa_id, a);
    }

    let mrrCentavos = 0;
    let ativos = 0;
    let emTrial = 0;
    let trialExpirando = 0;
    let novasSemana = 0;

    const usuarios = empresas.recordset.map(e => {
      const vigente = new Date(e.acesso_ate).getTime() >= agora;
      const pagante = ultimaPorEmpresa.has(e.id);

      if (vigente && pagante) {
        ativos += 1;
        // MRR: mensal conta cheio; anual entra rateado no mês.
        const assinatura = ultimaPorEmpresa.get(e.id);
        const plano = planoDe(assinatura.periodo);
        if (plano) {
          mrrCentavos += plano.periodo === 'ANUAL'
            ? Math.round(plano.valor_centavos / 12)
            : plano.valor_centavos;
        }
      } else if (vigente) {
        emTrial += 1;
        if (new Date(e.acesso_ate).toISOString() <= seteDias) trialExpirando += 1;
      }
      if (new Date(e.criado_em).toISOString() >= semanaAtras) novasSemana += 1;

      return {
        id: e.id,
        nome: e.nome,
        plano: pagante ? e.plano : 'TRIAL',
        situacao: vigente ? (pagante ? 'ativo' : 'trial') : 'vencido',
        acesso_ate: e.acesso_ate,
        criado_em: e.criado_em,
        pagamento_configurado: !!e.pagamento_configurado,
        app_do_cliente: !!e.aceita_online,
        loja: !!e.vende_produtos,
      };
    });

    const total = usuarios.length;
    const [rClientes, rPacotes, rServicos, rAgendamentos, rGmvPacotes, rGmvPedidos] = uso;
    const gmv = Number(rGmvPacotes.recordset[0].valor) + Number(rGmvPedidos.recordset[0].valor);

    res.json({
      produto: 'SaferPet',
      timestamp: new Date().toISOString(),
      kpis: {
        total,
        emTrial,
        trialExpirando,
        ativos,
        mrr: Number((mrrCentavos / 100).toFixed(2)),
        taxaConversao: total ? Number(((ativos / total) * 100).toFixed(1)) : 0,
        novasSemana,
      },
      // Números do negócio dos petshops — o que o SaferPet move por mês.
      operacao: {
        clientes: rClientes.recordset[0].total,
        pacotes_ativos: rPacotes.recordset[0].total,
        servicos_30_dias: rServicos.recordset[0].total,
        agendamentos_30_dias: rAgendamentos.recordset[0].total,
        gmv_30_dias: Number((gmv / 100).toFixed(2)),
      },
      usuarios,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
