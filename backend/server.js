'use strict';

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, 'config', '.env') });

const express = require('express');
const compression = require('compression');
const { getPool, executeQuery } = require('./database');
const { migrar } = require('./migrate');
const { validarJwt, exigirAcessoVigente } = require('./middlewares/autenticacao');
const { iniciarJobs } = require('./jobs/expiracao');

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
// Comprime as respostas: o app do cliente é aberto no celular, em 4G.
app.use(compression());
app.use(express.json({ limit: '1mb' }));

// ─── Saúde: precisa tocar o banco de verdade ───────────────────────
app.get('/api/health', async (_req, res) => {
  try {
    await executeQuery('SELECT 1 AS ok');
    res.json({ status: 'ok' });
  } catch (_err) {
    res.status(503).json({ status: 'banco indisponível' });
  }
});

// ─── API ───────────────────────────────────────────────────────────
app.use('/api/auth', require('./rotas/auth'));
app.use('/api/portal', require('./rotas/portal'));
app.use('/api/vitrine', require('./rotas/vitrine'));
app.use('/api/pagamentos', require('./rotas/pagamentos'));
app.use('/api/hub', require('./rotas/hub'));
app.use('/api/assinatura', require('./rotas/assinatura'));

// Rotas de negócio: autenticado + acesso do petshop vigente.
const protegido = [validarJwt, exigirAcessoVigente];
app.use('/api/clientes', protegido, require('./rotas/clientes'));
app.use('/api/pets', protegido, require('./rotas/pets'));
app.use('/api/servicos', protegido, require('./rotas/servicos'));
app.use('/api/pacotes', protegido, require('./rotas/pacotes'));
app.use('/api/baixas', protegido, require('./rotas/baixas'));
app.use('/api/agenda', protegido, require('./rotas/agenda'));
app.use('/api/loja', protegido, require('./rotas/loja'));
app.use('/api/extras', protegido, require('./rotas/extras'));
app.use('/api/dashboard', protegido, require('./rotas/dashboard'));
app.use('/api/empresa', protegido, require('./rotas/empresa'));

app.use('/api', (_req, res) => res.status(404).json({ erro: 'Rota não encontrada.' }));

// ─── Front estático (mesma origem, sem build) ──────────────────────
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
app.use(express.static(PUBLIC_DIR));
app.get('/app', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'app.html')));
app.get('/entrar', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'entrar.html')));
app.get('/portal/:token', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'portal.html')));
// Endereço público do petshop: /salvapatas. Vem por último, depois dos
// arquivos estáticos, para não engolir /js, /estilo.css e afins.
app.get('/:slug', (req, res, next) => {
  if (/[./]/.test(req.params.slug)) return next();
  res.sendFile(path.join(PUBLIC_DIR, 'vitrine.html'));
});

// ─── Erros: log completo no servidor, mensagem genérica para fora ──
app.use((err, _req, res, _next) => {
  console.error('[erro]', err);
  res.status(500).json({ erro: 'Erro interno. Tente novamente.' });
});

async function iniciar() {
  const pool = getPool();
  await migrar(pool);
  if (process.env.NODE_ENV !== 'test') iniciarJobs();

  const porta = parseInt(process.env.PORT || '4600', 10);
  return new Promise((resolve) => {
    const servidor = app.listen(porta, () => {
      console.log(`[boot] SaferPet no ar na porta ${porta}.`);
      resolve(servidor);
    });
  });
}

module.exports = { app, iniciar };

if (require.main === module) {
  iniciar().catch(err => {
    console.error('[boot] Falha ao subir:', err);
    process.exit(1);
  });
}
