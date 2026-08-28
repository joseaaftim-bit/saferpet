'use strict';

const express = require('express');
const { executeQuery } = require('../database');

const router = express.Router();

// Limites do dia no fuso de São Paulo, em UTC, calculados no JS para o
// SQL ficar portátil (registrado_em >= $2 AND registrado_em < $3).
function limitesDeHoje() {
  const fmt = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Sao_Paulo' });
  const hoje = fmt.format(new Date()); // AAAA-MM-DD

  // Offset atual do fuso em relação ao UTC (ex.: -03:00 / -02:00).
  const partes = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Sao_Paulo', timeZoneName: 'longOffset',
  }).formatToParts(new Date());
  const offset = (partes.find(p => p.type === 'timeZoneName') || {}).value || 'GMT-03:00';
  const m = offset.match(/GMT([+-]\d{2}):(\d{2})/);
  const offsetTexto = m ? `${m[1]}:${m[2]}` : '-03:00';

  const inicio = new Date(`${hoje}T00:00:00${offsetTexto}`);
  const fim = new Date(inicio.getTime() + 24 * 60 * 60 * 1000);
  return { inicio: inicio.toISOString(), fim: fim.toISOString() };
}

router.get('/', async (req, res, next) => {
  try {
    const { inicio, fim } = limitesDeHoje();
    const empresaId = req.usuario.empresa_id;

    const hoje = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Sao_Paulo' }).format(new Date());

    const [banhosHoje, agendadosHoje, retiradasHoje, pacotesAtivos, acabando, clientes] = await Promise.all([
      executeQuery(
        `SELECT COUNT(*)::int AS total FROM baixas
          WHERE empresa_id = $1 AND estornada = FALSE
            AND registrado_em >= $2 AND registrado_em < $3`,
        [empresaId, inicio, fim]
      ),
      executeQuery(
        `SELECT COUNT(*)::int AS total FROM agendamentos
          WHERE empresa_id = $1 AND data = $2 AND tipo = 'SERVICO'
            AND status IN ('AGENDADO', 'CONCLUIDO')`,
        [empresaId, hoje]
      ),
      executeQuery(
        `SELECT COUNT(*)::int AS total FROM agendamentos
          WHERE empresa_id = $1 AND data = $2 AND tipo IN ('BUSCA', 'ENTREGA')
            AND status = 'AGENDADO'`,
        [empresaId, hoje]
      ),
      executeQuery(
        `SELECT COUNT(*)::int AS total FROM pacotes
          WHERE empresa_id = $1 AND status = 'ATIVO'`,
        [empresaId]
      ),
      executeQuery(
        `SELECT COUNT(*)::int AS total FROM pacotes
          WHERE empresa_id = $1 AND status = 'ATIVO' AND saldo <= 3`,
        [empresaId]
      ),
      executeQuery(
        `SELECT COUNT(*)::int AS total FROM clientes
          WHERE empresa_id = $1 AND ativo`,
        [empresaId]
      ),
    ]);

    res.json({
      banhos_hoje: banhosHoje.recordset[0].total,
      agendados_hoje: agendadosHoje.recordset[0].total,
      retiradas_hoje: retiradasHoje.recordset[0].total,
      pacotes_ativos: pacotesAtivos.recordset[0].total,
      saldos_acabando: acabando.recordset[0].total,
      clientes_ativos: clientes.recordset[0].total,
    });
  } catch (err) {
    next(err);
  }
});

// ─── O que falta para o app do cliente ficar completo ──────────────
// O petshop não tem como adivinhar por que um botão não aparece para o
// cliente. Esta rota responde exatamente isso.

router.get('/ativacao', async (req, res, next) => {
  try {
    const empresaId = req.usuario.empresa_id;
    const [servicos, modelos, produtos, config, clientes] = await Promise.all([
      executeQuery('SELECT COUNT(*)::int AS total FROM servicos WHERE empresa_id = $1 AND ativo',
        [empresaId]),
      executeQuery(`SELECT COUNT(*)::int AS total FROM pacotes_modelo
                     WHERE empresa_id = $1 AND ativo AND valor_centavos > 0`, [empresaId]),
      executeQuery('SELECT COUNT(*)::int AS total FROM produtos WHERE empresa_id = $1 AND ativo',
        [empresaId]),
      executeQuery(`SELECT aceita_online, vende_produtos,
                           (mp_access_token IS NOT NULL) AS tem_token,
                           (mp_webhook_secret IS NOT NULL) AS tem_segredo
                      FROM empresas WHERE id = $1`, [empresaId]),
      executeQuery('SELECT COUNT(*)::int AS total FROM clientes WHERE empresa_id = $1 AND ativo',
        [empresaId]),
    ]);

    const c = config.recordset[0];
    const temServico = servicos.recordset[0].total > 0;
    const temModelo = modelos.recordset[0].total > 0;
    const temProduto = produtos.recordset[0].total > 0;
    const pagamentoPronto = !!c.tem_token && !!c.tem_segredo;

    const passos = [
      {
        chave: 'servicos',
        titulo: 'Cadastrar os serviços',
        descricao: 'Banho, tosa, consulta — cada um com a duração que o seu petshop leva.',
        onde: '#/catalogo',
        pronto: temServico,
      },
      {
        chave: 'pacotes',
        titulo: 'Montar os pacotes com preço',
        descricao: 'Ex.: 24 banhos por R$ 700. Sem preço, o cliente não consegue comprar pelo app.',
        onde: '#/catalogo',
        pronto: temModelo,
      },
      {
        chave: 'online',
        titulo: 'Liberar o app para o cliente',
        descricao: 'Em Configurações, ligar "Deixar o cliente agendar e comprar pelo aplicativo".',
        onde: '#/config',
        pronto: !!c.aceita_online,
      },
      {
        chave: 'pagamento',
        titulo: 'Conectar o Mercado Pago',
        descricao: 'O access token e a chave do webhook do SEU Mercado Pago — o dinheiro cai na sua conta.',
        onde: '#/config',
        pronto: pagamentoPronto,
      },
      {
        chave: 'loja',
        titulo: 'Vender produtos (opcional)',
        descricao: 'Ligar a loja em Configurações e cadastrar os produtos com foto.',
        onde: '#/loja',
        pronto: !!c.vende_produtos && temProduto,
        opcional: true,
      },
      {
        chave: 'clientes',
        titulo: 'Cadastrar os clientes',
        descricao: 'Cada cliente recebe um link próprio para acompanhar tudo pelo celular.',
        onde: '#/clientes',
        pronto: clientes.recordset[0].total > 0,
      },
    ];

    // O que o cliente enxerga HOJE, com a configuração atual.
    const cliente_ve = {
      saldo: true,
      agendar: !!c.aceita_online && temServico,
      comprar_pacote: !!c.aceita_online && pagamentoPronto && temModelo,
      loja: !!c.vende_produtos && pagamentoPronto && temProduto,
    };

    const obrigatorios = passos.filter(p => !p.opcional);
    res.json({
      passos,
      cliente_ve,
      completo: obrigatorios.every(p => p.pronto),
      faltam: obrigatorios.filter(p => !p.pronto).length,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
