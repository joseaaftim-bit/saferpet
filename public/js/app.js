'use strict';

// SaferPet — painel do petshop. Vanilla JS, sem build: roteador por hash,
// fetch autenticado e renderização por template string (sempre com esc()).

(function () {
  const conteudo = document.getElementById('conteudo');
  const areaModal = document.getElementById('area-modal');
  const areaToast = document.getElementById('area-toast');

  // Endereço público mostrado ao lado do apelido do petshop.
  const BASE_PUBLICA = window.location.host;

  let sessao = null;          // { usuario, empresa } vindo de /api/auth/me
  let servicosCache = null;   // catálogo de serviços (invalidado ao editar)

  // ─── Utilitários ─────────────────────────────────────────────────

  function esc(texto) {
    return String(texto === null || texto === undefined ? '' : texto)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function hojeISO() {
    return new Date().toLocaleDateString('sv-SE');
  }

  function somarDiasISO(iso, n) {
    const d = new Date(`${iso}T12:00:00`);
    d.setDate(d.getDate() + n);
    return d.toLocaleDateString('sv-SE');
  }

  /**
   * Data de calendário (coluna DATE) vem como 'AAAA-MM-DD' — ou, em alguns
   * drivers, como meia-noite UTC. Nos dois casos ancoramos ao meio-dia
   * local, senão o fuso empurra para o dia anterior. Timestamp de verdade
   * (hora do registro) é convertido normalmente.
   */
  function ehDataDeCalendario(texto) {
    return /^\d{4}-\d{2}-\d{2}$/.test(texto) || /^\d{4}-\d{2}-\d{2}T00:00:00(\.000)?Z$/.test(texto);
  }

  function dataCurta(valor) {
    if (!valor) return '—';
    const texto = String(valor);
    const d = ehDataDeCalendario(texto)
      ? new Date(`${texto.slice(0, 10)}T12:00:00`)
      : new Date(valor);
    return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
  }

  function dataLonga(iso) {
    if (!iso) return '—';
    return new Date(`${String(iso).slice(0, 10)}T12:00:00`).toLocaleDateString('pt-BR');
  }

  function dataExtensa(iso) {
    return new Date(`${iso}T12:00:00`).toLocaleDateString('pt-BR', {
      weekday: 'long', day: '2-digit', month: '2-digit',
    });
  }

  function horaCurta(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  }

  function paraMin(hhmm) {
    const [h, m] = String(hhmm).split(':').map(Number);
    return h * 60 + m;
  }

  function formatarReais(centavos) {
    return (Number(centavos || 0) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  }

  function paraCentavos(texto) {
    const limpo = String(texto || '').replace(/[^\d,\.]/g, '').replace(/\./g, '').replace(',', '.');
    const valor = parseFloat(limpo);
    return Number.isFinite(valor) ? Math.round(valor * 100) : NaN;
  }

  function toast(texto, ehErro) {
    const el = document.createElement('div');
    el.className = 'toast' + (ehErro ? ' erro' : '');
    el.textContent = texto;
    areaToast.appendChild(el);
    setTimeout(() => el.remove(), 4000);
  }

  function sair() {
    localStorage.removeItem('saferpet_token');
    window.location.href = '/';
  }

  async function api(caminho, opcoes = {}) {
    const resp = await fetch(`/api${caminho}`, {
      ...opcoes,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${localStorage.getItem('saferpet_token') || ''}`,
        ...(opcoes.headers || {}),
      },
      body: opcoes.body ? JSON.stringify(opcoes.body) : undefined,
    });
    if (resp.status === 401) { sair(); throw new Error('Sessão expirada.'); }
    const dados = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const err = new Error(dados.erro || 'Algo deu errado. Tente novamente.');
      err.status = resp.status;
      throw err;
    }
    return dados;
  }

  async function carregarServicos(forcar) {
    if (!servicosCache || forcar) servicosCache = await api('/servicos');
    return servicosCache;
  }

  function ehAdmin() {
    return sessao && sessao.usuario.permissoes === 'ADMINISTRADOR';
  }

  // ─── Modal genérico ──────────────────────────────────────────────

  function abrirModal(html) {
    fecharModal();
    const fundo = document.createElement('div');
    fundo.className = 'modal-fundo';
    fundo.innerHTML = `<div class="modal">${html}</div>`;
    fundo.addEventListener('click', (ev) => { if (ev.target === fundo) fecharModal(); });
    areaModal.appendChild(fundo);
    const modal = fundo.querySelector('.modal');
    if (typeof pintarImagens === 'function') pintarImagens(modal);
    return modal;
  }

  function fecharModal() {
    areaModal.innerHTML = '';
  }

  function rodapeModal(textoConfirmar) {
    return `
      <div style="display: flex; gap: 10px; justify-content: flex-end; margin-top: 4px">
        <button type="button" class="btn-fantasma" data-fechar>Cancelar</button>
        <button type="submit" class="btn-primario">${esc(textoConfirmar)}</button>
      </div>`;
  }

  function ligarFechar(modal) {
    modal.querySelectorAll('[data-fechar]').forEach(b => b.addEventListener('click', fecharModal));
  }

  // Protege contra duplo clique: desabilita o botão de envio enquanto a
  // requisição roda (no sucesso o modal fecha; no erro, reabilita).
  function aoEnviar(form, handler) {
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const botao = form.querySelector('[type="submit"]');
      if (botao && botao.disabled) return;
      if (botao) botao.disabled = true;
      try {
        await handler(ev);
      } finally {
        if (botao) botao.disabled = false;
      }
    });
  }

  function barraSaldo(saldo, total, largura) {
    const pct = total > 0 ? Math.round((saldo / total) * 100) : 0;
    const classe = saldo <= 3 ? 'baixa' : '';
    return `<div class="barra" style="width: ${largura || 130}px"><div class="${classe}" style="width: ${pct}%"></div></div>`;
  }

  const ICONES = {
    banho: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.5c3.2 3.9 6 7.2 6 10.2a6 6 0 0 1-12 0c0-3 2.8-6.3 6-10.2z"></path></svg>',
    pata: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="15.5" rx="4.2" ry="3.4"></ellipse><circle cx="6.2" cy="10.4" r="1.9"></circle><circle cx="10" cy="7.2" r="1.9"></circle><circle cx="14" cy="7.2" r="1.9"></circle><circle cx="17.8" cy="10.4" r="1.9"></circle></svg>',
    alerta: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><path d="M12 7.5v5.5"></path><path d="M12 16.4v.1"></path></svg>',
    agenda: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="5" width="17" height="16" rx="2.5"></rect><path d="M8 3v4"></path><path d="M16 3v4"></path><path d="M3.5 10h17"></path></svg>',
    van: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 7h11v10h-11z"></path><path d="M13.5 10h4.2l3 3.2V17h-7.2"></path><circle cx="6.5" cy="17.5" r="1.8"></circle><circle cx="17" cy="17.5" r="1.8"></circle></svg>',
  };

  // ─── Créditos por serviço (a partir da ficha) ────────────────────

  function creditosDisponiveis(ficha) {
    const hoje = hojeISO();
    const totais = new Map(); // servico_id -> { nome, total }
    for (const p of ficha.pacotes || []) {
      if (p.status !== 'ATIVO') continue;
      if (p.validade_ate && String(p.validade_ate).slice(0, 10) < hoje) continue;
      for (const item of p.itens || []) {
        if (!item.saldo) continue;
        const atual = totais.get(item.servico_id) || { nome: item.servico_nome, total: 0 };
        atual.total += item.saldo;
        totais.set(item.servico_id, atual);
      }
    }
    return totais;
  }

  function pacoteEmConsumo(pacotes) {
    const ativos = (pacotes || []).filter(p => p.status === 'ATIVO');
    return ativos.length ? ativos[ativos.length - 1] : null;
  }


  // ─── Dica de campo ───────────────────────────────────────────────
  // O "?" ao lado do rótulo. Um único balão no documento, posicionado
  // ao lado do botão. Hover no computador, toque no celular (a dona do
  // petshop usa celular — hover não existe lá), Escape fecha.

  function dica(texto) {
    return `<button type="button" class="dica" data-dica="${esc(texto)}"
      aria-label="Ajuda: ${esc(texto)}" tabindex="0">?</button>`;
  }

  let balaoDica = null;
  let dicaAbertaPor = null;   // o botão dono do balão atual
  let dicaAbertaEm = 0;       // quando abriu (para o toque não fechar o que abriu)

  function fecharDica() {
    if (balaoDica) { balaoDica.remove(); balaoDica = null; dicaAbertaPor = null; }
  }

  function abrirDica(botao) {
    fecharDica();
    dicaAbertaPor = botao;
    dicaAbertaEm = Date.now();
    balaoDica = document.createElement('div');
    balaoDica.className = 'dica-balao';
    balaoDica.setAttribute('role', 'tooltip');
    balaoDica.textContent = botao.dataset.dica;
    document.body.appendChild(balaoDica);

    // Acima do botão quando couber; abaixo quando não couber.
    const alvo = botao.getBoundingClientRect();
    const balao = balaoDica.getBoundingClientRect();
    let x = alvo.left + alvo.width / 2 - balao.width / 2;
    x = Math.max(10, Math.min(x, window.innerWidth - balao.width - 10));
    let y = alvo.top - balao.height - 8;
    if (y < 10) y = alvo.bottom + 8;
    balaoDica.style.left = `${x}px`;
    balaoDica.style.top = `${y}px`;
  }

  document.addEventListener('mouseover', (ev) => {
    const botao = ev.target.closest && ev.target.closest('.dica');
    if (botao) abrirDica(botao);
  });
  document.addEventListener('mouseout', (ev) => {
    if (ev.target.closest && ev.target.closest('.dica')) fecharDica();
  });
  document.addEventListener('click', (ev) => {
    const botao = ev.target.closest && ev.target.closest('.dica');
    if (botao) {
      ev.preventDefault();
      // No celular, o toque dispara um mouseover sintético ANTES do click —
      // o click do mesmo gesto não pode fechar o balão que acabou de abrir.
      const doMesmoGesto = dicaAbertaPor === botao && Date.now() - dicaAbertaEm < 500;
      if (balaoDica && dicaAbertaPor === botao && !doMesmoGesto) fecharDica();
      else abrirDica(botao);
      return;
    }
    fecharDica();
  });
  document.addEventListener('focusin', (ev) => {
    const botao = ev.target.closest && ev.target.closest('.dica');
    if (botao) abrirDica(botao); else fecharDica();
  });
  document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') fecharDica(); });
  window.addEventListener('scroll', () => {
    // Rolagem provocada pelo próprio foco no "?" reposiciona; o resto fecha.
    if (dicaAbertaPor && document.activeElement === dicaAbertaPor) abrirDica(dicaAbertaPor);
    else fecharDica();
  }, true);


  // ─── Boas-vindas do primeiro acesso ──────────────────────────────
  // Aparece uma vez por aparelho, e só enquanto a ativação estiver
  // incompleta. O guia de ativação na Visão geral é a trilha; a
  // boas-vindas só apresenta o caminho e aponta o primeiro passo.

  function mostrarBoasVindas(ativacao) {
    const chave = `saferpet_bemvindo_${sessao.empresa.id}`;
    let jaViu = false;
    try { jaViu = !!localStorage.getItem(chave); } catch (_e) { jaViu = true; }
    if (jaViu || !ativacao || ativacao.completo) return;

    // A pessoa abriu outro modal enquanto a tela carregava: a saudação
    // não atropela — tenta de novo na próxima visita à Visão geral.
    if (document.querySelector('#area-modal .modal')) return;

    // Mostrou uma vez, não insiste: fechar pelo fundo também conta como
    // visto — a trilha continua no guia de ativação logo abaixo.
    try { localStorage.setItem(chave, '1'); } catch (_e) { /* segue */ }

    const modal = abrirModal(`
      <h3>Bem-vindo ao SaferPet</h3>
      <p style="font-size: 0.9rem; color: var(--text-muted); line-height: 1.6; margin-top: -6px">
        Em poucos passos o seu petshop fica no ar: os clientes vão agendar,
        acompanhar o saldo dos pacotes e comprar pelo celular. O caminho:
      </p>
      <div class="boasvindas-passos">
        <div class="boasvindas-passo"><span class="boasvindas-numero">1</span>
          <div>Cadastre os <strong>serviços</strong> com a duração de cada um
            <small>É a duração que monta a sua agenda de horários.</small></div>
        </div>
        <div class="boasvindas-passo"><span class="boasvindas-numero">2</span>
          <div>Monte os <strong>pacotes</strong> com preço
            <small>Ex.: 24 banhos por R$ 700 — o que hoje está no caderno.</small></div>
        </div>
        <div class="boasvindas-passo"><span class="boasvindas-numero">3</span>
          <div>Libere o <strong>aplicativo do cliente</strong> em Configurações
            <small>E conecte o Mercado Pago para receber pagamento online.</small></div>
        </div>
        <div class="boasvindas-passo"><span class="boasvindas-numero">4</span>
          <div>Mande o <strong>endereço da sua página</strong> aos clientes
            <small>Cada um cria a própria conta e cadastra os pets.</small></div>
        </div>
      </div>
      <p style="font-size: 0.85rem; color: var(--text-muted); line-height: 1.55">
        A Visão geral acompanha esses passos com você, e a aba
        <strong>Ajuda</strong> explica cada tela. Os "?" ao lado dos campos
        dizem o que preencher.
      </p>
      <div style="display: flex; gap: 10px; justify-content: flex-end; flex-wrap: wrap">
        <button class="btn-fantasma" id="bv-depois" type="button">Explorar por conta própria</button>
        <button class="btn-primario" id="bv-comecar" type="button">Começar pelos serviços</button>
      </div>`);
    ligarFechar(modal);
    modal.querySelector('#bv-depois').addEventListener('click', fecharModal);
    modal.querySelector('#bv-comecar').addEventListener('click', () => {
      fecharModal(); window.location.hash = '#/catalogo';
    });
  }

  // ═══ Visão geral ═════════════════════════════════════════════════

  async function verVisao() {
    const hoje = hojeISO();
    const [kpis, dia, recentes, ativacao, vinculos] = await Promise.all([
      api('/dashboard'),
      api(`/agenda/dia?data=${hoje}`),
      api('/baixas/recentes?limite=8'),
      api('/dashboard/ativacao').catch(() => null),
      api('/empresa/vinculos').catch(() => []),
    ]);

    const agendaHoje = dia.agendamentos.filter(a => a.status === 'AGENDADO');
    const NOME_TIPO = { SERVICO: '', BUSCA: 'Buscar — ', ENTREGA: 'Entregar — ' };

    conteudo.innerHTML = `
      <div class="cabecalho-pagina">
        <h2>Visão geral</h2>
        <p>${esc(sessao.empresa.nome)} — ${dataExtensa(hoje)}</p>
      </div>

      ${vinculos.length ? `
      <div class="cartao" style="padding: 24px; display: flex; flex-direction: column; gap: 14px; border-color: var(--primary-border)">
        <div>
          <div class="rotulo-secao">Confirmação de cliente</div>
          <p style="font-size: 0.9rem; color: var(--text-muted); margin-top: 6px; line-height: 1.55">
            ${vinculos.length === 1 ? 'Uma pessoa criou' : `${vinculos.length} pessoas criaram`}
            conta com um telefone que já está no seu cadastro. Confirme só se for
            mesmo o seu cliente — quem aprovar passa a ver todo o histórico dele.
          </p>
        </div>
        <div style="display: flex; flex-direction: column; gap: 10px">
          ${vinculos.map(v => `
            <div class="linha linha-inset" style="padding: 14px 16px">
              <div style="flex: 1; min-width: 0">
                <div class="linha-titulo">${esc(v.nome)} · ${esc(telefoneBonito(v.telefone))}</div>
                <div class="linha-sub">
                  Quer entrar na ficha de <strong>${esc(v.cliente_nome)}</strong>${v.email ? ` · ${esc(v.email)}` : ''}
                </div>
              </div>
              <button class="btn-fantasma btn-mini perigo" data-vinculo="${v.id}" data-acao="RECUSAR">Não é</button>
              <button class="btn-primario btn-mini" data-vinculo="${v.id}" data-acao="APROVAR">É o cliente</button>
            </div>`).join('')}
        </div>
      </div>` : ''}
      ${(ativacao && !ativacao.completo) ? `
      <div class="cartao" style="padding: 24px; display: flex; flex-direction: column; gap: 16px; border-color: var(--primary-border)">
        <div>
          <div class="rotulo-secao">Ativação do aplicativo do cliente</div>
          <p style="font-size: 0.9rem; color: var(--text-muted); margin-top: 6px; line-height: 1.55">
            ${ativacao.faltam === 1 ? 'Falta 1 passo' : `Faltam ${ativacao.faltam} passos`} para o seu cliente
            conseguir agendar e comprar pelo celular. Hoje ele vê:
            <strong>${[
              'o saldo dele',
              ativacao.cliente_ve.agendar ? 'agendar horário' : null,
              ativacao.cliente_ve.comprar_pacote ? 'comprar pacote' : null,
              ativacao.cliente_ve.loja ? 'a loja' : null,
            ].filter(Boolean).join(', ')}</strong>.
          </p>
        </div>
        <div style="display: flex; flex-direction: column; gap: 10px">
          ${ativacao.passos.map(p => `
            <div class="linha linha-inset" style="padding: 12px 16px; ${p.pronto ? 'opacity: 0.6' : ''}">
              <div style="width: 22px; height: 22px; border-radius: 999px; flex-shrink: 0; display: flex;
                          align-items: center; justify-content: center;
                          background: ${p.pronto ? 'var(--success-soft)' : 'var(--bg-panel)'};
                          border: 1px solid ${p.pronto ? 'var(--success)' : 'var(--border-strong)'};
                          color: var(--success)">
                ${p.pronto ? '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12.5l5.5 5.5L20 7"></path></svg>' : ''}
              </div>
              <div style="flex: 1">
                <div class="linha-titulo" style="font-size: 0.92rem">${esc(p.titulo)}</div>
                <div class="linha-sub">${esc(p.descricao)}</div>
              </div>
              ${p.pronto ? '<span class="chip ok">Feito</span>'
                : `<a class="btn-primario btn-mini" href="${p.onde}" style="text-decoration: none">Configurar</a>`}
            </div>`).join('')}
        </div>
      </div>` : ''}
      <div class="kpis">
        <div class="cartao kpi">
          <div class="kpi-icone">${ICONES.agenda}</div>
          <div><div class="kpi-rotulo">Agendados hoje</div><div class="kpi-valor">${kpis.agendados_hoje}</div></div>
        </div>
        <div class="cartao kpi">
          <div class="kpi-icone">${ICONES.van}</div>
          <div><div class="kpi-rotulo">Buscas e entregas</div><div class="kpi-valor">${kpis.retiradas_hoje}</div></div>
        </div>
        <div class="cartao kpi">
          <div class="kpi-icone">${ICONES.banho}</div>
          <div><div class="kpi-rotulo">Créditos usados hoje</div><div class="kpi-valor">${kpis.banhos_hoje}</div></div>
        </div>
        <div class="cartao kpi">
          <div class="kpi-icone" style="color: var(--danger)">${ICONES.alerta}</div>
          <div><div class="kpi-rotulo">Saldos acabando</div><div class="kpi-valor" style="color: ${kpis.saldos_acabando > 0 ? 'var(--danger)' : 'var(--text-main)'}">${kpis.saldos_acabando}</div></div>
        </div>
      </div>

      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap: 20px">
        <div>
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px">
            <div class="rotulo-secao">Agenda de hoje</div>
            <a class="btn-fantasma btn-mini" href="#/agenda" style="text-decoration: none">Abrir agenda</a>
          </div>
          ${agendaHoje.length ? `<div class="lista">${agendaHoje.map(a => `
            <div class="linha">
              <div class="linha-data" style="min-width: 52px">${a.inicio}</div>
              <div style="flex: 1">
                <div class="linha-titulo">${esc(NOME_TIPO[a.tipo] || '')}${esc(a.cliente_nome)}</div>
                <div class="linha-sub">${a.pet_nome ? esc(a.pet_nome) + ' · ' : ''}${esc(a.servico_nome || '')}</div>
              </div>
              ${a.tipo !== 'SERVICO' ? '<span class="chip acento">Leva-e-traz</span>' : ''}
            </div>`).join('')}</div>`
          : '<div class="vazio">Nada agendado para hoje.</div>'}
        </div>
        <div>
          <div class="rotulo-secao" style="margin-bottom: 12px">Últimas baixas</div>
          ${recentes.length ? `<div class="lista">${recentes.map(b => `
            <div class="linha">
              <div class="linha-data">${dataCurta(b.registrado_em)}</div>
              <div style="flex: 1">
                <div class="linha-titulo" style="${b.estornada ? 'text-decoration: line-through; color: var(--text-subtle)' : ''}">
                  ${b.pet_nome ? esc(b.pet_nome) + ' · ' : ''}${esc(b.servico)}
                </div>
                <div class="linha-sub">
                  <a href="#/cliente/${b.cliente_id}">${esc(b.cliente_nome)}</a>
                  · ${horaCurta(b.registrado_em)}${b.estornada ? ' · estornada' : ''}
                </div>
              </div>
              ${b.estornada ? '<span class="chip">Estornada</span>' : `<span class="chip acento">Restou ${b.saldo_apos}</span>`}
            </div>`).join('')}</div>`
          : '<div class="vazio">Nenhuma baixa registrada ainda.</div>'}
        </div>
      </div>`;

    // Confirmar (ou não) quem criou conta com um telefone já cadastrado.
    conteudo.querySelectorAll('[data-vinculo]').forEach(botao => {
      botao.addEventListener('click', async () => {
        const acao = botao.dataset.acao;
        conteudo.querySelectorAll('[data-vinculo]').forEach(b => { b.disabled = true; });
        try {
          const r = await api(`/empresa/vinculos/${botao.dataset.vinculo}`, {
            method: 'PUT', body: { acao },
          });
          toast(acao === 'APROVAR'
            ? `${r.nome || 'Cliente'} já pode entrar na conta.`
            : 'Pedido recusado.');
          await verVisao();
        } catch (err) {
          toast(err.message, true);
          conteudo.querySelectorAll('[data-vinculo]').forEach(b => { b.disabled = false; });
        }
      });
    });

    mostrarBoasVindas(ativacao);
  }

  // Telefone só com dígitos vira (67) 99999-0000 na tela.
  function telefoneBonito(valor) {
    const d = String(valor || '').replace(/\D/g, '');
    if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
    if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
    return valor || '';
  }

  // ═══ Agenda ══════════════════════════════════════════════════════

  async function verAgenda(data) {
    const dataAtual = data && /^\d{4}-\d{2}-\d{2}$/.test(data) ? data : hojeISO();
    const dia = await api(`/agenda/dia?data=${dataAtual}`);

    const visiveis = dia.agendamentos.filter(a => a.status !== 'CANCELADO');
    // A janela da grade cobre o expediente E os agendamentos existentes
    // (um horário herdado de configuração antiga não pode estourar o topo).
    const minsVisiveis = visiveis.flatMap(a => [paraMin(a.inicio), paraMin(a.fim)]);
    const candidatosIni = dia.periodos.map(p => paraMin(p.inicio)).concat(minsVisiveis);
    const candidatosFim = dia.periodos.map(p => paraMin(p.fim)).concat(minsVisiveis);
    const abertura = candidatosIni.length ? Math.min(...candidatosIni) : paraMin('08:00');
    const fechamento = candidatosFim.length ? Math.max(...candidatosFim) : paraMin('18:00');
    const escala = 1.2; // px por minuto
    const altura = (fechamento - abertura) * escala;

    const NOME_RECURSO_TIPO = { ATENDIMENTO: '', VEICULO: ' (veículo)' };

    function blocosDe(recursoId) {
      return visiveis.filter(a => a.recurso_id === recursoId).map(a => {
        const topo = (paraMin(a.inicio) - abertura) * escala;
        const alt = Math.max((paraMin(a.fim) - paraMin(a.inicio)) * escala, 22);
        const classe = a.status === 'CONCLUIDO' ? 'concluido'
          : a.status === 'FALTOU' ? 'faltou'
          : (a.tipo !== 'SERVICO' ? 'rota' : '');
        const prefixo = a.tipo === 'BUSCA' ? 'Buscar: ' : (a.tipo === 'ENTREGA' ? 'Entregar: ' : '');
        const marcaCliente = a.origem === 'CLIENTE' ? ' •' : '';
        return `
          <div class="agenda-bloco ${classe}" data-ag="${a.id}" style="top: ${topo}px; height: ${alt - 4}px"
               title="${a.origem === 'CLIENTE' ? 'Agendado pelo cliente no aplicativo' : ''}">
            ${a.inicio} ${prefixo}${esc(a.cliente_nome)}${marcaCliente}
            <small>${a.pet_nome ? esc(a.pet_nome) + ' · ' : ''}${esc(a.servico_nome || '')}</small>
          </div>`;
      }).join('');
    }

    // Sombreia o que está fora dos períodos de funcionamento.
    function forasDoExpediente() {
      const blocos = [];
      let cursor = abertura;
      const pers = dia.periodos.map(p => [paraMin(p.inicio), paraMin(p.fim)]).sort((a, b) => a[0] - b[0]);
      for (const [ini, fim] of pers) {
        if (ini > cursor) blocos.push([cursor, ini]);
        cursor = Math.max(cursor, fim);
      }
      if (cursor < fechamento) blocos.push([cursor, fechamento]);
      return blocos.map(([ini, fim]) =>
        `<div class="agenda-fora" style="top: ${(ini - abertura) * escala}px; height: ${(fim - ini) * escala}px"></div>`
      ).join('');
    }

    const horas = [];
    for (let m = Math.ceil(abertura / 60) * 60; m <= fechamento; m += 60) horas.push(m);

    conteudo.innerHTML = `
      <div class="linha-cabecalho">
        <div class="cabecalho-pagina"><h2>Agenda</h2></div>
        <button class="btn-primario" id="botao-novo-agendamento" type="button">Novo agendamento</button>
      </div>
      <div class="agenda-nav">
        <button class="btn-fantasma btn-mini" id="dia-anterior" type="button">Anterior</button>
        <div class="agenda-data">${dataExtensa(dataAtual)}</div>
        <button class="btn-fantasma btn-mini" id="dia-seguinte" type="button">Próximo</button>
        <button class="btn-fantasma btn-mini" id="dia-hoje" type="button">Hoje</button>
        <input type="date" id="dia-escolhido" class="busca" style="max-width: 170px; border-radius: 10px; padding: 8px 12px" value="${dataAtual}">
      </div>
      ${dia.fechado || !dia.periodos.length
        ? `<div class="vazio">O petshop não abre neste dia.${ehAdmin() ? '<br>Configure o funcionamento em Configurações.' : ''}</div>
           ${visiveis.filter(a => a.status === 'AGENDADO').length ? `
           <div class="faixa-aviso">Atenção: existem agendamentos marcados neste dia fechado — reagende ou cancele.</div>
           <div class="lista">${visiveis.filter(a => a.status === 'AGENDADO').map(a => `
             <div class="linha" data-ag="${a.id}" style="cursor: pointer">
               <div class="linha-data" style="min-width: 52px">${a.inicio}</div>
               <div style="flex: 1">
                 <div class="linha-titulo">${esc(a.cliente_nome)}</div>
                 <div class="linha-sub">${a.pet_nome ? esc(a.pet_nome) + ' · ' : ''}${esc(a.servico_nome || '')}</div>
               </div>
             </div>`).join('')}</div>` : ''}`
        : `
      <div style="overflow-x: auto">
        <div class="agenda-grade" style="grid-template-columns: 64px repeat(${dia.recursos.length}, minmax(150px, 1fr)); min-width: ${100 + dia.recursos.length * 160}px">
          <div class="agenda-cabecalho" style="border-left: none; background: var(--bg-panel)"></div>
          ${dia.recursos.map(r => `<div class="agenda-cabecalho">${esc(r.nome)}${NOME_RECURSO_TIPO[r.tipo] || ''}${r.ativo === false ? ' — inativo' : ''}</div>`).join('')}
          <div class="agenda-horas" style="height: ${altura}px">
            ${horas.map(m => `<div class="agenda-hora" style="top: ${(m - abertura) * escala}px">${String(Math.floor(m / 60)).padStart(2, '0')}:00</div>`).join('')}
          </div>
          ${dia.recursos.map(r => `
            <div class="agenda-coluna" style="height: ${altura}px">
              ${horas.map(m => `<div class="agenda-linha-hora" style="top: ${(m - abertura) * escala}px"></div>`).join('')}
              ${forasDoExpediente()}
              ${blocosDe(r.id)}
            </div>`).join('')}
        </div>
      </div>`}`;

    document.getElementById('botao-novo-agendamento').addEventListener('click', () => modalNovoAgendamento(dataAtual));
    document.getElementById('dia-anterior').addEventListener('click', () => verAgenda(somarDiasISO(dataAtual, -1)));
    document.getElementById('dia-seguinte').addEventListener('click', () => verAgenda(somarDiasISO(dataAtual, 1)));
    document.getElementById('dia-hoje').addEventListener('click', () => verAgenda(hojeISO()));
    document.getElementById('dia-escolhido').addEventListener('change', (ev) => verAgenda(ev.target.value));

    conteudo.querySelectorAll('[data-ag]').forEach(el =>
      el.addEventListener('click', () => {
        const ag = dia.agendamentos.find(a => a.id === parseInt(el.dataset.ag, 10));
        if (ag) modalDetalheAgendamento(ag, dataAtual);
      }));
  }

  async function modalNovoAgendamento(dataPadrao, clientePre) {
    const [clientes, servicos] = await Promise.all([api('/clientes'), carregarServicos()]);
    const servicosAtivos = servicos.filter(s => s.ativo);
    if (!servicosAtivos.length) { toast('Cadastre um serviço no Catálogo primeiro.', true); return; }

    const modal = abrirModal(`
      <h3>Novo agendamento</h3>
      <form id="form-modal" style="display: flex; flex-direction: column; gap: 14px">
        <div class="campo"><label>Cliente</label>
          <select name="cliente_id" required>
            <option value="">Escolha…</option>
            ${clientes.map(c => `<option value="${c.id}" ${clientePre === c.id ? 'selected' : ''}>${esc(c.nome)}</option>`).join('')}
          </select>
        </div>
        <div class="campo"><label>Pet</label>
          <select name="pet_id"><option value="">—</option></select>
        </div>
        <div class="campo"><label>Serviço</label>
          <select name="servico_id" required>
            ${servicosAtivos.map(s => `<option value="${s.id}">${esc(s.nome)} — ${s.duracao_minutos} min${s.preco_centavos ? ' · ' + formatarReais(s.preco_centavos) : ''}</option>`).join('')}
          </select>
        </div>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; align-items: end">
          <div class="campo"><label>Data</label>
            <input name="data" type="date" value="${dataPadrao}" min="${hojeISO()}" required>
          </div>
          <label id="rotulo-leva-traz" style="display: none; align-items: center; gap: 10px; font-size: 0.9rem; cursor: pointer; padding-bottom: 10px">
            <input type="checkbox" name="leva_traz" style="width: 17px; height: 17px; accent-color: var(--primary)">
            Leva-e-traz (buscar em casa)
          </label>
        </div>
        <div class="campo"><label>Horário</label>
          <div class="pilulas-horario" id="pilulas"></div>
          <input type="hidden" name="inicio">
        </div>
        <div class="campo"><label>Observação</label><input name="observacao"></div>
        ${rodapeModal('Agendar')}
      </form>`);
    ligarFechar(modal);

    const form = modal.querySelector('#form-modal');
    const seletorCliente = form.querySelector('[name="cliente_id"]');
    const seletorPet = form.querySelector('[name="pet_id"]');
    const pilulas = modal.querySelector('#pilulas');
    const campoInicio = form.querySelector('[name="inicio"]');
    const rotuloLevaTraz = modal.querySelector('#rotulo-leva-traz');

    async function carregarPets() {
      seletorPet.innerHTML = '<option value="">—</option>';
      if (!seletorCliente.value) return;
      const ficha = await api(`/clientes/${seletorCliente.value}`);
      for (const p of ficha.pets) {
        const opcao = document.createElement('option');
        opcao.value = p.id;
        opcao.textContent = p.nome;
        seletorPet.appendChild(opcao);
      }
      if (ficha.pets.length === 1) seletorPet.value = String(ficha.pets[0].id);
    }

    async function carregarHorarios() {
      campoInicio.value = '';
      pilulas.innerHTML = '<span style="color: var(--text-subtle); font-size: 0.85rem">Carregando…</span>';
      const data = form.querySelector('[name="data"]').value;
      const servicoId = form.querySelector('[name="servico_id"]').value;
      const levaTraz = form.querySelector('[name="leva_traz"]').checked;
      if (!data || !servicoId) { pilulas.innerHTML = ''; return; }
      try {
        const r = await api(`/agenda/horarios-livres?data=${data}&servico_id=${servicoId}&leva_traz=${levaTraz}`);
        rotuloLevaTraz.style.display = r.leva_traz_disponivel ? 'flex' : 'none';
        if (!r.horarios.length) {
          pilulas.innerHTML = '<span style="color: var(--text-muted); font-size: 0.85rem">Nenhum horário livre neste dia.</span>';
          return;
        }
        pilulas.innerHTML = r.horarios.map(h => `<button type="button" class="pilula-horario" data-hora="${h}">${h}</button>`).join('');
        pilulas.querySelectorAll('[data-hora]').forEach(b => b.addEventListener('click', () => {
          pilulas.querySelectorAll('.pilula-horario').forEach(x => x.classList.remove('escolhida'));
          b.classList.add('escolhida');
          campoInicio.value = b.dataset.hora;
        }));
      } catch (err) {
        pilulas.innerHTML = `<span style="color: var(--danger); font-size: 0.85rem">${esc(err.message)}</span>`;
      }
    }

    seletorCliente.addEventListener('change', () => carregarPets().catch(() => {}));
    form.querySelector('[name="data"]').addEventListener('change', carregarHorarios);
    form.querySelector('[name="servico_id"]').addEventListener('change', carregarHorarios);
    form.querySelector('[name="leva_traz"]').addEventListener('change', carregarHorarios);
    if (clientePre) { seletorCliente.value = String(clientePre); carregarPets().catch(() => {}); }
    carregarHorarios();

    aoEnviar(form, async () => {
      const f = new FormData(form);
      if (!f.get('inicio')) { toast('Escolha um horário.', true); return; }
      try {
        const r = await api('/agenda/agendamentos', { method: 'POST', body: {
          cliente_id: parseInt(f.get('cliente_id'), 10),
          pet_id: f.get('pet_id') ? parseInt(f.get('pet_id'), 10) : null,
          servico_id: parseInt(f.get('servico_id'), 10),
          data: f.get('data'),
          inicio: f.get('inicio'),
          leva_traz: form.querySelector('[name="leva_traz"]').checked,
          observacao: f.get('observacao'),
        }});
        fecharModal();
        toast(r.aviso_entrega ? `Agendado. ${r.aviso_entrega}` : 'Agendado.', !!r.aviso_entrega);
        if (window.location.hash.startsWith('#/agenda')) verAgenda(f.get('data'));
        else renderizar();
      } catch (err) { toast(err.message, true); }
    });
  }

  function modalDetalheAgendamento(ag, dataAtual) {
    const NOME_TIPO = { SERVICO: 'Atendimento', BUSCA: 'Busca (leva-e-traz)', ENTREGA: 'Entrega (leva-e-traz)' };
    const podeAgir = ag.status === 'AGENDADO';
    const modal = abrirModal(`
      <h3>${ag.inicio}–${ag.fim} · ${esc(ag.cliente_nome)}</h3>
      <div style="display: flex; flex-direction: column; gap: 6px; font-size: 0.92rem; color: var(--text-muted)">
        <div>${esc(NOME_TIPO[ag.tipo])} · <a href="#/cliente/${ag.cliente_id}">${esc(ag.cliente_nome)}</a></div>
        ${ag.pet_nome ? `<div>Pet: ${esc(ag.pet_nome)}</div>` : ''}
        ${ag.servico_nome ? `<div>Serviço: ${esc(ag.servico_nome)}</div>` : ''}
        <div>Situação: <span class="chip ${ag.status === 'CONCLUIDO' ? 'ok' : (ag.status === 'FALTOU' ? 'alerta' : 'acento')}">${esc(ag.status)}</span></div>
        ${ag.observacao ? `<div>Obs.: ${esc(ag.observacao)}</div>` : ''}
      </div>
      ${podeAgir && ag.tipo === 'SERVICO' ? `
        <label style="display: flex; align-items: center; gap: 10px; font-size: 0.9rem; cursor: pointer">
          <input type="checkbox" id="consumir-credito" checked style="width: 17px; height: 17px; accent-color: var(--primary)">
          Ao concluir, dar baixa de 1 crédito do pacote
        </label>` : ''}
      ${ag.tipo === 'SERVICO' ? `
        <label class="btn-fantasma" style="align-self: flex-start; cursor: pointer">
          Enviar foto do pet pronto
          <input type="file" id="campo-foto" accept="image/*" capture="environment" style="display: none">
        </label>
        <div id="aviso-foto" class="linha-sub"></div>` : ''}
      <div style="display: flex; gap: 10px; justify-content: flex-end; flex-wrap: wrap">
        <button class="btn-fantasma" data-fechar type="button">Fechar</button>
        ${podeAgir ? `
          <button class="btn-fantasma perigo" id="acao-cancelar" type="button">Cancelar${ag.tipo === 'SERVICO' ? ' (e leva-e-traz)' : ''}</button>
          ${ag.tipo === 'SERVICO' ? '<button class="btn-fantasma perigo" id="acao-faltou" type="button">Faltou</button>' : ''}
          <button class="btn-primario" id="acao-concluir" type="button">Concluir</button>` : ''}
      </div>`);
    ligarFechar(modal);

    const campoFoto = modal.querySelector('#campo-foto');
    if (campoFoto) {
      campoFoto.addEventListener('change', async () => {
        const arquivo = campoFoto.files && campoFoto.files[0];
        if (!arquivo) return;
        const aviso = modal.querySelector('#aviso-foto');
        aviso.textContent = 'Preparando a foto…';
        try {
          const imagem = await reduzirImagem(arquivo);
          await api('/extras/fotos', { method: 'POST', body: {
            cliente_id: ag.cliente_id, pet_id: ag.pet_id, agendamento_id: ag.id,
            conteudo: imagem, legenda: ag.pet_nome ? `${ag.pet_nome} prontinho!` : 'Pronto!',
          }});
          aviso.textContent = 'Foto enviada — o cliente já pode ver no aplicativo.';
          toast('Foto enviada ao cliente.');
        } catch (err) {
          aviso.textContent = '';
          toast(err.message, true);
        }
      });
    }

    async function executar(acao) {
      try {
        const consumir = modal.querySelector('#consumir-credito');
        const r = await api(`/agenda/agendamentos/${ag.id}`, { method: 'PUT', body: {
          acao, consumir_credito: consumir ? consumir.checked : false,
        }});
        fecharModal();
        if (acao === 'CONCLUIR' && r.sem_credito) {
          toast('Concluído — cliente SEM crédito deste serviço: cobrar na hora.', true);
        } else if (acao === 'CONCLUIR' && r.baixa) {
          toast(`Concluído. Crédito baixado (restou ${r.baixa.saldo_apos}).`);
        } else {
          toast(acao === 'CANCELAR' ? 'Cancelado.' : (acao === 'FALTOU' ? 'Falta registrada.' : 'Concluído.'));
        }
        verAgenda(dataAtual);
      } catch (err) { toast(err.message, true); }
    }
    const btnConcluir = modal.querySelector('#acao-concluir');
    const btnCancelar = modal.querySelector('#acao-cancelar');
    const btnFaltou = modal.querySelector('#acao-faltou');
    if (btnConcluir) btnConcluir.addEventListener('click', () => executar('CONCLUIR'));
    if (btnCancelar) btnCancelar.addEventListener('click', () => {
      if (window.confirm('Cancelar este agendamento?')) executar('CANCELAR');
    });
    if (btnFaltou) btnFaltou.addEventListener('click', () => executar('FALTOU'));
  }

  // ═══ Clientes ════════════════════════════════════════════════════

  async function verClientes(busca) {
    const query = busca ? `?busca=${encodeURIComponent(busca)}` : '';
    const clientes = await api(`/clientes${query}`);

    conteudo.innerHTML = `
      <div class="linha-cabecalho">
        <div class="cabecalho-pagina">
          <h2>Clientes</h2>
          <p>${clientes.length} cliente${clientes.length === 1 ? '' : 's'}${busca ? ` para "${esc(busca)}"` : ''}</p>
        </div>
        <button class="btn-primario" id="botao-novo-cliente" type="button">Novo cliente</button>
      </div>
      <input class="busca" id="campo-busca" type="search" placeholder="Buscar por cliente ou pet" value="${esc(busca || '')}">
      ${sessao.empresa.slug ? `
      <div class="linha linha-inset" style="padding: 12px 16px; gap: 12px">
        <div style="flex: 1; min-width: 200px">
          <div class="linha-titulo" style="font-size: 0.9rem">Seus clientes podem se cadastrar sozinhos</div>
          <div class="linha-sub">Mande o endereço da sua página: ${esc(enderecoPublico())}</div>
        </div>
        <button class="btn-fantasma btn-mini" id="botao-copiar-vitrine" type="button">Copiar link</button>
        <a class="btn-fantasma btn-mini" style="text-decoration: none" target="_blank" rel="noopener"
           href="https://wa.me/?text=${encodeURIComponent(textoConviteVitrine())}">Enviar por WhatsApp</a>
      </div>` : ''}
      ${clientes.length ? `<div class="lista">${clientes.map(c => {
        const temPacote = c.pacote_id !== null && c.pacote_id !== undefined;
        const acabando = temPacote && c.saldo_total <= 3;
        const extras = temPacote ? c.saldo_total - c.saldo : 0;
        return `
        <div class="linha">
          <div class="avatar">${esc(String(c.nome).trim().charAt(0).toUpperCase())}</div>
          <div style="flex: 1; min-width: 140px">
            <div class="linha-titulo">${esc(c.nome)}</div>
            <div class="linha-sub">${esc(c.pets || 'sem pets cadastrados')}</div>
          </div>
          ${temPacote
            ? `<span class="chip ${acabando ? 'alerta' : 'acento'}">${acabando ? 'Acabando' : esc(c.pacote_nome)}</span>
               <div style="display: flex; flex-direction: column; gap: 6px; align-items: flex-end; width: 150px">
                 <div style="font-variant-numeric: tabular-nums">
                   <strong style="font-family: var(--fonte-titulo); font-size: 1.2rem; ${acabando ? 'color: var(--danger)' : ''}">${c.saldo}</strong>
                   <span style="color: var(--text-subtle); font-size: 0.8rem">/ ${c.qtd_banhos}${extras > 0 ? ` +${extras}` : ''}</span>
                 </div>
                 ${barraSaldo(c.saldo, c.qtd_banhos)}
               </div>
               <div class="linha-sub" style="width: 110px; text-align: right">última ${dataCurta(c.ultima_baixa)}</div>
               <button class="btn-primario btn-mini" data-baixa="${c.id}" type="button">Dar baixa</button>`
            : `<span class="chip">Sem pacote</span>
               <button class="btn-fantasma btn-mini" data-vender="${c.id}" type="button">Vender pacote</button>`}
          <button class="btn-fantasma btn-mini" data-agendar="${c.id}" type="button">Agendar</button>
          <a class="btn-fantasma btn-mini" href="#/cliente/${c.id}" style="text-decoration: none">Ficha</a>
        </div>`;
      }).join('')}</div>`
      : `<div class="vazio">${busca ? 'Nenhum cliente encontrado.' : 'Nenhum cliente ainda.<br>Comece cadastrando o primeiro cliente e os pets dele.'}</div>`}`;

    document.getElementById('botao-novo-cliente').addEventListener('click', modalNovoCliente);

    const botaoVitrine = document.getElementById('botao-copiar-vitrine');
    if (botaoVitrine) botaoVitrine.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(enderecoPublico()); toast('Link copiado.'); }
      catch (_e) { toast('Não deu para copiar. O endereço está na faixa acima.', true); }
    });

    const campoBusca = document.getElementById('campo-busca');
    let timer = null;
    campoBusca.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => verClientes(campoBusca.value.trim()), 350);
    });
    campoBusca.focus();
    campoBusca.setSelectionRange(campoBusca.value.length, campoBusca.value.length);

    conteudo.querySelectorAll('[data-baixa]').forEach(b =>
      b.addEventListener('click', () => modalDarBaixa(parseInt(b.dataset.baixa, 10))));
    conteudo.querySelectorAll('[data-vender]').forEach(b =>
      b.addEventListener('click', () => modalVenderPacote(parseInt(b.dataset.vender, 10))));
    conteudo.querySelectorAll('[data-agendar]').forEach(b =>
      b.addEventListener('click', () => modalNovoAgendamento(hojeISO(), parseInt(b.dataset.agendar, 10))));
  }

  function modalNovoCliente() {
    const modal = abrirModal(`
      <h3>Novo cliente</h3>
      <form id="form-modal" style="display: flex; flex-direction: column; gap: 14px">
        <div class="campo"><label>Nome</label><input name="nome" required></div>
        <div class="campo"><label>Telefone / WhatsApp
          ${dica('Com DDD. Este número identifica o cliente: é com ele que a pessoa entra na conta dela no aplicativo. Cada cliente precisa de um número diferente.')}</label><input name="telefone" placeholder="67999999999"></div>
        <div class="campo"><label>E-mail (opcional)</label><input name="email" type="email"></div>
        <div class="campo"><label>Observações</label><textarea name="observacoes" rows="2"></textarea></div>
        <div class="campo"><label>Primeiro pet (opcional)</label><input name="pet_nome" placeholder="Nome do pet"></div>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px">
          <div class="campo"><label>Raça</label><input name="pet_raca"></div>
          <div class="campo"><label>Porte</label>
            <select name="pet_porte"><option value="">—</option><option>pequeno</option><option>médio</option><option>grande</option></select>
          </div>
        </div>
        ${rodapeModal('Cadastrar')}
      </form>`);
    ligarFechar(modal);
    aoEnviar(modal.querySelector('#form-modal'), async (ev) => {
      const f = new FormData(ev.target);
      try {
        const cliente = await api('/clientes', { method: 'POST', body: {
          nome: f.get('nome'), telefone: f.get('telefone'),
          email: f.get('email'), observacoes: f.get('observacoes'),
        }});
        const petNome = String(f.get('pet_nome') || '').trim();
        if (petNome) {
          await api('/pets', { method: 'POST', body: {
            cliente_id: cliente.id, nome: petNome,
            raca: f.get('pet_raca'), porte: f.get('pet_porte'),
          }});
        }
        fecharModal();
        toast('Cliente cadastrado.');
        window.location.hash = `#/cliente/${cliente.id}`;
      } catch (err) { toast(err.message, true); }
    });
  }

  // ═══ Ficha do cliente ════════════════════════════════════════════

  async function verFicha(clienteId) {
    const [c, vacinasCliente] = await Promise.all([
      api(`/clientes/${clienteId}`),
      api(`/extras/vacinas?cliente_id=${clienteId}`).catch(() => []),
    ]);
    const ativo = pacoteEmConsumo(c.pacotes);
    const proximos = c.pacotes.filter(p => p.status === 'ATIVO' && (!ativo || p.id !== ativo.id));
    const anteriores = c.pacotes.filter(p => p.status !== 'ATIVO');
    const saldoProximos = proximos.reduce((soma, p) => soma + p.saldo, 0);
    const STATUS_CHIP = { ATIVO: 'ok', ESGOTADO: 'alerta', VENCIDO: 'alerta', CANCELADO: '' };

    conteudo.innerHTML = `
      <div style="font-size: 0.85rem; color: var(--text-subtle)">
        <a href="#/clientes">Clientes</a> <span style="margin: 0 6px">/</span>
        <span style="color: var(--text-muted); font-weight: 600">${esc(c.nome)}</span>
      </div>
      <div class="linha-cabecalho">
        <div class="cabecalho-pagina">
          <h2>${esc(c.nome)}</h2>
          <p>${[c.telefone, c.email].filter(Boolean).map(esc).join(' · ') || 'sem contato cadastrado'} · cliente desde ${dataLonga(c.criado_em)}</p>
          ${c.endereco ? `<p style="margin-top: 6px"><strong>Buscar em:</strong> ${esc(c.endereco)}</p>` : ''}
        </div>
        <div style="display: flex; gap: 10px; flex-wrap: wrap">
          <button class="btn-fantasma" id="botao-editar" type="button">Editar</button>
          <button class="btn-fantasma" id="botao-link" type="button">Link do portal</button>
          <button class="btn-fantasma" id="botao-vender" type="button">Vender pacote</button>
          <button class="btn-fantasma" id="botao-agendar" type="button">Agendar</button>
          ${ativo ? '<button class="btn-primario" id="botao-baixa" type="button">Dar baixa</button>' : ''}
        </div>
      </div>

      <div style="display: grid; grid-template-columns: minmax(280px, 2fr) minmax(320px, 3fr); gap: 20px; align-items: start" id="grade-ficha">
        <div style="display: flex; flex-direction: column; gap: 18px">
          ${ativo ? `
          <div class="cartao" style="padding: 24px; display: flex; flex-direction: column; gap: 14px">
            <div style="display: flex; justify-content: space-between; align-items: center">
              <div class="rotulo-secao">Pacote em consumo</div>
              <span class="chip ${ativo.saldo <= 3 ? 'alerta' : 'ok'}">${ativo.saldo <= 3 ? 'Acabando' : 'Em dia'}</span>
            </div>
            <div>
              <h3 style="font-size: 1.35rem">${esc(ativo.nome)}</h3>
              <div class="linha-sub">comprado em ${dataLonga(ativo.comprado_em)} · ${formatarReais(ativo.valor_centavos)}</div>
            </div>
            <div style="display: flex; align-items: baseline; gap: 10px">
              <div style="font-family: var(--fonte-titulo); font-size: 3rem; font-weight: 550; line-height: 1">${ativo.saldo}</div>
              <div style="color: var(--text-muted); font-size: 0.92rem">créditos de ${ativo.qtd_banhos}${saldoProximos > 0 ? ` · +${saldoProximos} no próximo pacote` : ''}</div>
            </div>
            <div style="display: flex; flex-direction: column; gap: 8px">
              ${(ativo.itens || []).map(i => `
                <div class="credito-linha">
                  <span class="credito-nome">${esc(i.servico_nome)}</span>
                  ${barraSaldo(i.saldo, i.quantidade, 90)}
                  <span class="credito-numeros">${i.saldo} / ${i.quantidade}</span>
                </div>`).join('')}
            </div>
            <div class="linha-sub">${ativo.validade_ate ? `válido até ${dataLonga(ativo.validade_ate)}` : 'sem validade'}</div>
            ${ehAdmin() ? `<button class="btn-fantasma btn-mini" id="botao-ajustar-pacote" type="button" style="align-self: flex-start">Ajustar validade / cancelar</button>` : ''}
          </div>` : `
          <div class="vazio">Nenhum pacote ativo.<br>Venda um pacote para começar a controlar os créditos.</div>`}

          <div class="cartao" style="padding: 22px 24px; display: flex; flex-direction: column; gap: 12px">
            <div style="display: flex; justify-content: space-between; align-items: center">
              <div class="rotulo-secao">Pets</div>
              <button class="btn-fantasma btn-mini" id="botao-novo-pet" type="button">Adicionar pet</button>
            </div>
            ${c.pets.length ? c.pets.map(p => `
              <div class="linha linha-inset" style="padding: 10px 14px">
                <div style="color: var(--primary-ink)">${ICONES.pata}</div>
                <div style="flex: 1">
                  <div class="linha-titulo" style="font-size: 0.92rem">${esc(p.nome)}</div>
                  <div class="linha-sub">${[p.raca, p.porte ? 'porte ' + p.porte : null].filter(Boolean).map(esc).join(' · ') || '—'}</div>
                </div>
              </div>`).join('') : '<div class="linha-sub">Nenhum pet cadastrado.</div>'}
          </div>

          ${c.pets.length ? `
          <div class="cartao" style="padding: 22px 24px; display: flex; flex-direction: column; gap: 10px">
            <div style="display: flex; justify-content: space-between; align-items: center">
              <div class="rotulo-secao">Carteirinha de vacinação</div>
              <button class="btn-fantasma btn-mini" id="botao-nova-vacina" type="button">Registrar vacina</button>
            </div>
            ${vacinasCliente.length ? vacinasCliente.map(v => {
              const vencida = v.reforco_em && String(v.reforco_em).slice(0, 10) < hojeISO();
              return `
              <div class="linha linha-inset" style="padding: 10px 14px">
                <div style="flex: 1">
                  <div class="linha-titulo" style="font-size: 0.9rem">${esc(v.pet_nome)} · ${esc(v.nome)}</div>
                  <div class="linha-sub">aplicada em ${dataLonga(v.aplicada_em)}${v.reforco_em ? ` · reforço ${dataLonga(v.reforco_em)}` : ''}</div>
                </div>
                ${v.reforco_em ? `<span class="chip ${vencida ? 'alerta' : 'ok'}">${vencida ? 'Reforço vencido' : 'Em dia'}</span>` : ''}
              </div>`;
            }).join('') : '<div class="linha-sub">Nenhuma vacina registrada.</div>'}
          </div>` : ''}

          ${c.agendamentos.length ? `
          <div class="cartao" style="padding: 22px 24px; display: flex; flex-direction: column; gap: 10px">
            <div class="rotulo-secao">Próximos agendamentos</div>
            ${c.agendamentos.map(a => `
              <div class="linha linha-inset" style="padding: 10px 14px">
                <div class="linha-data" style="font-size: 1rem">${dataCurta(a.data)}</div>
                <div style="flex: 1">
                  <div class="linha-titulo" style="font-size: 0.9rem">${a.inicio} · ${esc(a.servico_nome || '')}</div>
                  <div class="linha-sub">${a.pet_nome ? esc(a.pet_nome) : ''}${a.leva_traz ? ' · leva-e-traz' : ''}</div>
                </div>
              </div>`).join('')}
          </div>` : ''}

          ${proximos.length ? `
          <div class="cartao" style="padding: 22px 24px; display: flex; flex-direction: column; gap: 10px">
            <div class="rotulo-secao">Próximos pacotes</div>
            ${proximos.map(p => `
              <div class="linha linha-inset" style="padding: 10px 14px">
                <div style="flex: 1">
                  <div class="linha-titulo" style="font-size: 0.9rem">${esc(p.nome)}</div>
                  <div class="linha-sub">${p.saldo} de ${p.qtd_banhos} créditos · comprado em ${dataLonga(p.comprado_em)}</div>
                </div>
                <span class="chip ok">Na fila</span>
              </div>`).join('')}
          </div>` : ''}

          ${anteriores.length ? `
          <div class="cartao" style="padding: 22px 24px; display: flex; flex-direction: column; gap: 10px">
            <div class="rotulo-secao">Pacotes anteriores</div>
            ${anteriores.map(p => `
              <div class="linha linha-inset" style="padding: 10px 14px">
                <div style="flex: 1">
                  <div class="linha-titulo" style="font-size: 0.9rem">${esc(p.nome)}</div>
                  <div class="linha-sub">${dataLonga(p.comprado_em)} · ${formatarReais(p.valor_centavos)} · restou ${p.saldo}</div>
                </div>
                <span class="chip ${STATUS_CHIP[p.status] || ''}">${esc(p.status)}</span>
                ${ehAdmin() && p.saldo > 0 && (p.status === 'VENCIDO' || p.status === 'CANCELADO')
                  ? `<button class="btn-fantasma btn-mini" data-reativar="${p.id}" type="button">Reativar</button>` : ''}
              </div>`).join('')}
          </div>` : ''}
        </div>

        <div class="cartao" style="padding: 24px; display: flex; flex-direction: column; gap: 12px">
          <div style="display: flex; justify-content: space-between; align-items: center">
            <div class="rotulo-secao">Histórico de baixas</div>
            <div class="linha-sub">${c.baixas.length} registro${c.baixas.length === 1 ? '' : 's'}</div>
          </div>
          ${c.baixas.length ? `<div class="lista" style="gap: 8px">${c.baixas.map(b => `
            <div class="linha linha-inset" style="padding: 10px 14px">
              <div class="linha-data" style="font-size: 1rem">${dataCurta(b.registrado_em)}</div>
              <div style="flex: 1">
                <div class="linha-titulo" style="font-size: 0.9rem; ${b.estornada ? 'text-decoration: line-through; color: var(--text-subtle)' : ''}">
                  ${b.pet_nome ? esc(b.pet_nome) + ' · ' : ''}${esc(b.servico)}
                </div>
                <div class="linha-sub">
                  por ${esc(b.registrado_por_nome)} às ${horaCurta(b.registrado_em)}
                  ${b.observacao ? ' · ' + esc(b.observacao) : ''}
                  ${b.estornada ? ' · estornada em ' + dataCurta(b.estornada_em) : ''}
                </div>
              </div>
              ${b.estornada
                ? '<span class="chip">Estornada</span>'
                : `<span class="chip acento">Restou ${b.saldo_apos}</span>
                   <button class="btn-fantasma btn-mini perigo" data-estornar="${b.id}" type="button">Estornar</button>`}
            </div>`).join('')}</div>`
          : '<div class="vazio">Nenhuma baixa ainda.</div>'}
        </div>
      </div>`;

    if (window.matchMedia('(max-width: 900px)').matches) {
      document.getElementById('grade-ficha').style.gridTemplateColumns = '1fr';
    }

    document.getElementById('botao-editar').addEventListener('click', () => modalEditarCliente(c));
    document.getElementById('botao-link').addEventListener('click', () => modalLinkPortal(c));
    document.getElementById('botao-vender').addEventListener('click', () => modalVenderPacote(c.id));
    document.getElementById('botao-agendar').addEventListener('click', () => modalNovoAgendamento(hojeISO(), c.id));
    const botaoBaixa = document.getElementById('botao-baixa');
    if (botaoBaixa) botaoBaixa.addEventListener('click', () => modalDarBaixa(c.id));
    document.getElementById('botao-novo-pet').addEventListener('click', () => modalNovoPet(c.id));
    const botaoAjustar = document.getElementById('botao-ajustar-pacote');
    if (botaoAjustar) botaoAjustar.addEventListener('click', () => modalAjustarPacote(ativo, c.id));
    const botaoVacina = document.getElementById('botao-nova-vacina');
    if (botaoVacina) botaoVacina.addEventListener('click', () => modalNovaVacina(c));

    conteudo.querySelectorAll('[data-estornar]').forEach(b =>
      b.addEventListener('click', async () => {
        if (!window.confirm('Estornar esta baixa? O crédito volta ao pacote.')) return;
        try {
          await api(`/baixas/${b.dataset.estornar}/estornar`, { method: 'POST' });
          toast('Baixa estornada.');
          verFicha(clienteId);
        } catch (err) { toast(err.message, true); }
      }));

    conteudo.querySelectorAll('[data-reativar]').forEach(b =>
      b.addEventListener('click', () => {
        const p = c.pacotes.find(x => x.id === parseInt(b.dataset.reativar, 10));
        if (p) modalReativarPacote(p, clienteId);
      }));
  }

  function modalEditarCliente(c) {
    const modal = abrirModal(`
      <h3>Editar cliente</h3>
      <form id="form-modal" style="display: flex; flex-direction: column; gap: 14px">
        <div class="campo"><label>Nome</label><input name="nome" value="${esc(c.nome)}" required></div>
        <div class="campo"><label>Telefone / WhatsApp</label><input name="telefone" value="${esc(c.telefone || '')}"></div>
        <div class="campo"><label>E-mail</label><input name="email" type="email" value="${esc(c.email || '')}"></div>
        <div class="campo"><label>Endereço para buscar o pet</label>
          <textarea name="endereco" rows="2" placeholder="Rua, número, bairro e referência">${esc(c.endereco || '')}</textarea></div>
        <div class="campo"><label>Observações</label><textarea name="observacoes" rows="2">${esc(c.observacoes || '')}</textarea></div>
        ${rodapeModal('Salvar')}
      </form>`);
    ligarFechar(modal);
    aoEnviar(modal.querySelector('#form-modal'), async (ev) => {
      const f = new FormData(ev.target);
      try {
        await api(`/clientes/${c.id}`, { method: 'PUT', body: {
          nome: f.get('nome'), telefone: f.get('telefone'),
          email: f.get('email'), endereco: f.get('endereco'),
          observacoes: f.get('observacoes'),
        }});
        fecharModal(); toast('Cliente atualizado.'); verFicha(c.id);
      } catch (err) { toast(err.message, true); }
    });
  }

  function modalLinkPortal(c) {
    const telefone = String(c.telefone || '').replace(/\D/g, '');
    const numeroWhats = telefone ? (telefone.length <= 11 ? '55' + telefone : telefone) : null;
    const textoWhats = `Olá, ${c.nome}! Acompanhe o saldo e os agendamentos por aqui: ${c.link_portal}`;
    const modal = abrirModal(`
      <h3>Link do portal do cliente</h3>
      <p style="font-size: 0.88rem; color: var(--text-muted); line-height: 1.5">
        Por este link o cliente vê os créditos, os próximos agendamentos e os últimos serviços — sem senha.
      </p>
      <div class="campo"><label>Link</label><input id="campo-link" readonly value="${esc(c.link_portal)}"></div>
      <div style="display: flex; gap: 10px; flex-wrap: wrap">
        <button class="btn-primario btn-mini" id="botao-copiar" type="button">Copiar link</button>
        ${numeroWhats ? `<a class="btn-fantasma btn-mini" style="text-decoration: none" target="_blank" rel="noopener"
          href="https://wa.me/${numeroWhats}?text=${encodeURIComponent(textoWhats)}">Enviar por WhatsApp</a>` : ''}
        ${ehAdmin() ? '<button class="btn-fantasma btn-mini perigo" id="botao-regenerar" type="button">Gerar novo link</button>' : ''}
      </div>
      ${c.conta_ativa ? `
      <div class="linha linha-inset" style="padding: 12px 16px; gap: 12px">
        <div style="flex: 1; min-width: 160px">
          <div class="linha-titulo" style="font-size: 0.88rem">Conta própria ativa</div>
          <div class="linha-sub">Este cliente também entra com telefone e senha.</div>
        </div>
        ${ehAdmin() ? '<button class="btn-fantasma btn-mini perigo" id="botao-desconectar" type="button">Desconectar conta</button>' : ''}
      </div>` : ''}
      <div style="display: flex; justify-content: flex-end"><button class="btn-fantasma" data-fechar type="button">Fechar</button></div>`);
    ligarFechar(modal);
    modal.querySelector('#botao-copiar').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(c.link_portal);
        toast('Link copiado.');
      } catch (_e) {
        modal.querySelector('#campo-link').select();
        document.execCommand('copy');
        toast('Link copiado.');
      }
    });
    const botaoDesconectar = modal.querySelector('#botao-desconectar');
    if (botaoDesconectar) botaoDesconectar.addEventListener('click', async () => {
      if (!window.confirm('Desconectar a conta deste cliente? A sessão dele cai na hora, ' +
        'e ele só volta criando a conta de novo — o que pede a sua confirmação.')) return;
      try {
        await api(`/clientes/${c.id}/desconectar-conta`, { method: 'POST' });
        fecharModal();
        toast('Conta desconectada.');
        verFicha(c.id);
      } catch (err) { toast(err.message, true); }
    });

    const botaoRegenerar = modal.querySelector('#botao-regenerar');
    if (botaoRegenerar) botaoRegenerar.addEventListener('click', async () => {
      if (!window.confirm('Gerar um novo link? O link antigo deixa de funcionar.')) return;
      try {
        await api(`/clientes/${c.id}/regenerar-token`, { method: 'POST' });
        fecharModal(); toast('Novo link gerado.'); verFicha(c.id);
      } catch (err) { toast(err.message, true); }
    });
  }

  function modalNovoPet(clienteId) {
    const modal = abrirModal(`
      <h3>Novo pet</h3>
      <form id="form-modal" style="display: flex; flex-direction: column; gap: 14px">
        <div class="campo"><label>Nome</label><input name="nome" required></div>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px">
          <div class="campo"><label>Raça</label><input name="raca"></div>
          <div class="campo"><label>Porte</label>
            <select name="porte"><option value="">—</option><option>pequeno</option><option>médio</option><option>grande</option></select>
          </div>
        </div>
        <div class="campo"><label>Observações</label><textarea name="observacoes" rows="2"></textarea></div>
        ${rodapeModal('Cadastrar')}
      </form>`);
    ligarFechar(modal);
    modal.querySelector('#form-modal').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const f = new FormData(ev.target);
      try {
        await api('/pets', { method: 'POST', body: {
          cliente_id: clienteId, nome: f.get('nome'),
          raca: f.get('raca'), porte: f.get('porte'), observacoes: f.get('observacoes'),
        }});
        fecharModal(); toast('Pet cadastrado.'); verFicha(clienteId);
      } catch (err) { toast(err.message, true); }
    });
  }

  function modalNovaVacina(c) {
    const modal = abrirModal(`
      <h3>Registrar vacina</h3>
      <form id="form-modal" style="display: flex; flex-direction: column; gap: 14px">
        <div class="campo"><label>Pet</label>
          <select name="pet_id" required>
            ${c.pets.map(p => `<option value="${p.id}">${esc(p.nome)}</option>`).join('')}
          </select>
        </div>
        <div class="campo"><label>Vacina</label>
          <input name="nome" list="lista-vacinas" placeholder="V10" required>
          <datalist id="lista-vacinas">
            <option value="V8"></option><option value="V10"></option>
            <option value="Antirrábica"></option><option value="Gripe canina"></option>
            <option value="Giárdia"></option><option value="V4 felina"></option>
          </datalist>
        </div>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px">
          <div class="campo"><label>Aplicada em</label>
            <input name="aplicada_em" type="date" value="${hojeISO()}" required></div>
          <div class="campo"><label>Reforço em (meses)</label>
            <input name="reforco_meses" type="number" min="1" max="120" step="1" value="12"></div>
        </div>
        <div class="campo"><label>Lote (opcional)</label><input name="lote"></div>
        ${rodapeModal('Registrar')}
      </form>`);
    ligarFechar(modal);
    aoEnviar(modal.querySelector('#form-modal'), async (ev) => {
      const f = new FormData(ev.target);
      try {
        await api('/extras/vacinas', { method: 'POST', body: {
          pet_id: parseInt(f.get('pet_id'), 10),
          nome: f.get('nome'),
          aplicada_em: f.get('aplicada_em'),
          reforco_meses: f.get('reforco_meses') ? parseInt(f.get('reforco_meses'), 10) : null,
          lote: f.get('lote'),
        }});
        fecharModal(); toast('Vacina registrada.'); verFicha(c.id);
      } catch (err) { toast(err.message, true); }
    });
  }

  function modalAjustarPacote(pacote, clienteId) {
    const modal = abrirModal(`
      <h3>Ajustar pacote</h3>
      <form id="form-modal" style="display: flex; flex-direction: column; gap: 14px">
        <div class="campo"><label>Validade (deixe vazio para sem validade)</label>
          <input name="validade_ate" type="date" value="${pacote.validade_ate ? String(pacote.validade_ate).slice(0, 10) : ''}">
        </div>
        ${rodapeModal('Salvar')}
      </form>
      <button class="btn-fantasma perigo" id="botao-cancelar-pacote" type="button">Cancelar pacote</button>`);
    ligarFechar(modal);
    modal.querySelector('#form-modal').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const f = new FormData(ev.target);
      try {
        await api(`/pacotes/${pacote.id}`, { method: 'PUT', body: { validade_ate: f.get('validade_ate') || null } });
        fecharModal(); toast('Pacote atualizado.'); verFicha(clienteId);
      } catch (err) { toast(err.message, true); }
    });
    modal.querySelector('#botao-cancelar-pacote').addEventListener('click', async () => {
      if (!window.confirm('Cancelar este pacote? Os créditos restantes deixam de valer.')) return;
      try {
        await api(`/pacotes/${pacote.id}`, { method: 'PUT', body: { status: 'CANCELADO' } });
        fecharModal(); toast('Pacote cancelado.'); verFicha(clienteId);
      } catch (err) { toast(err.message, true); }
    });
  }

  function modalReativarPacote(pacote, clienteId) {
    const exigeValidade = pacote.status === 'VENCIDO';
    const modal = abrirModal(`
      <h3>Reativar pacote</h3>
      <p style="font-size: 0.88rem; color: var(--text-muted); line-height: 1.5">
        ${esc(pacote.nome)} · restam ${pacote.saldo} crédito(s).
        ${exigeValidade ? 'O pacote está vencido — defina a nova validade.' : ''}
      </p>
      <form id="form-modal" style="display: flex; flex-direction: column; gap: 14px">
        <div class="campo"><label>${exigeValidade ? 'Nova validade' : 'Validade (opcional)'}</label>
          <input name="validade_ate" type="date" ${exigeValidade ? 'required' : ''}>
        </div>
        ${rodapeModal('Reativar')}
      </form>`);
    ligarFechar(modal);
    modal.querySelector('#form-modal').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const f = new FormData(ev.target);
      const corpo = { status: 'ATIVO' };
      if (f.get('validade_ate')) corpo.validade_ate = f.get('validade_ate');
      try {
        await api(`/pacotes/${pacote.id}`, { method: 'PUT', body: corpo });
        fecharModal(); toast('Pacote reativado.'); verFicha(clienteId);
      } catch (err) { toast(err.message, true); }
    });
  }

  // ═══ Vender pacote (itens por serviço) ═══════════════════════════

  function linhaItemAvulso(servicos) {
    return `
      <div style="display: grid; grid-template-columns: 1fr 90px 36px; gap: 8px" class="item-avulso">
        <select name="item_servico">
          ${servicos.map(s => `<option value="${s.id}">${esc(s.nome)}</option>`).join('')}
        </select>
        <input name="item_qtd" type="number" min="1" step="1" placeholder="qtde">
        <button type="button" class="btn-fantasma btn-mini" data-remover style="padding: 6px">×</button>
      </div>`;
  }

  async function modalVenderPacote(clienteId) {
    const [modelos, servicos] = await Promise.all([api('/pacotes/modelos'), carregarServicos()]);
    const modelosAtivos = modelos.filter(m => m.ativo);
    const servicosAtivos = servicos.filter(s => s.ativo);

    function descreverModelo(m) {
      const itens = (m.itens || []).map(i => `${i.quantidade} ${i.servico_nome}`).join(' + ');
      return `${m.nome} — ${itens} · ${formatarReais(m.valor_centavos)}`;
    }

    const modal = abrirModal(`
      <h3>Vender pacote</h3>
      <form id="form-modal" style="display: flex; flex-direction: column; gap: 14px">
        ${modelosAtivos.length ? `
        <div class="campo"><label>Pacote do catálogo</label>
          <select name="modelo_id">
            ${modelosAtivos.map(m => `<option value="${m.id}">${esc(descreverModelo(m))}</option>`).join('')}
            <option value="">Pacote avulso (montar abaixo)</option>
          </select>
        </div>` : `
        <p style="font-size: 0.85rem; color: var(--text-muted)">
          Nenhum modelo no catálogo — monte o pacote avulso abaixo${ehAdmin() ? ' ou cadastre modelos na aba Catálogo' : ''}.
        </p>`}
        <div id="campos-avulso" style="display: ${modelosAtivos.length ? 'none' : 'flex'}; flex-direction: column; gap: 12px">
          <div class="campo"><label>Nome do pacote</label><input name="nome" placeholder="Pacote 24 banhos"></div>
          <div class="campo"><label>Serviços incluídos</label>
            <div id="itens-avulso" style="display: flex; flex-direction: column; gap: 8px">
              ${linhaItemAvulso(servicosAtivos)}
            </div>
            <button type="button" class="btn-fantasma btn-mini" id="botao-mais-item" style="align-self: flex-start; margin-top: 6px">Adicionar serviço</button>
          </div>
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px">
            <div class="campo"><label>Valor (R$)</label><input name="valor" inputmode="decimal" placeholder="700,00"></div>
            <div class="campo"><label>Validade (meses)</label><input name="validade_meses" type="number" min="1" step="1" placeholder="12"></div>
          </div>
        </div>
        ${rodapeModal('Registrar venda')}
      </form>`);
    ligarFechar(modal);

    const seletor = modal.querySelector('[name="modelo_id"]');
    const camposAvulso = modal.querySelector('#campos-avulso');
    if (seletor) {
      seletor.addEventListener('change', () => {
        camposAvulso.style.display = seletor.value === '' ? 'flex' : 'none';
      });
    }
    const itensBox = modal.querySelector('#itens-avulso');
    modal.querySelector('#botao-mais-item').addEventListener('click', () => {
      itensBox.insertAdjacentHTML('beforeend', linhaItemAvulso(servicosAtivos));
      ligarRemover();
    });
    function ligarRemover() {
      itensBox.querySelectorAll('[data-remover]').forEach(b => {
        b.onclick = () => { if (itensBox.querySelectorAll('.item-avulso').length > 1) b.closest('.item-avulso').remove(); };
      });
    }
    ligarRemover();

    aoEnviar(modal.querySelector('#form-modal'), async (ev) => {
      const f = new FormData(ev.target);
      const modeloId = seletor ? seletor.value : '';
      try {
        const corpo = { cliente_id: clienteId };
        if (modeloId) {
          corpo.modelo_id = parseInt(modeloId, 10);
        } else {
          const centavos = paraCentavos(f.get('valor'));
          if (!Number.isFinite(centavos)) throw new Error('Informe o valor do pacote.');
          const itens = [...itensBox.querySelectorAll('.item-avulso')].map(linha => ({
            servico_id: parseInt(linha.querySelector('[name="item_servico"]').value, 10),
            quantidade: parseInt(linha.querySelector('[name="item_qtd"]').value, 10),
          })).filter(i => Number.isInteger(i.quantidade) && i.quantidade > 0);
          if (!itens.length) throw new Error('Informe a quantidade de pelo menos um serviço.');
          corpo.nome = f.get('nome');
          corpo.valor_centavos = centavos;
          corpo.validade_meses = f.get('validade_meses') ? parseInt(f.get('validade_meses'), 10) : null;
          corpo.itens = itens;
        }
        await api('/pacotes', { method: 'POST', body: corpo });
        fecharModal(); toast('Pacote registrado.');
        window.location.hash = `#/cliente/${clienteId}`;
        renderizar();
      } catch (err) { toast(err.message, true); }
    });
  }

  // ═══ Dar baixa (por serviço) ═════════════════════════════════════

  async function modalDarBaixa(clienteId) {
    const c = await api(`/clientes/${clienteId}`);
    const creditos = creditosDisponiveis(c);
    if (!creditos.size) { toast('Este cliente não tem créditos disponíveis — venda um pacote.', true); return; }

    const opcoes = [...creditos.entries()]
      .map(([id, info]) => `<option value="${id}">${esc(info.nome)} — ${info.total} crédito${info.total === 1 ? '' : 's'}</option>`)
      .join('');

    const modal = abrirModal(`
      <h3>Dar baixa — ${esc(c.nome)}</h3>
      <form id="form-modal" style="display: flex; flex-direction: column; gap: 14px">
        <div class="campo"><label>Serviço</label>
          <select name="servico_id">${opcoes}</select>
        </div>
        ${c.pets.length ? `
        <div class="campo"><label>Quais pets?</label>
          <div style="display: flex; flex-direction: column; gap: 8px; margin-top: 4px">
            ${c.pets.map(p => `
              <label style="display: flex; align-items: center; gap: 10px; font-size: 0.92rem; text-transform: none; letter-spacing: 0; font-weight: 500; color: var(--text-main); cursor: pointer">
                <input type="checkbox" name="pet" value="${p.id}" ${c.pets.length === 1 ? 'checked' : ''} style="width: 17px; height: 17px; accent-color: var(--primary)">
                ${esc(p.nome)}${p.raca ? ` <span style="color: var(--text-subtle)">· ${esc(p.raca)}</span>` : ''}
              </label>`).join('')}
          </div>
        </div>` : `
        <div class="campo"><label>Quantidade</label>
          <input name="quantidade" type="number" min="1" step="1" value="1">
        </div>`}
        <div class="campo"><label>Observação (opcional)</label><input name="observacao"></div>
        <div id="resumo-baixa" style="font-size: 0.88rem; color: var(--text-muted)"></div>
        ${rodapeModal('Confirmar baixa')}
      </form>`);
    ligarFechar(modal);

    const form = modal.querySelector('#form-modal');
    const resumo = modal.querySelector('#resumo-baixa');
    function totalItens() {
      if (c.pets.length) return [...form.querySelectorAll('[name="pet"]:checked')].length;
      return parseInt(form.querySelector('[name="quantidade"]').value, 10) || 0;
    }
    function atualizarResumo() {
      const n = totalItens();
      const servicoId = parseInt(form.querySelector('[name="servico_id"]').value, 10);
      const info = creditos.get(servicoId);
      if (!info) { resumo.textContent = ''; return; }
      if (n <= 0) { resumo.textContent = 'Selecione pelo menos um.'; return; }
      resumo.textContent = n > info.total
        ? `Créditos insuficientes de ${info.nome}: restam ${info.total}.`
        : `${n} × ${info.nome} — créditos: ${info.total} → ${info.total - n}.`;
    }
    form.addEventListener('change', atualizarResumo);
    form.addEventListener('input', atualizarResumo);
    atualizarResumo();

    aoEnviar(form, async () => {
      const f = new FormData(form);
      const servicoId = parseInt(f.get('servico_id'), 10);
      let itens;
      if (c.pets.length) {
        itens = [...form.querySelectorAll('[name="pet"]:checked')]
          .map(caixa => ({ pet_id: parseInt(caixa.value, 10), servico_id: servicoId }));
      } else {
        const n = parseInt(f.get('quantidade'), 10) || 0;
        itens = Array.from({ length: n }, () => ({ servico_id: servicoId }));
      }
      if (!itens.length) { toast('Selecione pelo menos um.', true); return; }
      try {
        const r = await api('/baixas', { method: 'POST', body: {
          cliente_id: clienteId, itens, observacao: f.get('observacao'),
        }});
        fecharModal();
        toast(`Baixa registrada. Créditos restantes: ${r.saldo}.`);
        renderizar();
      } catch (err) { toast(err.message, true); }
    });
  }

  // ═══ Catálogo (serviços + modelos de pacote) ═════════════════════

  async function verCatalogo() {
    const [servicos, modelos] = await Promise.all([carregarServicos(true), api('/pacotes/modelos')]);

    conteudo.innerHTML = `
      <div class="linha-cabecalho">
        <div class="cabecalho-pagina">
          <h2>Catálogo</h2>
          <p>Serviços com duração própria e os pacotes montados com eles</p>
        </div>
      </div>

      <div style="display: flex; justify-content: space-between; align-items: center">
        <div class="rotulo-secao">Serviços</div>
        ${ehAdmin() ? '<button class="btn-fantasma btn-mini" id="botao-novo-servico" type="button">Novo serviço</button>' : ''}
      </div>
      ${servicos.length ? `<div class="lista">${servicos.map(s => `
        <div class="linha" style="${s.ativo ? '' : 'opacity: 0.55'}">
          <div style="flex: 1">
            <div class="linha-titulo">${esc(s.nome)}</div>
            <div class="linha-sub">${s.duracao_minutos} minutos${s.preco_centavos ? ' · ' + formatarReais(s.preco_centavos) : ' · preço a combinar'}</div>
          </div>
          ${s.ativo ? '<span class="chip ok">Ativo</span>' : '<span class="chip">Inativo</span>'}
          ${ehAdmin() ? `<button class="btn-fantasma btn-mini" data-editar-servico="${s.id}" type="button">Editar</button>` : ''}
        </div>`).join('')}</div>`
      : '<div class="vazio">Nenhum serviço cadastrado.</div>'}

      <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 8px">
        <div class="rotulo-secao">Modelos de pacote</div>
        ${ehAdmin() ? '<button class="btn-fantasma btn-mini" id="botao-novo-modelo" type="button">Novo modelo</button>' : ''}
      </div>
      ${modelos.length ? `<div class="lista">${modelos.map(m => `
        <div class="linha" style="${m.ativo ? '' : 'opacity: 0.55'}">
          <div style="flex: 1">
            <div class="linha-titulo">${esc(m.nome)}</div>
            <div class="linha-sub">
              ${(m.itens || []).map(i => `${i.quantidade} ${esc(i.servico_nome)}`).join(' + ') || 'sem itens'}
              · ${formatarReais(m.valor_centavos)}
              ${m.validade_meses ? ` · validade ${m.validade_meses} meses` : ' · sem validade'}
            </div>
          </div>
          ${m.ativo ? '<span class="chip ok">Ativo</span>' : '<span class="chip">Inativo</span>'}
          ${ehAdmin() ? `<button class="btn-fantasma btn-mini" data-editar-modelo="${m.id}" type="button">Editar</button>` : ''}
        </div>`).join('')}</div>`
      : `<div class="vazio">Nenhum modelo cadastrado.${ehAdmin() ? '<br>Exemplo: Pacote 24 banhos — 24 × Banho, R$ 700,00.' : ''}</div>`}`;

    const botaoServico = document.getElementById('botao-novo-servico');
    if (botaoServico) botaoServico.addEventListener('click', () => modalServico(null));
    conteudo.querySelectorAll('[data-editar-servico]').forEach(b =>
      b.addEventListener('click', () => {
        const s = servicos.find(x => x.id === parseInt(b.dataset.editarServico, 10));
        if (s) modalServico(s);
      }));

    const botaoModelo = document.getElementById('botao-novo-modelo');
    if (botaoModelo) botaoModelo.addEventListener('click', () => modalModelo(null, servicos));
    conteudo.querySelectorAll('[data-editar-modelo]').forEach(b =>
      b.addEventListener('click', () => {
        const m = modelos.find(x => x.id === parseInt(b.dataset.editarModelo, 10));
        if (m) modalModelo(m, servicos);
      }));
  }

  function modalServico(s) {
    const modal = abrirModal(`
      <h3>${s ? 'Editar serviço' : 'Novo serviço'}</h3>
      <form id="form-modal" style="display: flex; flex-direction: column; gap: 14px">
        <div class="campo"><label>Nome</label><input name="nome" value="${s ? esc(s.nome) : ''}" placeholder="Banho e tosa" required></div>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px">
          <div class="campo"><label>Duração (minutos)
            ${dica('Quanto tempo o serviço ocupa na agenda: um banho de 60 minutos marcado às 10:00 deixa o horário ocupado até as 11:00. O aplicativo só oferece horários em que o serviço cabe inteiro.')}</label><input name="duracao" type="number" min="5" step="5" value="${s ? s.duracao_minutos : ''}" placeholder="45" required></div>
          <div class="campo"><label>Preço avulso (R$)
            ${dica('O preço de UMA vez, para quem não tem pacote. Pode deixar vazio se este serviço só sai dentro de pacote.')}</label><input name="preco" inputmode="decimal" value="${s && s.preco_centavos ? (s.preco_centavos / 100).toFixed(2).replace('.', ',') : ''}" placeholder="80,00"></div>
        </div>
        ${s ? `
        <label style="display: flex; align-items: center; gap: 10px; font-size: 0.9rem; cursor: pointer">
          <input type="checkbox" name="ativo" ${s.ativo ? 'checked' : ''} style="width: 17px; height: 17px; accent-color: var(--primary)">
          Disponível para agendamento e venda
        </label>` : ''}
        ${rodapeModal(s ? 'Salvar' : 'Cadastrar')}
      </form>`);
    ligarFechar(modal);
    modal.querySelector('#form-modal').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const f = new FormData(ev.target);
      const preco = String(f.get('preco') || '').trim() ? paraCentavos(f.get('preco')) : 0;
      if (!Number.isFinite(preco)) { toast('Preço inválido.', true); return; }
      const corpo = {
        nome: f.get('nome'),
        duracao_minutos: parseInt(f.get('duracao'), 10),
        preco_centavos: preco,
      };
      try {
        if (s) {
          corpo.ativo = f.get('ativo') === 'on';
          await api(`/servicos/${s.id}`, { method: 'PUT', body: corpo });
        } else {
          await api('/servicos', { method: 'POST', body: corpo });
        }
        fecharModal(); toast('Catálogo atualizado.'); verCatalogo();
      } catch (err) { toast(err.message, true); }
    });
  }

  function linhaItemModelo(servicos, item) {
    return `
      <div style="display: grid; grid-template-columns: 1fr 90px 36px; gap: 8px" class="item-modelo">
        <select name="item_servico">
          ${servicos.map(s => `<option value="${s.id}" ${item && item.servico_id === s.id ? 'selected' : ''}>${esc(s.nome)}</option>`).join('')}
        </select>
        <input name="item_qtd" type="number" min="1" step="1" value="${item ? item.quantidade : ''}" placeholder="qtde">
        <button type="button" class="btn-fantasma btn-mini" data-remover style="padding: 6px">×</button>
      </div>`;
  }

  function modalModelo(m, servicos) {
    const servicosAtivos = servicos.filter(s => s.ativo);
    if (!servicosAtivos.length) { toast('Cadastre um serviço primeiro.', true); return; }
    const itensIniciais = m && m.itens && m.itens.length ? m.itens : [null];

    const modal = abrirModal(`
      <h3>${m ? 'Editar modelo' : 'Novo modelo de pacote'}</h3>
      <form id="form-modal" style="display: flex; flex-direction: column; gap: 14px">
        <div class="campo"><label>Nome</label><input name="nome" value="${m ? esc(m.nome) : ''}" placeholder="Pacote 24 banhos" required></div>
        <div class="campo"><label>Serviços incluídos</label>
          <div id="itens-modelo" style="display: flex; flex-direction: column; gap: 8px">
            ${itensIniciais.map(item => linhaItemModelo(servicosAtivos, item)).join('')}
          </div>
          <button type="button" class="btn-fantasma btn-mini" id="botao-mais-item" style="align-self: flex-start; margin-top: 6px">Adicionar serviço</button>
        </div>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px">
          <div class="campo"><label>Valor (R$)
            ${dica('O preço do pacote fechado — é o que o cliente paga, no balcão ou pelo aplicativo. Ex.: 24 banhos por R$ 700,00.')}</label><input name="valor" inputmode="decimal" value="${m ? (m.valor_centavos / 100).toFixed(2).replace('.', ',') : ''}" placeholder="700,00" required></div>
          <div class="campo"><label>Validade (meses)
            ${dica('Prazo para usar os créditos, contado do dia da venda. Vencido, o sistema bloqueia a baixa e avisa. Deixe vazio para nunca vencer.')}</label><input name="validade_meses" type="number" min="1" step="1" value="${m && m.validade_meses ? m.validade_meses : ''}" placeholder="12"></div>
        </div>
        ${m ? `
        <label style="display: flex; align-items: center; gap: 10px; font-size: 0.9rem; cursor: pointer">
          <input type="checkbox" name="ativo" ${m.ativo ? 'checked' : ''} style="width: 17px; height: 17px; accent-color: var(--primary)">
          Disponível para venda
        </label>` : ''}
        ${rodapeModal(m ? 'Salvar' : 'Cadastrar')}
      </form>`);
    ligarFechar(modal);

    const itensBox = modal.querySelector('#itens-modelo');
    modal.querySelector('#botao-mais-item').addEventListener('click', () => {
      itensBox.insertAdjacentHTML('beforeend', linhaItemModelo(servicosAtivos, null));
      ligarRemover();
    });
    function ligarRemover() {
      itensBox.querySelectorAll('[data-remover]').forEach(b => {
        b.onclick = () => { if (itensBox.querySelectorAll('.item-modelo').length > 1) b.closest('.item-modelo').remove(); };
      });
    }
    ligarRemover();

    modal.querySelector('#form-modal').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const f = new FormData(ev.target);
      const centavos = paraCentavos(f.get('valor'));
      if (!Number.isFinite(centavos)) { toast('Valor inválido.', true); return; }
      const itens = [...itensBox.querySelectorAll('.item-modelo')].map(linha => ({
        servico_id: parseInt(linha.querySelector('[name="item_servico"]').value, 10),
        quantidade: parseInt(linha.querySelector('[name="item_qtd"]').value, 10),
      })).filter(i => Number.isInteger(i.quantidade) && i.quantidade > 0);
      if (!itens.length) { toast('Informe a quantidade de pelo menos um serviço.', true); return; }
      const corpo = {
        nome: f.get('nome'), valor_centavos: centavos,
        validade_meses: f.get('validade_meses') ? parseInt(f.get('validade_meses'), 10) : null,
        itens,
      };
      try {
        if (m) {
          corpo.ativo = f.get('ativo') === 'on';
          await api(`/pacotes/modelos/${m.id}`, { method: 'PUT', body: corpo });
        } else {
          await api('/pacotes/modelos', { method: 'POST', body: corpo });
        }
        fecharModal(); toast('Catálogo atualizado.'); verCatalogo();
      } catch (err) { toast(err.message, true); }
    });
  }

  // ═══ Loja (produtos e pedidos) ═══════════════════════════════════

  const STATUS_PEDIDO_ROTULO = {
    AGUARDANDO_PAGAMENTO: 'Aguardando pagamento', PAGO: 'Pago',
    SEPARADO: 'Separado', EM_ROTA: 'Em rota', ENTREGUE: 'Entregue', CANCELADO: 'Cancelado',
  };
  const STATUS_PEDIDO_CHIP = {
    AGUARDANDO_PAGAMENTO: '', PAGO: 'acento', SEPARADO: 'acento',
    EM_ROTA: 'acento', ENTREGUE: 'ok', CANCELADO: 'alerta',
  };
  const PROXIMO_STATUS = { PAGO: 'SEPARADO', SEPARADO: 'EM_ROTA', EM_ROTA: 'ENTREGUE' };

  async function verLoja() {
    const [produtos, pedidos] = await Promise.all([api('/loja/produtos'), api('/loja/pedidos')]);
    const abertos = pedidos.filter(p => !['ENTREGUE', 'CANCELADO'].includes(p.status));

    conteudo.innerHTML = `
      <div class="linha-cabecalho">
        <div class="cabecalho-pagina">
          <h2>Loja</h2>
          <p>Produtos para venda no aplicativo e os pedidos do dia</p>
        </div>
        ${ehAdmin() ? '<button class="btn-primario" id="botao-novo-produto" type="button">Novo produto</button>' : ''}
      </div>

      <div class="rotulo-secao">Pedidos abertos</div>
      ${abertos.length ? `<div class="lista">${abertos.map(p => `
        <div class="linha">
          <div class="linha-data" style="min-width: 52px">#${p.id}</div>
          <div style="flex: 1; min-width: 160px">
            <div class="linha-titulo">${esc(p.cliente_nome)}</div>
            <div class="linha-sub">
              ${(p.itens || []).map(i => `${i.quantidade}× ${esc(i.produto_nome)}`).join(', ')}
              · ${formatarReais(p.valor_centavos)}
            </div>
            ${p.entrega === 'ENTREGA' ? `<div class="linha-sub">Entregar em: ${esc(p.endereco || 'endereço não informado')}${p.entrega_data ? ` · rota ${dataCurta(p.entrega_data)} às ${p.entrega_inicio}` : ''}</div>` : '<div class="linha-sub">Retirada no balcão</div>'}
          </div>
          <span class="chip ${STATUS_PEDIDO_CHIP[p.status] || ''}">${esc(STATUS_PEDIDO_ROTULO[p.status] || p.status)}</span>
          ${PROXIMO_STATUS[p.status] ? `<button class="btn-primario btn-mini" data-avancar="${p.id}" data-para="${PROXIMO_STATUS[p.status]}" type="button">${esc(STATUS_PEDIDO_ROTULO[PROXIMO_STATUS[p.status]])}</button>` : ''}
          ${p.entrega === 'ENTREGA' && ['PAGO', 'SEPARADO', 'EM_ROTA'].includes(p.status)
            ? `<button class="btn-fantasma btn-mini" data-rota="${p.id}" type="button">${p.entrega_data ? 'Remarcar' : 'Pôr na rota'}</button>` : ''}
          <button class="btn-fantasma btn-mini perigo" data-cancelar-pedido="${p.id}" type="button">Cancelar</button>
        </div>`).join('')}</div>`
      : '<div class="vazio">Nenhum pedido aberto.</div>'}

      <div class="rotulo-secao" style="margin-top: 8px">Produtos</div>
      ${produtos.length ? `<div class="lista">${produtos.map(p => `
        <div class="linha" style="${p.ativo ? '' : 'opacity: 0.55'}">
          ${p.tem_foto
            ? `<img alt="" data-img="/api/loja/produtos/${p.id}/foto?v=${esc(p.foto_versao || '')}"
                 decoding="async" width="48" height="48"
                 style="width: 48px; height: 48px; object-fit: cover; border-radius: 10px; border: 1px solid var(--border); flex-shrink: 0; background: var(--bg-inset)">`
            : '<div class="avatar" style="border-radius: 10px">' + ICONES.pata + '</div>'}
          <div style="flex: 1">
            <div class="linha-titulo">${esc(p.nome)}</div>
            <div class="linha-sub">${formatarReais(p.preco_centavos)}${p.controla_estoque ? ` · ${p.estoque} em estoque` : ' · estoque livre'}${p.descricao ? ` · ${esc(p.descricao)}` : ''}</div>
          </div>
          ${p.controla_estoque && p.estoque === 0 ? '<span class="chip alerta">Sem estoque</span>' : (p.ativo ? '<span class="chip ok">À venda</span>' : '<span class="chip">Inativo</span>')}
          ${ehAdmin() ? `<button class="btn-fantasma btn-mini" data-editar-produto="${p.id}" type="button">Editar</button>` : ''}
        </div>`).join('')}</div>`
      : `<div class="vazio">Nenhum produto cadastrado.${ehAdmin() ? '<br>Cadastre a ração e os petiscos que o cliente pode pedir pelo aplicativo.' : ''}</div>`}`;

    pintarImagens(conteudo);

    const bNovo = document.getElementById('botao-novo-produto');
    if (bNovo) bNovo.addEventListener('click', () => modalProduto(null));
    conteudo.querySelectorAll('[data-editar-produto]').forEach(b =>
      b.addEventListener('click', () => {
        const p = produtos.find(x => x.id === parseInt(b.dataset.editarProduto, 10));
        if (p) modalProduto(p);
      }));

    conteudo.querySelectorAll('[data-avancar]').forEach(b =>
      b.addEventListener('click', async () => {
        try {
          await api(`/loja/pedidos/${b.dataset.avancar}`, { method: 'PUT', body: { status: b.dataset.para } });
          toast('Pedido atualizado.'); verLoja();
        } catch (err) { toast(err.message, true); }
      }));

    conteudo.querySelectorAll('[data-cancelar-pedido]').forEach(b =>
      b.addEventListener('click', async () => {
        if (!window.confirm('Cancelar o pedido? O estoque volta e a entrega sai da rota.')) return;
        try {
          await api(`/loja/pedidos/${b.dataset.cancelarPedido}`, { method: 'PUT', body: { status: 'CANCELADO' } });
          toast('Pedido cancelado.'); verLoja();
        } catch (err) { toast(err.message, true); }
      }));

    conteudo.querySelectorAll('[data-rota]').forEach(b =>
      b.addEventListener('click', () => {
        const modal = abrirModal(`
          <h3>Entrega na rota</h3>
          <p style="font-size: 0.88rem; color: var(--text-muted)">
            O pedido entra na agenda do veículo no primeiro horário livre do dia escolhido.
          </p>
          <form id="form-modal" style="display: flex; flex-direction: column; gap: 14px">
            <div class="campo"><label>Dia da entrega</label>
              <input name="data" type="date" min="${hojeISO()}" value="${hojeISO()}" required></div>
            ${rodapeModal('Pôr na rota')}
          </form>`);
        ligarFechar(modal);
        aoEnviar(modal.querySelector('#form-modal'), async (ev) => {
          const f = new FormData(ev.target);
          try {
            const r = await api(`/loja/pedidos/${b.dataset.rota}/entrega`, { method: 'POST', body: { data: f.get('data') } });
            fecharModal(); toast(`Entrega marcada para ${dataCurta(r.data)} às ${r.inicio}.`); verLoja();
          } catch (err) { toast(err.message, true); }
        });
      }));
  }

  function modalProduto(p) {
    const modal = abrirModal(`
      <h3>${p ? 'Editar produto' : 'Novo produto'}</h3>
      <form id="form-modal" style="display: flex; flex-direction: column; gap: 14px">
        <div class="campo"><label>Nome</label><input name="nome" value="${p ? esc(p.nome) : ''}" placeholder="Ração Premium 10kg" required></div>
        <div class="campo"><label>Descrição</label><textarea name="descricao" rows="2">${p ? esc(p.descricao || '') : ''}</textarea></div>
        <div class="campo"><label>Foto do produto</label>
          <div style="display: flex; align-items: center; gap: 12px">
            <img id="previa-foto" alt="" ${p && p.tem_foto ? `data-img="/api/loja/produtos/${p.id}/foto?v=${esc(p.foto_versao || '')}"` : ''}
                 style="width: 72px; height: 72px; object-fit: cover; border-radius: 12px; border: 1px solid var(--border); background: var(--bg-inset); ${p && p.tem_foto ? '' : 'display: none'}">
            <label class="btn-fantasma btn-mini" style="cursor: pointer">
              ${p && p.tem_foto ? 'Trocar foto' : 'Escolher foto'}
              <input type="file" id="campo-foto-produto" accept="image/*" style="display: none">
            </label>
            ${p && p.tem_foto ? '<button type="button" class="btn-fantasma btn-mini perigo" id="botao-tirar-foto">Remover</button>' : ''}
          </div>
        </div>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px">
          <div class="campo"><label>Preço (R$)</label><input name="preco" inputmode="decimal" value="${p ? (p.preco_centavos / 100).toFixed(2).replace('.', ',') : ''}" placeholder="250,00" required></div>
          <div class="campo"><label>Estoque
            ${dica('Quantas unidades você tem agora. Cada venda desconta sozinha, e o produto some da loja quando zera.')}</label><input name="estoque" type="number" min="0" step="1" value="${p ? p.estoque : '0'}" required></div>
        </div>
        <label style="display: flex; align-items: center; gap: 10px; font-size: 0.9rem; cursor: pointer">
          <input type="checkbox" name="controla_estoque" ${!p || p.controla_estoque ? 'checked' : ''} style="width: 17px; height: 17px; accent-color: var(--primary)">
          Controlar estoque (desligue para produto sob encomenda)
        </label>
        ${p ? `
        <label style="display: flex; align-items: center; gap: 10px; font-size: 0.9rem; cursor: pointer">
          <input type="checkbox" name="ativo" ${p.ativo ? 'checked' : ''} style="width: 17px; height: 17px; accent-color: var(--primary)">
          À venda no aplicativo
        </label>` : ''}
        ${rodapeModal(p ? 'Salvar' : 'Cadastrar')}
      </form>`);
    ligarFechar(modal);

    // A foto é reduzida no navegador; `fotoEscolhida` guarda o resultado.
    // undefined = não mexer, null = remover, string = trocar.
    let fotoEscolhida;
    const previa = modal.querySelector('#previa-foto');
    modal.querySelector('#campo-foto-produto').addEventListener('change', async (ev) => {
      const arquivo = ev.target.files && ev.target.files[0];
      if (!arquivo) return;
      try {
        fotoEscolhida = await reduzirImagem(arquivo);
        previa.src = fotoEscolhida;
        previa.style.display = 'block';
      } catch (err) { toast(err.message, true); }
    });
    const botaoTirar = modal.querySelector('#botao-tirar-foto');
    if (botaoTirar) botaoTirar.addEventListener('click', () => {
      fotoEscolhida = null;
      previa.style.display = 'none';
      toast('A foto sai ao salvar.');
    });

    aoEnviar(modal.querySelector('#form-modal'), async (ev) => {
      const f = new FormData(ev.target);
      const centavos = paraCentavos(f.get('preco'));
      if (!Number.isFinite(centavos)) { toast('Preço inválido.', true); return; }
      const corpo = {
        nome: f.get('nome'), descricao: f.get('descricao'),
        preco_centavos: centavos, estoque: parseInt(f.get('estoque'), 10) || 0,
        controla_estoque: f.get('controla_estoque') === 'on',
        ...(fotoEscolhida !== undefined ? { foto: fotoEscolhida } : {}),
        // O servidor aplica a diferença, para não desfazer venda feita
        // enquanto esta tela estava aberta.
        estoque_visto: p ? p.estoque : undefined,
      };
      try {
        if (p) {
          corpo.ativo = f.get('ativo') === 'on';
          await api(`/loja/produtos/${p.id}`, { method: 'PUT', body: corpo });
        } else {
          await api('/loja/produtos', { method: 'POST', body: corpo });
        }
        fecharModal(); toast('Loja atualizada.'); verLoja();
      } catch (err) { toast(err.message, true); }
    });
  }

  // ═══ Relatórios ══════════════════════════════════════════════════

  async function verRelatorios() {
    const [r, reforcos, fila] = await Promise.all([
      api('/extras/relatorios?dias=30'),
      api('/extras/vacinas/reforcos?dias=45'),
      api('/extras/fila'),
    ]);

    const concluidos = (r.agendamentos.find(a => a.status === 'CONCLUIDO') || {}).total || 0;
    const faltas = (r.agendamentos.find(a => a.status === 'FALTOU') || {}).total || 0;
    const cancelados = (r.agendamentos.find(a => a.status === 'CANCELADO') || {}).total || 0;
    const maxServico = Math.max(1, ...r.servicos_realizados.map(s => s.total));

    conteudo.innerHTML = `
      <div class="cabecalho-pagina">
        <h2>Relatórios</h2>
        <p>Últimos ${r.dias} dias</p>
      </div>

      <div class="kpis">
        <div class="cartao kpi">
          <div><div class="kpi-rotulo">Pacotes vendidos</div>
            <div class="kpi-valor">${r.pacotes_vendidos.total}</div>
            <div class="linha-sub">${formatarReais(r.pacotes_vendidos.valor_centavos)}</div></div>
        </div>
        <div class="cartao kpi">
          <div><div class="kpi-rotulo">Produtos vendidos</div>
            <div class="kpi-valor">${r.produtos_vendidos.total}</div>
            <div class="linha-sub">${formatarReais(r.produtos_vendidos.valor_centavos)}</div></div>
        </div>
        <div class="cartao kpi">
          <div><div class="kpi-rotulo">Atendimentos</div>
            <div class="kpi-valor">${concluidos}</div>
            <div class="linha-sub">${faltas} falta(s) · ${cancelados} cancelado(s)</div></div>
        </div>
        <div class="cartao kpi">
          <div><div class="kpi-rotulo">Avaliação</div>
            <div class="kpi-valor">${r.avaliacoes.total ? r.avaliacoes.media.toFixed(1) : '—'}</div>
            <div class="linha-sub">${r.avaliacoes.total} avaliação(ões)</div></div>
        </div>
      </div>

      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 20px">
        <div class="cartao" style="padding: 24px; display: flex; flex-direction: column; gap: 14px">
          <div class="rotulo-secao">Serviços realizados</div>
          ${r.servicos_realizados.length ? r.servicos_realizados.map(s => `
            <div style="display: flex; align-items: center; gap: 12px">
              <div style="flex: 1; font-size: 0.9rem; font-weight: 600">${esc(s.servico)}</div>
              <div class="barra" style="width: 120px"><div style="width: ${Math.round((s.total / maxServico) * 100)}%"></div></div>
              <div style="font-variant-numeric: tabular-nums; font-size: 0.9rem; min-width: 28px; text-align: right">${s.total}</div>
            </div>`).join('') : '<div class="linha-sub">Nenhum serviço no período.</div>'}
        </div>

        <div class="cartao" style="padding: 24px; display: flex; flex-direction: column; gap: 12px">
          <div class="rotulo-secao">Reforços de vacina a vencer</div>
          ${reforcos.length ? reforcos.map(v => `
            <div class="linha linha-inset" style="padding: 10px 14px">
              <div class="linha-data" style="font-size: 1rem">${dataCurta(v.reforco_em)}</div>
              <div style="flex: 1">
                <div class="linha-titulo" style="font-size: 0.9rem">${esc(v.pet_nome)} · ${esc(v.nome)}</div>
                <div class="linha-sub"><a href="#/cliente/${v.cliente_id}">${esc(v.cliente_nome)}</a>${v.telefone ? ' · ' + esc(v.telefone) : ''}</div>
              </div>
              ${v.telefone ? `<a class="btn-fantasma btn-mini" style="text-decoration: none" target="_blank" rel="noopener"
                href="https://wa.me/${esc(numeroWhatsApp(v.telefone))}?text=${encodeURIComponent(`Olá! A vacina ${v.nome} do(a) ${v.pet_nome} vence em ${dataLonga(v.reforco_em)}. Quer agendar?`)}">Avisar</a>` : ''}
            </div>`).join('') : '<div class="linha-sub">Nenhum reforço próximo.</div>'}
        </div>

        <div class="cartao" style="padding: 24px; display: flex; flex-direction: column; gap: 12px">
          <div class="rotulo-secao">Fila de encaixe</div>
          ${fila.length ? fila.map(f => `
            <div class="linha linha-inset" style="padding: 10px 14px">
              <div class="linha-data" style="font-size: 1rem">${dataCurta(f.data)}</div>
              <div style="flex: 1">
                <div class="linha-titulo" style="font-size: 0.9rem">${esc(f.cliente_nome)}${f.pet_nome ? ' · ' + esc(f.pet_nome) : ''}</div>
                <div class="linha-sub">${esc(f.servico_nome)} · ${esc(f.periodo.toLowerCase())}</div>
              </div>
              ${f.telefone ? `<a class="btn-fantasma btn-mini" style="text-decoration: none" target="_blank" rel="noopener"
                href="https://wa.me/${esc(numeroWhatsApp(f.telefone))}?text=${encodeURIComponent(`Olá! Abriu um horário para ${f.servico_nome} em ${dataLonga(f.data)}. Quer?`)}">Oferecer</a>` : ''}
              <button class="btn-fantasma btn-mini" data-fila-ok="${f.id}" type="button">Encaixado</button>
              <button class="btn-fantasma btn-mini perigo" data-fila-nao="${f.id}" type="button">Desistiu</button>
            </div>`).join('') : '<div class="linha-sub">Ninguém esperando encaixe.</div>'}
        </div>

        <div class="cartao" style="padding: 24px; display: flex; flex-direction: column; gap: 12px">
          <div class="rotulo-secao">Clientes sumidos (60+ dias)</div>
          ${r.clientes_sumidos.length ? r.clientes_sumidos.map(c => `
            <div class="linha linha-inset" style="padding: 10px 14px">
              <div style="flex: 1">
                <div class="linha-titulo" style="font-size: 0.9rem"><a href="#/cliente/${c.id}">${esc(c.nome)}</a></div>
                <div class="linha-sub">${c.ultima_visita ? 'última visita ' + dataLonga(c.ultima_visita) : 'nunca veio'}</div>
              </div>
              ${c.telefone ? `<a class="btn-fantasma btn-mini" style="text-decoration: none" target="_blank" rel="noopener"
                href="https://wa.me/${esc(numeroWhatsApp(c.telefone))}?text=${encodeURIComponent('Olá! Sentimos falta do seu pet por aqui. Quer agendar um horário?')}">Chamar</a>` : ''}
            </div>`).join('') : '<div class="linha-sub">Nenhum cliente sumido.</div>'}
          ${r.pacotes_a_vencer > 0 ? `<div class="faixa-aviso" style="margin-top: 6px">${r.pacotes_a_vencer} pacote(s) vencem no próximo mês — vale avisar os donos.</div>` : ''}
        </div>
      </div>`;

    conteudo.querySelectorAll('[data-fila-ok]').forEach(b =>
      b.addEventListener('click', async () => {
        try {
          await api(`/extras/fila/${b.dataset.filaOk}`, { method: 'PUT', body: { status: 'ATENDIDO' } });
          toast('Encaixe registrado.'); verRelatorios();
        } catch (err) { toast(err.message, true); }
      }));
    conteudo.querySelectorAll('[data-fila-nao]').forEach(b =>
      b.addEventListener('click', async () => {
        try {
          await api(`/extras/fila/${b.dataset.filaNao}`, { method: 'PUT', body: { status: 'DESISTIU' } });
          toast('Retirado da fila.'); verRelatorios();
        } catch (err) { toast(err.message, true); }
      }));
  }

  /** Coloca a logo e o nome do petshop no topo do painel. */
  function enderecoPublico() {
    return `${window.location.origin}/${sessao.empresa.slug}`;
  }

  function textoConviteVitrine() {
    return `Olá! Agora você acompanha os banhos, o saldo do pacote e agenda horário do seu pet pelo celular. ` +
      `Crie a sua conta aqui: ${enderecoPublico()}`;
  }

  function aplicarIdentidade() {
    if (!sessao) return;
    document.getElementById('nome-empresa').textContent = sessao.empresa.nome;
    const caixa = document.querySelector('.marca-icone');
    if (!caixa) return;
    if (sessao.empresa.tem_logo) {
      caixa.innerHTML = `<img alt="" data-img="/api/empresa/logo?v=${esc(sessao.empresa.logo_versao || '')}"
        style="width: 100%; height: 100%; object-fit: contain; border-radius: 10px">`;
      caixa.style.padding = '2px';
      caixa.style.background = 'var(--bg-panel)';
      pintarImagens(caixa);
    } else {
      // Removeu a logo: volta o ícone, senão a imagem antiga fica na tela.
      caixa.innerHTML = ICONES.pata;
      caixa.style.padding = '';
      caixa.style.background = '';
    }
  }

  // As rotas de imagem do painel exigem autenticação, e a tag <img> não
  // manda cabeçalho. Buscamos por fetch e apontamos para um blob local —
  // cada imagem viaja uma vez por sessão, sob demanda.
  const cacheImagens = new Map();

  async function pintarImagem(el, caminho) {
    if (!el) return;
    if (cacheImagens.has(caminho)) { el.src = cacheImagens.get(caminho); return; }
    try {
      const resp = await fetch(caminho, {
        headers: { Authorization: `Bearer ${localStorage.getItem('saferpet_token') || ''}` },
      });
      if (!resp.ok) return;
      const url = URL.createObjectURL(await resp.blob());
      cacheImagens.set(caminho, url);
      el.src = url;
    } catch (_e) { /* imagem é enfeite: falhar não quebra a tela */ }
  }

  /** Pinta todas as imagens marcadas com data-img no container dado. */
  function pintarImagens(raiz) {
    (raiz || document).querySelectorAll('[data-img]').forEach(el => {
      pintarImagem(el, el.dataset.img);
    });
  }

  function numeroWhatsApp(telefone) {
    const limpo = String(telefone || '').replace(/\D/g, '');
    if (!limpo) return '';
    return limpo.length <= 11 ? '55' + limpo : limpo;
  }

  /**
   * Reduz a foto no próprio navegador antes de enviar: 1200px no maior
   * lado, JPEG 0.72. Uma foto de celular de 4 MB vira ~200 KB.
   */
  function reduzirImagem(arquivo, ladoMaximo, limiteBytes) {
    const LADO = ladoMaximo || 1200;
    const LIMITE = limiteBytes || 700 * 1024;
    return new Promise((resolve, reject) => {
      const leitor = new FileReader();
      leitor.onerror = () => reject(new Error('Não consegui ler a foto.'));
      leitor.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error('Arquivo não é uma imagem válida.'));
        img.onload = () => {
          const maior = Math.max(img.width, img.height);
          const escala = maior > LADO ? LADO / maior : 1;
          const tela = document.createElement('canvas');
          tela.width = Math.round(img.width * escala);
          tela.height = Math.round(img.height * escala);
          tela.getContext('2d').drawImage(img, 0, 0, tela.width, tela.height);
          const dados = tela.toDataURL('image/jpeg', 0.72);
          if (dados.length > LIMITE) {
            reject(new Error('Foto muito grande mesmo depois de reduzir. Tente outra.'));
            return;
          }
          resolve(dados);
        };
        img.src = leitor.result;
      };
      leitor.readAsDataURL(arquivo);
    });
  }

  // ═══ Assinatura (o petshop paga a SaferSoftware) ═════════════════

  const SITUACAO_ASSINATURA = {
    APROVADO: 'ok', PENDENTE: '', EXPIRADA: '', DIVERGENTE: 'alerta',
    PENDENTE_MANUAL: 'alerta', ERRO: 'alerta', ESTORNADO: 'alerta',
    DUPLICADO: 'alerta',
  };

  async function verAssinatura() {
    if (!ehAdmin()) {
      conteudo.innerHTML = `
        <div class="cabecalho-pagina"><h2>Assinatura</h2></div>
        <div class="vazio">Apenas administradores acessam a assinatura.</div>`;
      return;
    }
    const a = await api('/assinatura');
    const dias = a.dias_restantes;
    const alerta = !a.vigente || dias <= 7;

    conteudo.innerHTML = `
      <div class="cabecalho-pagina">
        <h2>Assinatura</h2>
        <p>Seu plano do SaferPet</p>
      </div>

      ${!a.vigente ? `
        <div class="faixa-aviso">
          Seu acesso venceu em ${dataLonga(a.acesso_ate)}. Os dados estão guardados —
          renove abaixo para o petshop voltar a usar o sistema.
        </div>` : (dias <= 7 ? `
        <div class="faixa-aviso">
          Seu acesso vence em ${dias} dia${dias === 1 ? '' : 's'} (${dataLonga(a.acesso_ate)}).
          Renove para não interromper o atendimento.
        </div>` : '')}

      <div class="cartao" style="padding: 24px; display: flex; flex-direction: column; gap: 12px; max-width: 560px">
        <div class="rotulo-secao">Situação</div>
        <div style="display: flex; align-items: baseline; gap: 12px">
          <div class="kpi-valor" style="color: ${alerta ? 'var(--danger)' : 'var(--success)'}">
            ${a.vigente ? dias : 0}
          </div>
          <div style="color: var(--text-muted)">
            ${a.vigente ? `dia${dias === 1 ? '' : 's'} de acesso restante${dias === 1 ? '' : 's'}` : 'acesso vencido'}
          </div>
        </div>
        <div class="linha-sub">
          Plano ${esc(a.plano)} · ${a.vigente ? 'válido até' : 'venceu em'} ${dataLonga(a.acesso_ate)}
        </div>
      </div>

      ${a.cobranca_disponivel ? `
      <div class="rotulo-secao">Renovar</div>
      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 16px; max-width: 700px">
        ${a.planos.map(p => `
          <div class="cartao" style="padding: 22px; display: flex; flex-direction: column; gap: 12px">
            <div>
              <h3 style="font-size: 1.2rem">${esc(p.nome)}</h3>
              <div class="linha-sub">${esc(p.descricao)}</div>
            </div>
            <div style="display: flex; align-items: baseline; gap: 6px">
              <div style="font-family: var(--fonte-titulo); font-size: 2rem; font-weight: 550">${formatarReais(p.valor_centavos)}</div>
              <div style="color: var(--text-muted); font-size: 0.85rem">/ ${p.dias === 365 ? 'ano' : 'mês'}</div>
            </div>
            <button class="btn-primario" data-pagar="${esc(p.periodo)}" type="button">Pagar com Pix ou cartão</button>
          </div>`).join('')}
      </div>
      <div class="linha-sub" style="max-width: 560px">
        O pagamento é pelo Mercado Pago. Renovar antes do vencimento SOMA os dias —
        você não perde o tempo que ainda tem.
      </div>` : `
      <div class="vazio">
        A renovação online ainda não está disponível.<br>
        Fale com a SaferSoftware para renovar o acesso.
      </div>`}

      ${a.historico.length ? `
      <div class="rotulo-secao" style="margin-top: 8px">Histórico</div>
      <div class="lista">
        ${a.historico.map(h => `
          <div class="linha">
            <div class="linha-data">${dataCurta(h.criado_em)}</div>
            <div style="flex: 1">
              <div class="linha-titulo">${esc(h.periodo === 'ANUAL' ? 'Plano anual' : 'Plano mensal')} · ${formatarReais(h.valor_centavos)}</div>
              <div class="linha-sub">${h.acesso_ate ? `acesso até ${dataLonga(h.acesso_ate)}` : 'aguardando pagamento'}</div>
            </div>
            <span class="chip ${SITUACAO_ASSINATURA[h.status] || ''}">${esc(h.status)}</span>
          </div>`).join('')}
      </div>` : ''}`;

    conteudo.querySelectorAll('[data-pagar]').forEach(b =>
      b.addEventListener('click', async () => {
        if (b.disabled) return;
        b.disabled = true;
        b.textContent = 'Abrindo pagamento…';
        try {
          const r = await api('/assinatura/pagar', { method: 'POST', body: { periodo: b.dataset.pagar } });
          if (!r.url) throw new Error('Não foi possível abrir o pagamento.');
          window.location.href = r.url;
        } catch (err) {
          toast(err.message, true);
          b.disabled = false;
          b.textContent = 'Pagar com Pix ou cartão';
        }
      }));
  }

  // ═══ Configurações ═══════════════════════════════════════════════

  const DIAS_SEMANA = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];

  async function verConfig() {
    if (!ehAdmin()) {
      conteudo.innerHTML = `
        <div class="cabecalho-pagina"><h2>Configurações</h2></div>
        <div class="vazio">Apenas administradores acessam as configurações.</div>`;
      return;
    }
    const [emp, agenda, vinculos] = await Promise.all([
      api('/empresa'), api('/agenda/config'), api('/empresa/vinculos').catch(() => []),
    ]);

    const porDia = new Map();
    for (const h of agenda.horarios) {
      if (!porDia.has(h.dia_semana)) porDia.set(h.dia_semana, []);
      porDia.get(h.dia_semana).push(h);
    }

    function linhaPeriodo(dia, periodo) {
      return `
        <div class="periodo-linha" data-dia="${dia}" style="display: flex; gap: 8px; align-items: center">
          <input type="time" name="periodo_inicio" value="${periodo ? periodo.inicio : '08:00'}" style="padding: 7px 10px; border-radius: 8px; border: 1px solid var(--border); background: var(--bg-panel); color: var(--text-main)">
          <span style="color: var(--text-subtle)">às</span>
          <input type="time" name="periodo_fim" value="${periodo ? periodo.fim : '18:00'}" style="padding: 7px 10px; border-radius: 8px; border: 1px solid var(--border); background: var(--bg-panel); color: var(--text-main)">
          <button type="button" class="btn-fantasma btn-mini" data-remover-periodo style="padding: 5px 10px">×</button>
        </div>`;
    }

    conteudo.innerHTML = `
      <div class="cabecalho-pagina">
        <h2>Configurações</h2>
        <p>Plano ${esc(emp.plano)} · acesso até ${dataLonga(emp.acesso_ate)}</p>
      </div>

      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap: 20px; align-items: start">

        <div style="display: flex; flex-direction: column; gap: 20px">
          <div class="cartao" style="padding: 24px">
            <form id="form-empresa" style="display: flex; flex-direction: column; gap: 14px">
              <div class="rotulo-secao">Dados do petshop</div>
              <div class="campo"><label>Nome</label><input name="nome" value="${esc(emp.nome)}" required></div>
              <div class="campo"><label>WhatsApp (usado no portal do cliente)
                ${dica('É o número do botão "Falar no WhatsApp" que o cliente vê no aplicativo. Só números, com DDD: 67999990000.')}</label>
                <input name="whatsapp" value="${esc(emp.whatsapp || '')}" placeholder="67999999999"></div>
              <div class="campo"><label>Endereço da sua página
                ${dica('A página pública do seu petshop. Mande este link para o cliente: por ele a pessoa vê os serviços, os pacotes e cria a conta dela sozinha. Use só letras minúsculas, números e hífen.')}</label>
                <div style="display: flex; align-items: center; gap: 2px">
                  <span style="font-size: 0.86rem; color: var(--text-muted); white-space: nowrap">${esc(BASE_PUBLICA)}/</span>
                  <input name="slug" value="${esc(emp.slug || '')}" placeholder="salvapatas" style="flex: 1; min-width: 0">
                </div>
                <div class="linha-sub" style="margin-top: 4px">
                  É o link que você manda para o cliente. Ele abre a sua vitrine e cria a conta dele sozinho.
                  ${emp.endereco_publico ? `<a href="${esc(emp.endereco_publico)}" target="_blank" rel="noopener">Abrir a página</a>` : ''}
                </div>
              </div>
              <div class="campo"><label>Logo do petshop</label>
                <div style="display: flex; align-items: center; gap: 12px">
                  <img id="previa-logo" alt="" ${emp.tem_logo ? `data-img="/api/empresa/logo?v=${esc(emp.logo_versao || '')}"` : ''}
                       style="width: 64px; height: 64px; object-fit: contain; border-radius: 12px; border: 1px solid var(--border); background: var(--bg-inset); padding: 4px; ${emp.tem_logo ? '' : 'display: none'}">
                  <label class="btn-fantasma btn-mini" style="cursor: pointer">
                    ${emp.tem_logo ? 'Trocar logo' : 'Escolher logo'}
                    <input type="file" id="campo-logo" accept="image/*" style="display: none">
                  </label>
                  ${emp.tem_logo ? '<button type="button" class="btn-fantasma btn-mini perigo" id="botao-tirar-logo">Remover</button>' : ''}
                </div>
                <div class="linha-sub" style="margin-top: 4px">Aparece no aplicativo do cliente e aqui no topo.</div>
              </div>
              <label style="display: flex; align-items: center; gap: 10px; font-size: 0.9rem; cursor: pointer">
                <input type="checkbox" name="aceita_online" ${emp.aceita_online ? 'checked' : ''} style="width: 17px; height: 17px; accent-color: var(--primary)">
                Deixar o cliente agendar e comprar pelo aplicativo
                ${dica('Ligado: o cliente escolhe horário e compra pacote pelo celular, sem te ligar. Desligado: ele não agenda nem compra pacote pelo aplicativo — a Loja tem a própria chave, logo abaixo.')}
              </label>
              <button class="btn-primario" type="submit" style="align-self: flex-start">Salvar</button>
            </form>
          </div>

          <div class="cartao" style="padding: 24px; display: flex; flex-direction: column; gap: 14px">
            <form id="form-loja" style="display: flex; flex-direction: column; gap: 14px">
              <div class="rotulo-secao">Loja e entrega</div>
              <label style="display: flex; align-items: center; gap: 10px; font-size: 0.9rem; cursor: pointer">
                <input type="checkbox" name="vende_produtos" ${emp.vende_produtos ? 'checked' : ''} style="width: 17px; height: 17px; accent-color: var(--primary)">
                Vender produtos pelo aplicativo
                ${dica('Abre a Loja no aplicativo do cliente, com os produtos que você cadastrar. Precisa do Mercado Pago conectado logo abaixo — é ele que recebe o pagamento.')}
              </label>
              <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px">
                <div class="campo"><label>Taxa de entrega (R$)
                  ${dica('Somada em cada pedido da loja entregue em casa. Deixe 0,00 para não cobrar entrega.')}</label>
                  <input name="taxa" inputmode="decimal" value="${(emp.taxa_entrega_centavos / 100).toFixed(2).replace('.', ',')}"></div>
                <div class="campo"><label>Entrega grátis acima de (R$)
                  ${dica('Pedidos a partir deste valor não pagam a taxa. Deixe vazio para a taxa valer sempre.')}</label>
                  <input name="gratis" inputmode="decimal" value="${emp.entrega_gratis_acima_centavos ? (emp.entrega_gratis_acima_centavos / 100).toFixed(2).replace('.', ',') : ''}" placeholder="deixe vazio para não ter"></div>
              </div>
              <button class="btn-primario" type="submit" style="align-self: flex-start">Salvar loja</button>
            </form>
          </div>

          <div class="cartao" style="padding: 24px; display: flex; flex-direction: column; gap: 14px">
            <div class="rotulo-secao">Pagamento online (Mercado Pago)</div>
            <p style="font-size: 0.85rem; color: var(--text-muted); line-height: 1.55">
              O dinheiro cai direto na conta do petshop. Pegue as credenciais em
              <a href="https://www.mercadopago.com.br/developers/panel/app" target="_blank" rel="noopener">mercadopago.com.br/developers</a>:
              o <strong>access token de produção</strong> e, em Webhooks, a <strong>chave secreta</strong>.
            </p>
            <div class="campo"><label>URL para colar no painel do Mercado Pago
              ${dica('No site do Mercado Pago, em Webhooks, cole esta URL no campo de URL do modo produção e marque o evento Pagamentos. É por ela que o Mercado Pago nos avisa que o cliente pagou.')}</label>
              <input id="campo-webhook-url" readonly value="${esc(emp.url_webhook)}"></div>
            <div class="campo"><label>Access token ${emp.mp_access_token_final ? `(salvo: ${esc(emp.mp_access_token_final)})` : '(não configurado)'}
              ${dica('No site do Mercado Pago: Suas integrações, sua aplicação, Credenciais de produção. Copie o Access Token — começa com APP_USR. Com ele, o dinheiro das vendas cai direto na SUA conta do Mercado Pago.')}</label>
              <input id="campo-mp-token" type="password" placeholder="APP_USR-…" autocomplete="off"></div>
            <div class="campo"><label>Chave secreta do webhook ${emp.mp_webhook_configurado ? '(configurada)' : '(não configurada)'}
              ${dica('Depois de salvar a URL acima no Mercado Pago, ele mostra uma "Assinatura secreta". Cole aqui. É ela que garante que o aviso de pagamento veio mesmo do Mercado Pago, e não de um golpista.')}</label>
              <input id="campo-mp-segredo" type="password" placeholder="cole a chave secreta" autocomplete="off"></div>
            <div style="display: flex; gap: 10px; flex-wrap: wrap">
              <button class="btn-primario" id="botao-salvar-mp" type="button">Salvar credenciais</button>
              <button class="btn-fantasma" id="botao-ver-pagamentos" type="button">Ver pagamentos</button>
            </div>
            <div class="linha-sub">
              ${emp.mp_access_token_final && emp.mp_webhook_configurado
                ? 'Pagamento online ativo: os clientes já podem comprar pacotes pelo aplicativo.'
                : 'Enquanto faltar alguma credencial, o botão de comprar não aparece para o cliente.'}
            </div>
          </div>

          <div class="cartao" style="padding: 24px; display: flex; flex-direction: column; gap: 14px">
            <div style="display: flex; justify-content: space-between; align-items: center">
              <div class="rotulo-secao">Equipe e veículos</div>
              <button class="btn-fantasma btn-mini" id="botao-novo-recurso" type="button">Adicionar</button>
            </div>
            <div class="lista" style="gap: 8px">
              ${agenda.recursos.map(r => `
                <div class="linha linha-inset" style="padding: 10px 14px; ${r.ativo ? '' : 'opacity: 0.55'}">
                  <div style="color: var(--primary-ink)">${r.tipo === 'VEICULO' ? ICONES.van : ICONES.pata}</div>
                  <div style="flex: 1">
                    <div class="linha-titulo" style="font-size: 0.92rem">${esc(r.nome)}</div>
                    <div class="linha-sub">${r.tipo === 'VEICULO' ? 'veículo do leva-e-traz' : 'atendimento simultâneo'}</div>
                  </div>
                  <button class="btn-fantasma btn-mini ${r.ativo ? 'perigo' : ''}" data-alternar-recurso="${r.id}" data-nome="${esc(r.nome)}" data-ativo="${r.ativo}" type="button">
                    ${r.ativo ? 'Desativar' : 'Reativar'}
                  </button>
                </div>`).join('')}
            </div>
            <div class="linha-sub">Cada linha de atendimento é um serviço acontecendo ao mesmo tempo. Sem veículo cadastrado, o leva-e-traz fica desligado.</div>
          </div>

          <div class="cartao" style="padding: 24px; display: flex; flex-direction: column; gap: 14px">
            <div style="display: flex; justify-content: space-between; align-items: center">
              <div class="rotulo-secao">Equipe (acessos)</div>
              <button class="btn-fantasma btn-mini" id="botao-novo-usuario" type="button">Novo usuário</button>
            </div>
            <div class="lista" style="gap: 8px">
              ${emp.usuarios.map(u => `
                <div class="linha linha-inset" style="padding: 10px 14px; ${u.ativo ? '' : 'opacity: 0.55'}">
                  <div class="avatar" style="width: 36px; height: 36px; font-size: 0.9rem">${esc(String(u.nome).trim().charAt(0).toUpperCase())}</div>
                  <div style="flex: 1">
                    <div class="linha-titulo" style="font-size: 0.92rem">${esc(u.nome)}</div>
                    <div class="linha-sub">${esc(u.email)}</div>
                  </div>
                  <span class="chip ${u.permissoes === 'ADMINISTRADOR' ? 'acento' : ''}">${u.permissoes === 'ADMINISTRADOR' ? 'Admin' : 'Atendente'}</span>
                  ${u.id !== sessao.usuario.id ? `
                    <button class="btn-fantasma btn-mini ${u.ativo ? 'perigo' : ''}" data-alternar="${u.id}" data-ativo="${u.ativo}" type="button">
                      ${u.ativo ? 'Desativar' : 'Reativar'}
                    </button>` : '<span class="linha-sub">você</span>'}
                </div>`).join('')}
            </div>
          </div>
        </div>

        <div class="cartao" style="padding: 24px; display: flex; flex-direction: column; gap: 16px">
          <div class="rotulo-secao">Funcionamento da agenda</div>
          <div style="display: flex; flex-direction: column; gap: 14px" id="funcionamento">
            ${DIAS_SEMANA.map((nome, dia) => `
              <div style="display: flex; flex-direction: column; gap: 8px">
                <div style="display: flex; justify-content: space-between; align-items: center">
                  <div style="font-size: 0.9rem; font-weight: 600">${nome}</div>
                  <button type="button" class="btn-fantasma btn-mini" data-mais-periodo="${dia}">Adicionar período</button>
                </div>
                <div style="display: flex; flex-direction: column; gap: 6px" data-periodos="${dia}">
                  ${(porDia.get(dia) || []).map(p => linhaPeriodo(dia, p)).join('') ||
                    '<div class="linha-sub" data-fechado>Fechado</div>'}
                </div>
              </div>`).join('')}
          </div>
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px">
            <div class="campo"><label>Leva-e-traz: deslocamento (min)</label>
              <input id="campo-desloc" type="number" min="5" max="180" step="5" value="${agenda.tempo_deslocamento_minutos}"></div>
            <div class="campo"><label>Grade de horários (min)</label>
              <select id="campo-grade">
                ${[5, 10, 15, 20, 30, 60].map(v => `<option value="${v}" ${agenda.intervalo_grade_minutos === v ? 'selected' : ''}>${v} em ${v}</option>`).join('')}
              </select></div>
          </div>
          <button class="btn-primario" id="botao-salvar-agenda" type="button" style="align-self: flex-start">Salvar funcionamento</button>

          <div style="border-top: 1px solid var(--border); padding-top: 14px; display: flex; flex-direction: column; gap: 10px">
            <div style="display: flex; justify-content: space-between; align-items: center">
              <div class="rotulo-secao">Dias fechados (exceções)</div>
              <button class="btn-fantasma btn-mini" id="botao-nova-excecao" type="button">Fechar um dia</button>
            </div>
            ${agenda.excecoes.length ? agenda.excecoes.map(e => `
              <div class="linha linha-inset" style="padding: 8px 14px">
                <div style="flex: 1; font-size: 0.9rem">${dataLonga(e.data)}${e.motivo ? ` · ${esc(e.motivo)}` : ''}</div>
                <button class="btn-fantasma btn-mini perigo" data-remover-excecao="${e.id}" type="button">Reabrir</button>
              </div>`).join('') : '<div class="linha-sub">Nenhuma exceção futura.</div>'}
          </div>
        </div>
      </div>`;

    // Dados do petshop (com a logo)
    let logoEscolhida;  // undefined = não mexer, null = remover, string = trocar
    const previaLogo = document.getElementById('previa-logo');
    document.getElementById('campo-logo').addEventListener('change', async (ev) => {
      const arquivo = ev.target.files && ev.target.files[0];
      if (!arquivo) return;
      try {
        // Logo é menor que foto de produto: 400px basta e fica leve.
        logoEscolhida = await reduzirImagem(arquivo, 400, 400 * 1024);
        previaLogo.src = logoEscolhida;
        previaLogo.style.display = 'block';
      } catch (err) { toast(err.message, true); }
    });
    const botaoTirarLogo = document.getElementById('botao-tirar-logo');
    if (botaoTirarLogo) botaoTirarLogo.addEventListener('click', () => {
      logoEscolhida = null;
      previaLogo.style.display = 'none';
      toast('A logo sai ao salvar.');
    });

    document.getElementById('form-empresa').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const f = new FormData(ev.target);
      try {
        const apelido = String(f.get('slug') || '').trim();
        await api('/empresa', { method: 'PUT', body: {
          nome: f.get('nome'), whatsapp: f.get('whatsapp'),
          aceita_online: f.get('aceita_online') === 'on',
          // Campo vazio não apaga o apelido que já existe.
          ...(apelido ? { slug: apelido } : {}),
          ...(logoEscolhida !== undefined ? { logo: logoEscolhida } : {}),
        }});
        toast('Dados salvos.');
        await carregarSessao();
        aplicarIdentidade();
        verConfig();
      } catch (err) { toast(err.message, true); }
    });

    // Loja e entrega
    document.getElementById('form-loja').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const f = new FormData(ev.target);
      const taxa = String(f.get('taxa') || '').trim() ? paraCentavos(f.get('taxa')) : 0;
      const gratisTexto = String(f.get('gratis') || '').trim();
      const gratis = gratisTexto ? paraCentavos(gratisTexto) : null;
      if (!Number.isFinite(taxa) || (gratisTexto && !Number.isFinite(gratis))) {
        toast('Valor inválido.', true); return;
      }
      try {
        // Lê o nome/WhatsApp do outro formulário na tela: se o admin
        // mexeu neles e salvou a loja primeiro, nada se perde.
        const formEmpresa = document.getElementById('form-empresa');
        await api('/empresa', { method: 'PUT', body: {
          nome: formEmpresa.querySelector('[name="nome"]').value,
          whatsapp: formEmpresa.querySelector('[name="whatsapp"]').value,
          aceita_online: formEmpresa.querySelector('[name="aceita_online"]').checked,
          vende_produtos: f.get('vende_produtos') === 'on',
          taxa_entrega_centavos: taxa,
          entrega_gratis_acima_centavos: gratis,
        }});
        toast('Loja atualizada.');
        await carregarSessao();
        aplicarIdentidade();
        verConfig();
      } catch (err) { toast(err.message, true); }
    });

    // Credenciais do Mercado Pago
    document.getElementById('botao-salvar-mp').addEventListener('click', async () => {
      const token = document.getElementById('campo-mp-token').value.trim();
      const segredo = document.getElementById('campo-mp-segredo').value.trim();
      if (!token && !segredo) { toast('Preencha ao menos um campo.', true); return; }
      const corpo = {};
      if (token) corpo.mp_access_token = token;
      if (segredo) corpo.mp_webhook_secret = segredo;
      try {
        await api('/empresa/pagamento', { method: 'PUT', body: corpo });
        toast('Credenciais salvas com segurança.');
        verConfig();
      } catch (err) { toast(err.message, true); }
    });

    document.getElementById('botao-ver-pagamentos').addEventListener('click', async () => {
      try {
        const lista = await api('/empresa/pagamentos');
        const SITUACAO = {
          APROVADO: 'ok', PENDENTE: '', DIVERGENTE: 'alerta',
          PENDENTE_MANUAL: 'alerta', ERRO: 'alerta',
        };
        abrirModal(`
          <h3>Pagamentos online</h3>
          ${lista.length ? `<div class="lista" style="gap: 8px">${lista.map(p => `
            <div class="linha linha-inset" style="padding: 10px 14px">
              <div class="linha-data" style="font-size: 1rem">${dataCurta(p.criado_em)}</div>
              <div style="flex: 1">
                <div class="linha-titulo" style="font-size: 0.9rem">${esc(p.cliente_nome)}</div>
                <div class="linha-sub">${esc(p.pacote_nome || p.tipo)} · ${formatarReais(p.valor_centavos)}</div>
              </div>
              <span class="chip ${SITUACAO[p.status] || ''}">${esc(p.status)}</span>
            </div>`).join('')}</div>`
            : '<div class="vazio">Nenhum pagamento online ainda.</div>'}
          <div style="display: flex; justify-content: flex-end"><button class="btn-fantasma" data-fechar type="button">Fechar</button></div>`);
        ligarFechar(document.querySelector('.modal'));
      } catch (err) { toast(err.message, true); }
    });

    // Funcionamento
    const funcionamento = document.getElementById('funcionamento');
    function ligarPeriodos() {
      funcionamento.querySelectorAll('[data-remover-periodo]').forEach(b => {
        b.onclick = () => {
          const caixa = b.closest('.periodo-linha').parentElement;
          b.closest('.periodo-linha').remove();
          if (!caixa.querySelector('.periodo-linha')) {
            caixa.innerHTML = '<div class="linha-sub" data-fechado>Fechado</div>';
          }
        };
      });
    }
    funcionamento.querySelectorAll('[data-mais-periodo]').forEach(b =>
      b.addEventListener('click', () => {
        const dia = b.dataset.maisPeriodo;
        const caixa = funcionamento.querySelector(`[data-periodos="${dia}"]`);
        const fechado = caixa.querySelector('[data-fechado]');
        if (fechado) fechado.remove();
        caixa.insertAdjacentHTML('beforeend', linhaPeriodo(dia, null));
        ligarPeriodos();
      }));
    ligarPeriodos();

    document.getElementById('botao-salvar-agenda').addEventListener('click', async () => {
      const horarios = [...funcionamento.querySelectorAll('.periodo-linha')].map(linha => ({
        dia_semana: parseInt(linha.dataset.dia, 10),
        inicio: linha.querySelector('[name="periodo_inicio"]').value,
        fim: linha.querySelector('[name="periodo_fim"]').value,
      })).filter(h => h.inicio && h.fim);
      try {
        await api('/agenda/config', { method: 'PUT', body: {
          horarios,
          tempo_deslocamento_minutos: parseInt(document.getElementById('campo-desloc').value, 10),
          intervalo_grade_minutos: parseInt(document.getElementById('campo-grade').value, 10),
        }});
        toast('Funcionamento salvo.');
      } catch (err) { toast(err.message, true); }
    });

    // Recursos
    document.getElementById('botao-novo-recurso').addEventListener('click', () => {
      const modal = abrirModal(`
        <h3>Adicionar recurso</h3>
        <form id="form-modal" style="display: flex; flex-direction: column; gap: 14px">
          <div class="campo"><label>Nome</label><input name="nome" placeholder="Atendimento 2 / Van" required></div>
          <div class="campo"><label>Tipo</label>
            <select name="tipo">
              <option value="ATENDIMENTO">Linha de atendimento</option>
              <option value="VEICULO">Veículo (leva-e-traz)</option>
            </select>
          </div>
          ${rodapeModal('Adicionar')}
        </form>`);
      ligarFechar(modal);
      modal.querySelector('#form-modal').addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const f = new FormData(ev.target);
        try {
          await api('/agenda/recursos', { method: 'POST', body: { nome: f.get('nome'), tipo: f.get('tipo') } });
          fecharModal(); toast('Recurso adicionado.'); verConfig();
        } catch (err) { toast(err.message, true); }
      });
    });
    conteudo.querySelectorAll('[data-alternar-recurso]').forEach(b =>
      b.addEventListener('click', async () => {
        try {
          await api(`/agenda/recursos/${b.dataset.alternarRecurso}`, {
            method: 'PUT', body: { nome: b.dataset.nome, ativo: b.dataset.ativo !== 'true' },
          });
          toast('Recurso atualizado.'); verConfig();
        } catch (err) { toast(err.message, true); }
      }));

    // Exceções
    document.getElementById('botao-nova-excecao').addEventListener('click', () => {
      const modal = abrirModal(`
        <h3>Fechar um dia</h3>
        <form id="form-modal" style="display: flex; flex-direction: column; gap: 14px">
          <div class="campo"><label>Data</label><input name="data" type="date" min="${hojeISO()}" required></div>
          <div class="campo"><label>Motivo (opcional)</label><input name="motivo" placeholder="Feriado"></div>
          ${rodapeModal('Fechar agenda')}
        </form>`);
      ligarFechar(modal);
      modal.querySelector('#form-modal').addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const f = new FormData(ev.target);
        try {
          const r = await api('/agenda/excecoes', { method: 'POST', body: { data: f.get('data'), motivo: f.get('motivo') } });
          fecharModal();
          if (r.agendamentos_afetados > 0) {
            toast(`Dia fechado — atenção: ${r.agendamentos_afetados} agendamento(s) neste dia precisam ser reagendados.`, true);
          } else {
            toast('Dia fechado na agenda.');
          }
          verConfig();
        } catch (err) { toast(err.message, true); }
      });
    });
    conteudo.querySelectorAll('[data-remover-excecao]').forEach(b =>
      b.addEventListener('click', async () => {
        try {
          await api(`/agenda/excecoes/${b.dataset.removerExcecao}`, { method: 'DELETE' });
          toast('Dia reaberto.'); verConfig();
        } catch (err) { toast(err.message, true); }
      }));

    // Equipe
    document.getElementById('botao-novo-usuario').addEventListener('click', modalNovoUsuario);
    conteudo.querySelectorAll('[data-alternar]').forEach(b =>
      b.addEventListener('click', async () => {
        try {
          await api(`/empresa/usuarios/${b.dataset.alternar}`, {
            method: 'PUT', body: { ativo: b.dataset.ativo !== 'true' },
          });
          toast('Usuário atualizado.'); verConfig();
        } catch (err) { toast(err.message, true); }
      }));
  }

  function modalNovoUsuario() {
    const modal = abrirModal(`
      <h3>Novo usuário</h3>
      <form id="form-modal" style="display: flex; flex-direction: column; gap: 14px">
        <div class="campo"><label>Nome</label><input name="nome" required></div>
        <div class="campo"><label>E-mail</label><input name="email" type="email" required></div>
        <div class="campo"><label>Senha (mínimo 8 caracteres)</label><input name="senha" type="password" minlength="8" required></div>
        <div class="campo"><label>Permissão</label>
          <select name="permissoes"><option value="ATENDENTE">Atendente</option><option value="ADMINISTRADOR">Administrador</option></select>
        </div>
        ${rodapeModal('Cadastrar')}
      </form>`);
    ligarFechar(modal);
    modal.querySelector('#form-modal').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const f = new FormData(ev.target);
      try {
        await api('/empresa/usuarios', { method: 'POST', body: {
          nome: f.get('nome'), email: f.get('email'),
          senha: f.get('senha'), permissoes: f.get('permissoes'),
        }});
        fecharModal(); toast('Usuário criado.'); verConfig();
      } catch (err) { toast(err.message, true); }
    });
  }


  // ═══ Ajuda ═══════════════════════════════════════════════════════
  // Manual do usuário dentro do painel, organizado por tela, com busca.
  // Página, não PDF: evolui junto com o produto.

  function verAjuda(termoInicial) {
    const endereco = sessao.empresa.slug ? enderecoPublico() : null;
    const linkExemplo = endereco || `${window.location.origin}/nome-do-seu-petshop`;

    const topicos = [
      {
        titulo: 'Primeiros passos',
        corpo: `
          <p>O SaferPet substitui o caderno de pacotes e coloca o seu petshop no celular do cliente.
             A ordem que funciona:</p>
          <ol>
            <li><strong>Catálogo → Novo serviço.</strong> Cadastre banho, tosa e o que mais você faz,
                cada um com a duração real. A duração monta a sua agenda.</li>
            <li><strong>Catálogo → Novo modelo.</strong> Monte os pacotes que você já vende
                — por exemplo, 24 banhos por R$ 700 — com preço e validade.</li>
            <li><strong>Configurações.</strong> Ligue "Deixar o cliente agendar e comprar pelo aplicativo"
                e escolha o endereço da sua página.</li>
            <li><strong>Configurações → Pagamento online.</strong> Conecte o seu Mercado Pago para o
                cliente pagar pelo celular. O dinheiro cai direto na sua conta.</li>
            <li><strong>Clientes.</strong> Cadastre quem já é cliente — ou mande o endereço da sua
                página e deixe cada um criar a própria conta.</li>
          </ol>
          <div class="nota">A Visão geral mostra o que ainda falta desses passos e o que o seu
            cliente já consegue ver no aplicativo.</div>`,
      },
      {
        titulo: 'Visão geral',
        corpo: `
          <p>É a tela de chegada: o resumo do dia e o que precisa da sua atenção.</p>
          <ul>
            <li><strong>Confirmação de cliente</strong> — quando alguém cria conta com um telefone que
                já está no seu cadastro, o pedido aparece aqui. Confirme apenas se for mesmo o seu
                cliente: quem você aprovar passa a ver todo o histórico daquela ficha. Na dúvida,
                ligue para o número antes de aprovar.</li>
            <li><strong>Ativação do aplicativo</strong> — os passos que faltam para o cliente conseguir
                agendar e comprar. Some sozinho quando tudo estiver pronto.</li>
            <li><strong>Agendados hoje, buscas e entregas, créditos usados</strong> — os números do dia.</li>
            <li><strong>Saldos acabando</strong> — pacotes ativos com 3 créditos ou menos. É a hora
                de oferecer o próximo pacote.</li>
          </ul>`,
      },
      {
        titulo: 'Agenda',
        corpo: `
          <p>A agenda mostra o dia em colunas de horário, como um mapa do expediente.</p>
          <ul>
            <li><strong>Agendar:</strong> clique em um horário vago (ou no botão Agendar da ficha do
                cliente). Os horários oferecidos respeitam a duração do serviço e o seu expediente.</li>
            <li><strong>Leva-e-traz:</strong> ao marcar com busca e entrega, o veículo entra na agenda
                como um recurso — o sistema não deixa duas buscas no mesmo horário.</li>
            <li><strong>Concluir:</strong> ao concluir um serviço, o crédito do pacote baixa sozinho.
                Se o cliente não tem crédito daquele serviço, o sistema avisa para cobrar na hora.</li>
            <li><strong>Faltou:</strong> registra a falta sem consumir crédito.</li>
            <li><strong>Foto do pet pronto:</strong> na conclusão dá para enviar uma foto — o cliente
                recebe no aplicativo. É o momento que mais encanta.</li>
          </ul>
          <p>O expediente (dias e horários de funcionamento) se ajusta em
             <strong>Configurações</strong>, incluindo pausas e exceções de feriado.</p>`,
      },
      {
        titulo: 'Clientes e pacotes',
        corpo: `
          <p>Cada cliente tem uma ficha com os pets, os pacotes e todo o histórico.</p>
          <ul>
            <li><strong>Vender pacote:</strong> escolha o modelo e pronto — os créditos entram na conta
                do cliente. Pagamento no balcão é com você; pelo aplicativo, o crédito entra sozinho
                quando o Mercado Pago confirma.</li>
            <li><strong>Dar baixa:</strong> desconta um crédito na hora (o caminho rápido do balcão,
                sem passar pela agenda). Se o cliente tem mais de um pacote, o sistema usa primeiro
                o mais antigo.</li>
            <li><strong>Estorno:</strong> desfaz uma baixa errada. A equipe estorna no mesmo dia;
                depois disso, só o administrador. Registros nunca somem — o estorno fica marcado
                no histórico.</li>
            <li><strong>Pacote vencido:</strong> o sistema bloqueia a baixa e avisa. O administrador
                pode reativar pela ficha, se quiser abrir exceção.</li>
          </ul>
          <div class="nota">O telefone identifica o cliente no aplicativo — por isso cada cliente
            precisa de um número diferente. Se dois dividem o mesmo celular, cadastre o segundo
            sem telefone ou com outro número.</div>`,
      },
      {
        titulo: 'O aplicativo do seu cliente',
        corpo: `
          <p>O cliente tem duas portas de entrada, e as duas levam ao mesmo lugar:</p>
          <ul>
            <li><strong>O link individual</strong> — está na ficha de cada cliente ("Link do portal").
                Abre direto, sem senha. Bom para quem você mesmo cadastrou no balcão.</li>
            <li><strong>A conta própria</strong> — na sua página pública
                (${endereco ? `<strong>${esc(endereco)}</strong>` : `<strong>${esc(linkExemplo)}</strong>, definida em Configurações`}),
                o cliente cria conta com telefone e senha e entra quando quiser.</li>
          </ul>
          <p>No aplicativo, o cliente vê o saldo dos pacotes, agenda horário, compra pacote, acompanha
             o leva-e-traz, compra na loja e recebe as fotos do pet pronto.</p>
          <p><strong>Se o telefone já estiver no seu cadastro</strong>, a conta não abre sozinha:
             chega um pedido de confirmação na sua Visão geral. Isso protege o histórico — sem a sua
             confirmação, ninguém assume a ficha de outra pessoa.</p>
          <p><strong>Cliente perdeu o link?</strong> Abra a ficha dele → Link do portal → Enviar por
             WhatsApp. Ou gere um novo link, que cancela o antigo.</p>`,
      },
      {
        titulo: 'Catálogo: serviços e modelos de pacote',
        corpo: `
          <p><strong>Serviços</strong> são o que você faz: banho, tosa, hidratação. Cada um tem:</p>
          <ul>
            <li><strong>Duração</strong> — o tempo que o serviço ocupa na agenda. O aplicativo só
                oferece horários em que ele cabe inteiro, sem atropelar o próximo.</li>
            <li><strong>Preço avulso</strong> — o valor de uma vez só, para quem não tem pacote.</li>
          </ul>
          <p><strong>Modelos de pacote</strong> são as ofertas: quais serviços entram, quantas vezes,
             por quanto e com qual validade. O modelo é o molde; a venda cria o pacote do cliente.</p>
          <div class="nota">Mudar um modelo não mexe nos pacotes já vendidos — cliente que comprou
            mantém exatamente o que comprou.</div>`,
      },
      {
        titulo: 'Loja e entregas',
        corpo: `
          <p>A loja vende ração, shampoo, acessórios — direto no aplicativo do cliente.</p>
          <ul>
            <li><strong>Produto</strong> tem nome, foto, preço e estoque. Quando o estoque zera, o
                produto some da loja sozinho (desligue "controlar estoque" para itens sob encomenda).</li>
            <li><strong>Pedido</strong> aparece na aba Loja assim que o cliente fecha a compra, como
                "aguardando pagamento" — e muda sozinho para pago quando o Mercado Pago confirma.
                Daí você separa, e a entrega entra na rota do leva-e-traz — ou o cliente retira
                no balcão.</li>
            <li><strong>Taxa de entrega</strong> se ajusta em Configurações, com valor mínimo para
                entrega grátis se você quiser.</li>
          </ul>
          <p>Os pedidos aparecem na aba Loja, do mais recente para o mais antigo, com a situação de
             cada um.</p>`,
      },
      {
        titulo: 'Pagamento online (Mercado Pago)',
        corpo: `
          <p>Com o Mercado Pago conectado, o cliente compra pacote e produtos pelo celular e
             <strong>o dinheiro cai direto na conta do petshop</strong> — a SaferSoftware não passa
             pelo meio. Conectar leva uns 10 minutos:</p>
          <ol>
            <li>Crie (ou entre na) sua conta em <strong>mercadopago.com.br</strong>.</li>
            <li>Acesse <strong>mercadopago.com.br/developers</strong> → Suas integrações →
                Criar aplicação (qualquer nome, por exemplo "SaferPet").</li>
            <li>Na aplicação, abra <strong>Credenciais de produção</strong> e copie o
                <strong>Access Token</strong> (começa com APP_USR).</li>
            <li>Cole em Configurações → Pagamento online → Access token.</li>
            <li>Ainda na aplicação, abra <strong>Webhooks → Configurar notificações</strong>: cole a
                URL que aparece em Configurações, marque o evento <strong>Pagamentos</strong> e salve.</li>
            <li>O Mercado Pago mostra uma <strong>assinatura secreta</strong> — cole no campo
                "Chave secreta do webhook" e salve.</li>
          </ol>
          <p>Pronto: quando as duas credenciais estiverem salvas, Configurações mostra
             "Pagamento online ativo" — e o botão de comprar aparece para o cliente.</p>
          <div class="nota">Cliente pagou e o crédito não apareceu? O sistema confere os pagamentos
            pendentes sozinho em até 20 minutos. Se não resolver depois disso, confira se a
            assinatura secreta do webhook está igual à do painel do Mercado Pago.</div>`,
      },
      {
        titulo: 'Assinatura do SaferPet',
        corpo: `
          <p>O SaferPet é assinado por mensalidade: R$ 149 por mês ou R$ 1.490 por ano
             (dois meses grátis). Os primeiros 14 dias são de teste, sem pagar nada.</p>
          <ul>
            <li>A aba <strong>Assinatura</strong> mostra até quando vai o seu acesso e renova com
                cartão ou Pix, pelo Mercado Pago.</li>
            <li>Renovar antes de vencer <strong>soma</strong> os dias — você nunca perde o que pagou.</li>
            <li>Se vencer, os dados ficam guardados: nada se perde, e tudo volta ao normal na
                renovação.</li>
          </ul>`,
      },
      {
        titulo: 'Perguntas frequentes',
        corpo: `
          <p class="ajuda-pergunta">Posso usar no celular?</p>
          <p>Sim — o painel e o aplicativo do cliente funcionam no navegador do celular, sem
             instalar nada.</p>
          <p class="ajuda-pergunta">O cliente esqueceu a senha da conta dele. E agora?</p>
          <p>Mande o link individual da ficha dele por WhatsApp — o link abre sem senha e resolve na
             hora. Se ele fizer questão da senha: na ficha dele, <strong>Desconectar conta</strong>,
             e ele cria a conta de novo com uma senha nova (você confirma o pedido na Visão geral).</p>
          <p class="ajuda-pergunta">Aprovei uma confirmação de cliente por engano.</p>
          <p>Abra a ficha do cliente → Link do portal → <strong>Desconectar conta</strong>. A sessão
             de quem entrou cai na hora, e a pessoa só volta criando a conta de novo — o que pede a
             sua confirmação outra vez. Se ela também tiver o link individual, gere um novo link.</p>
          <p class="ajuda-pergunta">Quero tirar um produto da loja sem apagar.</p>
          <p>Edite o produto e desmarque "À venda no aplicativo". Ele sai da loja e continua no seu
             cadastro.</p>
          <p class="ajuda-pergunta">Registrei uma baixa errada.</p>
          <p>Na ficha do cliente, o botão de estorno desfaz a baixa no mesmo dia. Depois disso, só
             o administrador consegue estornar.</p>
          <p class="ajuda-pergunta">O horário que o cliente queria não aparece para ele.</p>
          <p>Confira o expediente em Configurações e a duração do serviço no Catálogo — o aplicativo
             só oferece horários que cabem inteiros dentro do expediente, descontando o que já está
             marcado.</p>`,
      },
      {
        titulo: 'Como apresentar o aplicativo ao seu cliente',
        corpo: `
          <p>Você vai ser a primeira linha de ajuda dos seus clientes. Um jeito simples de
             apresentar, na entrega ou pelo WhatsApp:</p>
          <p style="font-style: italic">"Agora você acompanha tudo do seu pet pelo celular: o saldo
             dos banhos, os horários e as fotos de quando ele fica pronto. É só criar a sua conta
             neste link — leva um minuto e não precisa instalar nada."</p>
          ${endereco ? `
          <p>Mensagem pronta para copiar e mandar no WhatsApp:</p>
          <div class="campo"><textarea id="ajuda-convite" rows="3" readonly
            style="resize: none">${esc(textoConviteVitrine())}</textarea></div>
          <button class="btn-primario btn-mini" id="ajuda-copiar-convite" type="button"
            style="align-self: flex-start">Copiar mensagem</button>` : `
          <div class="nota">Defina o endereço da sua página em Configurações para ter o link de
            convite pronto para enviar.</div>`}
          <p>Para quem você já cadastrou no balcão, o caminho mais curto é a própria ficha do
             cliente: <strong>Link do portal → Enviar por WhatsApp</strong> — abre sem senha.</p>`,
      },
    ];

    conteudo.innerHTML = `
      <div class="cabecalho-pagina">
        <h2>Ajuda</h2>
        <p>Como usar cada parte do SaferPet — e as respostas para as dúvidas mais comuns</p>
      </div>
      <input class="busca" id="ajuda-busca" type="search"
             placeholder="Buscar na ajuda (ex.: webhook, estorno, validade)" value="${esc(termoInicial || '')}">
      <div class="lista" id="ajuda-lista">
        ${topicos.map((t, i) => `
          <details class="ajuda-topico" data-indice="${i}">
            <summary>${esc(t.titulo)}</summary>
            <div class="ajuda-corpo">${t.corpo}</div>
          </details>`).join('')}
        <div class="vazio ajuda-sem-resultado" id="ajuda-vazio">
          Nada encontrado com esse termo.<br>
          Não achou a resposta? Fale com a SaferSoftware — a ajuda cresce com as suas perguntas.
        </div>
      </div>`;

    // "duracao" tem que achar "duração": compara tudo sem acento.
    const semAcento = (texto) => texto.toLowerCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '');
    const caixas = [...conteudo.querySelectorAll('.ajuda-topico')];
    const textos = caixas.map(c => semAcento(c.textContent));

    function filtrar(termo) {
      const t = semAcento(termo.trim());
      let visiveis = 0;
      caixas.forEach((caixa, i) => {
        const bate = !t || textos[i].includes(t);
        caixa.style.display = bate ? '' : 'none';
        if (bate) visiveis += 1;
        // Com termo, abre o tópico para a resposta aparecer; sem termo, recolhe.
        if (t && bate) caixa.setAttribute('open', '');
        else if (!t) caixa.removeAttribute('open');
      });
      document.getElementById('ajuda-vazio').style.display = visiveis ? 'none' : 'block';
    }

    const campoBusca = document.getElementById('ajuda-busca');
    campoBusca.addEventListener('input', () => filtrar(campoBusca.value));
    if (termoInicial) filtrar(termoInicial);

    const copiarConvite = document.getElementById('ajuda-copiar-convite');
    if (copiarConvite) copiarConvite.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(textoConviteVitrine()); toast('Mensagem copiada.'); }
      catch (_e) {
        document.getElementById('ajuda-convite').select();
        document.execCommand('copy');
        toast('Mensagem copiada.');
      }
    });
  }

  // ═══ Roteador ════════════════════════════════════════════════════

  function marcarAba(rota) {
    document.querySelectorAll('#abas .aba').forEach(a => {
      const alvo = a.getAttribute('href').replace('#/', '');
      a.classList.toggle('ativa', rota === alvo ||
        (alvo === 'clientes' && rota.startsWith('cliente')) ||
        (alvo === 'agenda' && rota.startsWith('agenda')));
    });
  }

  async function renderizar() {
    const hash = window.location.hash.replace(/^#\//, '') || 'visao';
    const [rota, parametro] = hash.split('/');
    marcarAba(hash);

    // Acesso vencido bloqueia a operação, mas NUNCA a renovação nem a
    // ajuda — senão o petshop fica trancado do lado de fora da solução.
    if (sessao && !sessao.empresa.acesso_vigente && rota !== 'assinatura' && rota !== 'ajuda') {
      conteudo.innerHTML = `
        <div class="faixa-aviso" style="display: flex; align-items: center; gap: 16px; flex-wrap: wrap">
          <div style="flex: 1; min-width: 240px">
            O acesso do petshop ao SaferPet venceu em ${dataLonga(sessao.empresa.acesso_ate)}.
            Os dados estão guardados — tudo volta ao normal na renovação.
          </div>
          <a class="btn-primario btn-mini" href="#/assinatura" style="text-decoration: none">Renovar agora</a>
        </div>`;
      return;
    }

    try {
      if (rota === 'agenda') await verAgenda(parametro);
      else if (rota === 'clientes') await verClientes();
      else if (rota === 'cliente' && parametro) await verFicha(parseInt(parametro, 10));
      else if (rota === 'loja') await verLoja();
      else if (rota === 'catalogo') await verCatalogo();
      else if (rota === 'relatorios') await verRelatorios();
      else if (rota === 'assinatura') await verAssinatura();
      else if (rota === 'config') await verConfig();
      else if (rota === 'ajuda') verAjuda();
      else await verVisao();
    } catch (err) {
      if (err.status === 402) {
        conteudo.innerHTML = `<div class="faixa-aviso">${esc(err.message)}</div>`;
      } else {
        conteudo.innerHTML = `<div class="vazio">${esc(err.message)}</div>`;
      }
    }
  }

  async function carregarSessao() {
    sessao = await api('/auth/me');
  }

  // ═══ Boot ════════════════════════════════════════════════════════

  document.getElementById('botao-sair').addEventListener('click', sair);
  window.addEventListener('hashchange', renderizar);

  if (!localStorage.getItem('saferpet_token')) {
    window.location.href = '/';
  } else {
    carregarSessao()
      .then(() => {
        aplicarIdentidade();
        renderizar();
      })
      .catch(() => sair());
  }
})();
