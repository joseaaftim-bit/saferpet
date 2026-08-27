'use strict';

// SaferPet — painel do petshop. Vanilla JS, sem build: roteador por hash,
// fetch autenticado e renderização por template string (sempre com esc()).

(function () {
  const conteudo = document.getElementById('conteudo');
  const areaModal = document.getElementById('area-modal');
  const areaToast = document.getElementById('area-toast');

  let sessao = null; // { usuario, empresa } vindo de /api/auth/me

  // ─── Utilitários ─────────────────────────────────────────────────

  function esc(texto) {
    return String(texto === null || texto === undefined ? '' : texto)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function dataCurta(iso) {
    if (!iso) return '—';
    return new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
  }

  function dataLonga(iso) {
    if (!iso) return '—';
    return new Date(`${String(iso).slice(0, 10)}T12:00:00`).toLocaleDateString('pt-BR');
  }

  function horaCurta(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
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
    setTimeout(() => el.remove(), 3500);
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
    return fundo.querySelector('.modal');
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

  // ─── Barra de saldo ──────────────────────────────────────────────

  function barraSaldo(saldo, total, largura) {
    const pct = total > 0 ? Math.round((saldo / total) * 100) : 0;
    const classe = saldo <= 3 ? 'baixa' : '';
    return `<div class="barra" style="width: ${largura || 130}px"><div class="${classe}" style="width: ${pct}%"></div></div>`;
  }

  // ─── Visão geral ─────────────────────────────────────────────────

  const ICONES = {
    banho: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.5c3.2 3.9 6 7.2 6 10.2a6 6 0 0 1-12 0c0-3 2.8-6.3 6-10.2z"></path></svg>',
    pata: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="15.5" rx="4.2" ry="3.4"></ellipse><circle cx="6.2" cy="10.4" r="1.9"></circle><circle cx="10" cy="7.2" r="1.9"></circle><circle cx="14" cy="7.2" r="1.9"></circle><circle cx="17.8" cy="10.4" r="1.9"></circle></svg>',
    alerta: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><path d="M12 7.5v5.5"></path><path d="M12 16.4v.1"></path></svg>',
    pessoas: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.5"></circle><path d="M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6"></path><path d="M16 5.2a3.5 3.5 0 0 1 0 5.6"></path><path d="M18.5 14.5c1.9 1 3 2.9 3 5.5"></path></svg>',
  };

  async function verVisao() {
    const [kpis, recentes] = await Promise.all([api('/dashboard'), api('/baixas/recentes?limite=12')]);

    conteudo.innerHTML = `
      <div class="cabecalho-pagina">
        <h2>Visão geral</h2>
        <p>${esc(sessao.empresa.nome)} — hoje</p>
      </div>
      <div class="kpis">
        <div class="cartao kpi">
          <div class="kpi-icone">${ICONES.banho}</div>
          <div><div class="kpi-rotulo">Banhos hoje</div><div class="kpi-valor">${kpis.banhos_hoje}</div></div>
        </div>
        <div class="cartao kpi">
          <div class="kpi-icone">${ICONES.pata}</div>
          <div><div class="kpi-rotulo">Pacotes ativos</div><div class="kpi-valor">${kpis.pacotes_ativos}</div></div>
        </div>
        <div class="cartao kpi">
          <div class="kpi-icone" style="color: var(--danger)">${ICONES.alerta}</div>
          <div><div class="kpi-rotulo">Saldos acabando</div><div class="kpi-valor" style="color: ${kpis.saldos_acabando > 0 ? 'var(--danger)' : 'var(--text-main)'}">${kpis.saldos_acabando}</div></div>
        </div>
        <div class="cartao kpi">
          <div class="kpi-icone">${ICONES.pessoas}</div>
          <div><div class="kpi-rotulo">Clientes</div><div class="kpi-valor">${kpis.clientes_ativos}</div></div>
        </div>
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
                · por ${esc(b.registrado_por_nome)} às ${horaCurta(b.registrado_em)}
                ${b.estornada ? ' · estornada' : ''}
              </div>
            </div>
            ${b.estornada ? '<span class="chip">Estornada</span>' : `<span class="chip acento">Restou ${b.saldo_apos}</span>`}
          </div>`).join('')}</div>`
        : '<div class="vazio">Nenhuma baixa registrada ainda.<br>Cadastre um cliente, venda um pacote e registre o primeiro banho.</div>'}
      </div>`;
  }

  // ─── Clientes ────────────────────────────────────────────────────

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
      ${clientes.length ? `<div class="lista">${clientes.map(c => {
        const temPacote = c.pacote_id !== null && c.pacote_id !== undefined;
        // "Acabando" olha o saldo somado: pacote novo cheio na fila não é alerta.
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
          <a class="btn-fantasma btn-mini" href="#/cliente/${c.id}" style="text-decoration: none">Ficha</a>
        </div>`;
      }).join('')}</div>`
      : `<div class="vazio">${busca ? 'Nenhum cliente encontrado.' : 'Nenhum cliente ainda.<br>Comece cadastrando o primeiro cliente e os pets dele.'}</div>`}`;

    document.getElementById('botao-novo-cliente').addEventListener('click', modalNovoCliente);

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
  }

  function modalNovoCliente() {
    const modal = abrirModal(`
      <h3>Novo cliente</h3>
      <form id="form-modal" style="display: flex; flex-direction: column; gap: 14px">
        <div class="campo"><label>Nome</label><input name="nome" required></div>
        <div class="campo"><label>Telefone / WhatsApp</label><input name="telefone" placeholder="67999999999"></div>
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
    modal.querySelector('#form-modal').addEventListener('submit', async (ev) => {
      ev.preventDefault();
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

  // ─── Ficha do cliente ────────────────────────────────────────────

  // Com mais de um pacote ativo, consome-se o mais antigo primeiro
  // (a lista da ficha vem em ordem decrescente de criação).
  function pacoteEmConsumo(pacotes) {
    const ativos = pacotes.filter(p => p.status === 'ATIVO');
    return ativos.length ? ativos[ativos.length - 1] : null;
  }

  async function verFicha(clienteId) {
    const c = await api(`/clientes/${clienteId}`);
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
        </div>
        <div style="display: flex; gap: 10px; flex-wrap: wrap">
          <button class="btn-fantasma" id="botao-editar" type="button">Editar</button>
          <button class="btn-fantasma" id="botao-link" type="button">Link do portal</button>
          <button class="btn-fantasma" id="botao-vender" type="button">Vender pacote</button>
          ${ativo ? '<button class="btn-primario" id="botao-baixa" type="button">Dar baixa de banho</button>' : ''}
        </div>
      </div>

      <div style="display: grid; grid-template-columns: minmax(280px, 2fr) minmax(320px, 3fr); gap: 20px; align-items: start" id="grade-ficha">
        <div style="display: flex; flex-direction: column; gap: 18px">
          ${ativo ? `
          <div class="cartao" style="padding: 24px; display: flex; flex-direction: column; gap: 14px">
            <div style="display: flex; justify-content: space-between; align-items: center">
              <div class="rotulo-secao">Pacote ativo</div>
              <span class="chip ${ativo.saldo <= 3 ? 'alerta' : 'ok'}">${ativo.saldo <= 3 ? 'Acabando' : 'Em dia'}</span>
            </div>
            <div>
              <h3 style="font-size: 1.35rem">${esc(ativo.nome)}</h3>
              <div class="linha-sub">comprado em ${dataLonga(ativo.comprado_em)} · ${formatarReais(ativo.valor_centavos)}</div>
            </div>
            <div style="display: flex; align-items: baseline; gap: 10px">
              <div style="font-family: var(--fonte-titulo); font-size: 3rem; font-weight: 550; line-height: 1">${ativo.saldo}</div>
              <div style="color: var(--text-muted); font-size: 0.92rem">de ${ativo.qtd_banhos} banhos${saldoProximos > 0 ? ` · +${saldoProximos} no próximo pacote` : ''}</div>
            </div>
            ${barraSaldo(ativo.saldo, ativo.qtd_banhos, 999).replace('width: 999px', 'width: 100%')}
            <div class="linha-sub">${ativo.validade_ate ? `válido até ${dataLonga(ativo.validade_ate)}` : 'sem validade'}</div>
            ${ehAdmin() ? `<button class="btn-fantasma btn-mini" id="botao-ajustar-pacote" type="button" style="align-self: flex-start">Ajustar validade / cancelar</button>` : ''}
          </div>` : `
          <div class="vazio">Nenhum pacote ativo.<br>Venda um pacote para começar a controlar o saldo.</div>`}

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

          ${proximos.length ? `
          <div class="cartao" style="padding: 22px 24px; display: flex; flex-direction: column; gap: 10px">
            <div class="rotulo-secao">Próximos pacotes</div>
            ${proximos.map(p => `
              <div class="linha linha-inset" style="padding: 10px 14px">
                <div style="flex: 1">
                  <div class="linha-titulo" style="font-size: 0.9rem">${esc(p.nome)}</div>
                  <div class="linha-sub">${p.saldo} de ${p.qtd_banhos} banhos · comprado em ${dataLonga(p.comprado_em)}</div>
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
    const botaoBaixa = document.getElementById('botao-baixa');
    if (botaoBaixa) botaoBaixa.addEventListener('click', () => modalDarBaixa(c.id));
    document.getElementById('botao-novo-pet').addEventListener('click', () => modalNovoPet(c.id));
    const botaoAjustar = document.getElementById('botao-ajustar-pacote');
    if (botaoAjustar) botaoAjustar.addEventListener('click', () => modalAjustarPacote(ativo, c.id));

    conteudo.querySelectorAll('[data-estornar]').forEach(b =>
      b.addEventListener('click', async () => {
        if (!window.confirm('Estornar esta baixa? O saldo volta em 1 banho.')) return;
        try {
          const r = await api(`/baixas/${b.dataset.estornar}/estornar`, { method: 'POST' });
          toast(`Baixa estornada. Saldo: ${r.saldo}.`);
          verFicha(clienteId);
        } catch (err) { toast(err.message, true); }
      }));

    conteudo.querySelectorAll('[data-reativar]').forEach(b =>
      b.addEventListener('click', () => {
        const p = c.pacotes.find(x => x.id === parseInt(b.dataset.reativar, 10));
        if (p) modalReativarPacote(p, clienteId);
      }));
  }

  function modalReativarPacote(pacote, clienteId) {
    const exigeValidade = pacote.status === 'VENCIDO';
    const modal = abrirModal(`
      <h3>Reativar pacote</h3>
      <p style="font-size: 0.88rem; color: var(--text-muted); line-height: 1.5">
        ${esc(pacote.nome)} · restam ${pacote.saldo} banho(s).
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

  function modalEditarCliente(c) {
    const modal = abrirModal(`
      <h3>Editar cliente</h3>
      <form id="form-modal" style="display: flex; flex-direction: column; gap: 14px">
        <div class="campo"><label>Nome</label><input name="nome" value="${esc(c.nome)}" required></div>
        <div class="campo"><label>Telefone / WhatsApp</label><input name="telefone" value="${esc(c.telefone || '')}"></div>
        <div class="campo"><label>E-mail</label><input name="email" type="email" value="${esc(c.email || '')}"></div>
        <div class="campo"><label>Observações</label><textarea name="observacoes" rows="2">${esc(c.observacoes || '')}</textarea></div>
        ${rodapeModal('Salvar')}
      </form>`);
    ligarFechar(modal);
    modal.querySelector('#form-modal').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const f = new FormData(ev.target);
      try {
        await api(`/clientes/${c.id}`, { method: 'PUT', body: {
          nome: f.get('nome'), telefone: f.get('telefone'),
          email: f.get('email'), observacoes: f.get('observacoes'),
        }});
        fecharModal(); toast('Cliente atualizado.'); verFicha(c.id);
      } catch (err) { toast(err.message, true); }
    });
  }

  function modalLinkPortal(c) {
    const telefone = String(c.telefone || '').replace(/\D/g, '');
    const numeroWhats = telefone ? (telefone.length <= 11 ? '55' + telefone : telefone) : null;
    const textoWhats = `Olá, ${c.nome}! Acompanhe o saldo de banhos por aqui: ${c.link_portal}`;
    const modal = abrirModal(`
      <h3>Link do portal do cliente</h3>
      <p style="font-size: 0.88rem; color: var(--text-muted); line-height: 1.5">
        Por este link o cliente vê o saldo, os últimos banhos e agenda pelo WhatsApp — sem senha.
      </p>
      <div class="campo"><label>Link</label><input id="campo-link" readonly value="${esc(c.link_portal)}"></div>
      <div style="display: flex; gap: 10px; flex-wrap: wrap">
        <button class="btn-primario btn-mini" id="botao-copiar" type="button">Copiar link</button>
        ${numeroWhats ? `<a class="btn-fantasma btn-mini" style="text-decoration: none" target="_blank" rel="noopener"
          href="https://wa.me/${numeroWhats}?text=${encodeURIComponent(textoWhats)}">Enviar por WhatsApp</a>` : ''}
        ${ehAdmin() ? '<button class="btn-fantasma btn-mini perigo" id="botao-regenerar" type="button">Gerar novo link</button>' : ''}
      </div>
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

  // ─── Vender pacote ───────────────────────────────────────────────

  async function modalVenderPacote(clienteId) {
    const modelos = (await api('/pacotes/modelos')).filter(m => m.ativo);
    const modal = abrirModal(`
      <h3>Vender pacote</h3>
      <form id="form-modal" style="display: flex; flex-direction: column; gap: 14px">
        ${modelos.length ? `
        <div class="campo"><label>Pacote do catálogo</label>
          <select name="modelo_id">
            ${modelos.map(m => `<option value="${m.id}">${esc(m.nome)} — ${m.qtd_banhos} banhos · ${formatarReais(m.valor_centavos)}</option>`).join('')}
            <option value="">Pacote avulso (preencher abaixo)</option>
          </select>
        </div>` : `
        <p style="font-size: 0.85rem; color: var(--text-muted)">
          Nenhum modelo no catálogo ainda — preencha o pacote avulso abaixo
          ${ehAdmin() ? 'ou cadastre modelos na aba Pacotes.' : '.'}
        </p>`}
        <div id="campos-avulso" style="display: ${modelos.length ? 'none' : 'flex'}; flex-direction: column; gap: 14px">
          <div class="campo"><label>Nome do pacote</label><input name="nome" placeholder="Pacote 24 banhos"></div>
          <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 10px">
            <div class="campo"><label>Banhos</label><input name="qtd_banhos" type="number" min="1" step="1"></div>
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

    modal.querySelector('#form-modal').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const f = new FormData(ev.target);
      const modeloId = seletor ? seletor.value : '';
      try {
        const corpo = { cliente_id: clienteId };
        if (modeloId) {
          corpo.modelo_id = parseInt(modeloId, 10);
        } else {
          const centavos = paraCentavos(f.get('valor'));
          if (!Number.isFinite(centavos)) throw new Error('Informe o valor do pacote.');
          corpo.nome = f.get('nome');
          corpo.qtd_banhos = parseInt(f.get('qtd_banhos'), 10);
          corpo.valor_centavos = centavos;
          corpo.validade_meses = f.get('validade_meses') ? parseInt(f.get('validade_meses'), 10) : null;
        }
        await api('/pacotes', { method: 'POST', body: corpo });
        fecharModal(); toast('Pacote registrado.');
        window.location.hash = `#/cliente/${clienteId}`;
        renderizar();
      } catch (err) { toast(err.message, true); }
    });
  }

  // ─── Dar baixa ───────────────────────────────────────────────────

  async function modalDarBaixa(clienteId) {
    const c = await api(`/clientes/${clienteId}`);
    const pacote = pacoteEmConsumo(c.pacotes);
    if (!pacote) { toast('Este cliente não tem pacote ativo.', true); return; }
    // O servidor transborda para o próximo pacote ATIVO quando o em
    // consumo não cobre tudo — aqui mostramos o saldo somado.
    const saldoTotal = c.pacotes
      .filter(p => p.status === 'ATIVO')
      .reduce((soma, p) => soma + p.saldo, 0);

    const modal = abrirModal(`
      <h3>Dar baixa — ${esc(c.nome)}</h3>
      <p style="font-size: 0.88rem; color: var(--text-muted)">
        ${esc(pacote.nome)} · saldo <strong>${pacote.saldo}</strong>${saldoTotal > pacote.saldo ? ` (+${saldoTotal - pacote.saldo} no próximo pacote)` : ''}
      </p>
      <form id="form-modal" style="display: flex; flex-direction: column; gap: 14px">
        ${c.pets.length ? `
        <div class="campo"><label>Quais pets tomaram banho?</label>
          <div style="display: flex; flex-direction: column; gap: 8px; margin-top: 4px">
            ${c.pets.map(p => `
              <label style="display: flex; align-items: center; gap: 10px; font-size: 0.92rem; text-transform: none; letter-spacing: 0; font-weight: 500; color: var(--text-main); cursor: pointer">
                <input type="checkbox" name="pet" value="${p.id}" ${c.pets.length === 1 ? 'checked' : ''} style="width: 17px; height: 17px; accent-color: var(--primary)">
                ${esc(p.nome)}${p.raca ? ` <span style="color: var(--text-subtle)">· ${esc(p.raca)}</span>` : ''}
              </label>`).join('')}
          </div>
        </div>` : `
        <div class="campo"><label>Quantos banhos?</label>
          <input name="quantidade" type="number" min="1" max="${saldoTotal}" step="1" value="1">
        </div>`}
        <div class="campo"><label>Serviço</label><input name="servico" value="Banho"></div>
        <div class="campo"><label>Observação (opcional)</label><input name="observacao"></div>
        <div id="resumo-baixa" style="font-size: 0.88rem; color: var(--text-muted)"></div>
        ${rodapeModal('Confirmar baixa')}
      </form>`);
    ligarFechar(modal);

    const form = modal.querySelector('#form-modal');
    const resumo = modal.querySelector('#resumo-baixa');
    function totalItens() {
      if (c.pets.length) {
        return [...form.querySelectorAll('[name="pet"]:checked')].length;
      }
      return parseInt(form.querySelector('[name="quantidade"]').value, 10) || 0;
    }
    function atualizarResumo() {
      const n = totalItens();
      resumo.textContent = n > 0
        ? `${n} banho${n === 1 ? '' : 's'} — o saldo vai de ${saldoTotal} para ${saldoTotal - n}.`
        : 'Selecione pelo menos um banho.';
      if (n > saldoTotal) resumo.textContent = `Saldo insuficiente: restam ${saldoTotal} banho(s).`;
    }
    form.addEventListener('change', atualizarResumo);
    form.addEventListener('input', atualizarResumo);
    atualizarResumo();

    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const f = new FormData(form);
      const servico = f.get('servico');
      const observacao = f.get('observacao');
      let itens;
      if (c.pets.length) {
        itens = [...form.querySelectorAll('[name="pet"]:checked')]
          .map(caixa => ({ pet_id: parseInt(caixa.value, 10), servico }));
      } else {
        const n = parseInt(f.get('quantidade'), 10) || 0;
        itens = Array.from({ length: n }, () => ({ servico }));
      }
      if (!itens.length) { toast('Selecione pelo menos um banho.', true); return; }
      try {
        const r = await api('/baixas', { method: 'POST', body: { pacote_id: pacote.id, itens, observacao } });
        fecharModal();
        toast(`Baixa registrada. Saldo: ${r.saldo}.`);
        renderizar();
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
      if (!window.confirm('Cancelar este pacote? O saldo restante deixa de valer.')) return;
      try {
        await api(`/pacotes/${pacote.id}`, { method: 'PUT', body: { status: 'CANCELADO' } });
        fecharModal(); toast('Pacote cancelado.'); verFicha(clienteId);
      } catch (err) { toast(err.message, true); }
    });
  }

  // ─── Pacotes (catálogo) ──────────────────────────────────────────

  async function verPacotes() {
    const modelos = await api('/pacotes/modelos');
    conteudo.innerHTML = `
      <div class="linha-cabecalho">
        <div class="cabecalho-pagina">
          <h2>Pacotes</h2>
          <p>Catálogo de pacotes que o petshop vende</p>
        </div>
        ${ehAdmin() ? '<button class="btn-primario" id="botao-novo-modelo" type="button">Novo modelo</button>' : ''}
      </div>
      ${modelos.length ? `<div class="lista">${modelos.map(m => `
        <div class="linha" style="${m.ativo ? '' : 'opacity: 0.55'}">
          <div style="flex: 1">
            <div class="linha-titulo">${esc(m.nome)}</div>
            <div class="linha-sub">
              ${m.qtd_banhos} banhos · ${formatarReais(m.valor_centavos)}
              (${formatarReais(Math.round(m.valor_centavos / m.qtd_banhos))} por banho)
              ${m.validade_meses ? ` · validade ${m.validade_meses} meses` : ' · sem validade'}
            </div>
          </div>
          ${m.ativo ? '<span class="chip ok">Ativo</span>' : '<span class="chip">Inativo</span>'}
          ${ehAdmin() ? `<button class="btn-fantasma btn-mini" data-editar="${m.id}" type="button">Editar</button>` : ''}
        </div>`).join('')}</div>`
      : `<div class="vazio">Nenhum modelo cadastrado.${ehAdmin() ? '<br>Cadastre o primeiro — por exemplo: Pacote 24 banhos, R$ 700,00.' : ''}</div>`}`;

    const botaoNovo = document.getElementById('botao-novo-modelo');
    if (botaoNovo) botaoNovo.addEventListener('click', () => modalModelo(null));
    conteudo.querySelectorAll('[data-editar]').forEach(b =>
      b.addEventListener('click', () => {
        const m = modelos.find(x => x.id === parseInt(b.dataset.editar, 10));
        if (m) modalModelo(m);
      }));
  }

  function modalModelo(m) {
    const modal = abrirModal(`
      <h3>${m ? 'Editar modelo' : 'Novo modelo de pacote'}</h3>
      <form id="form-modal" style="display: flex; flex-direction: column; gap: 14px">
        <div class="campo"><label>Nome</label><input name="nome" value="${m ? esc(m.nome) : ''}" placeholder="Pacote 24 banhos" required></div>
        <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 10px">
          <div class="campo"><label>Banhos</label><input name="qtd_banhos" type="number" min="1" step="1" value="${m ? m.qtd_banhos : ''}" required></div>
          <div class="campo"><label>Valor (R$)</label><input name="valor" inputmode="decimal" value="${m ? (m.valor_centavos / 100).toFixed(2).replace('.', ',') : ''}" placeholder="700,00" required></div>
          <div class="campo"><label>Validade (meses)</label><input name="validade_meses" type="number" min="1" step="1" value="${m && m.validade_meses ? m.validade_meses : ''}" placeholder="12"></div>
        </div>
        ${m ? `
        <label style="display: flex; align-items: center; gap: 10px; font-size: 0.9rem; cursor: pointer">
          <input type="checkbox" name="ativo" ${m.ativo ? 'checked' : ''} style="width: 17px; height: 17px; accent-color: var(--primary)">
          Disponível para venda
        </label>` : ''}
        ${rodapeModal(m ? 'Salvar' : 'Cadastrar')}
      </form>`);
    ligarFechar(modal);
    modal.querySelector('#form-modal').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const f = new FormData(ev.target);
      const centavos = paraCentavos(f.get('valor'));
      if (!Number.isFinite(centavos)) { toast('Valor inválido.', true); return; }
      const corpo = {
        nome: f.get('nome'),
        qtd_banhos: parseInt(f.get('qtd_banhos'), 10),
        valor_centavos: centavos,
        validade_meses: f.get('validade_meses') ? parseInt(f.get('validade_meses'), 10) : null,
      };
      try {
        if (m) {
          corpo.ativo = f.get('ativo') === 'on';
          await api(`/pacotes/modelos/${m.id}`, { method: 'PUT', body: corpo });
        } else {
          await api('/pacotes/modelos', { method: 'POST', body: corpo });
        }
        fecharModal(); toast('Catálogo atualizado.'); verPacotes();
      } catch (err) { toast(err.message, true); }
    });
  }

  // ─── Configurações ───────────────────────────────────────────────

  async function verConfig() {
    if (!ehAdmin()) {
      conteudo.innerHTML = `
        <div class="cabecalho-pagina"><h2>Configurações</h2></div>
        <div class="vazio">Apenas administradores acessam as configurações.</div>`;
      return;
    }
    const emp = await api('/empresa');
    conteudo.innerHTML = `
      <div class="cabecalho-pagina">
        <h2>Configurações</h2>
        <p>Plano ${esc(emp.plano)} · acesso até ${dataLonga(emp.acesso_ate)}</p>
      </div>
      <div class="cartao" style="padding: 24px; max-width: 560px">
        <form id="form-empresa" style="display: flex; flex-direction: column; gap: 14px">
          <div class="rotulo-secao">Dados do petshop</div>
          <div class="campo"><label>Nome</label><input name="nome" value="${esc(emp.nome)}" required></div>
          <div class="campo"><label>WhatsApp (usado no portal do cliente)</label>
            <input name="whatsapp" value="${esc(emp.whatsapp || '')}" placeholder="67999999999"></div>
          <button class="btn-primario" type="submit" style="align-self: flex-start">Salvar</button>
        </form>
      </div>
      <div class="cartao" style="padding: 24px; max-width: 560px; display: flex; flex-direction: column; gap: 14px">
        <div style="display: flex; justify-content: space-between; align-items: center">
          <div class="rotulo-secao">Equipe</div>
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
      </div>`;

    document.getElementById('form-empresa').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const f = new FormData(ev.target);
      try {
        await api('/empresa', { method: 'PUT', body: { nome: f.get('nome'), whatsapp: f.get('whatsapp') } });
        toast('Dados salvos.');
        await carregarSessao();
        document.getElementById('nome-empresa').textContent = sessao.empresa.nome;
      } catch (err) { toast(err.message, true); }
    });

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

  // ─── Roteador ────────────────────────────────────────────────────

  function marcarAba(rota) {
    document.querySelectorAll('#abas .aba').forEach(a => {
      const alvo = a.getAttribute('href').replace('#/', '');
      a.classList.toggle('ativa', rota === alvo || (alvo === 'clientes' && rota.startsWith('cliente')));
    });
  }

  async function renderizar() {
    const hash = window.location.hash.replace(/^#\//, '') || 'visao';
    const [rota, parametro] = hash.split('/');
    marcarAba(hash);

    if (sessao && !sessao.empresa.acesso_vigente) {
      conteudo.innerHTML = `
        <div class="faixa-aviso">
          O acesso do petshop ao SaferPet expirou em ${dataLonga(sessao.empresa.acesso_ate)}.
          Fale com a SaferSoftware para renovar — os dados estão guardados e voltam ao normal na renovação.
        </div>`;
      return;
    }

    try {
      if (rota === 'clientes') await verClientes();
      else if (rota === 'cliente' && parametro) await verFicha(parseInt(parametro, 10));
      else if (rota === 'pacotes') await verPacotes();
      else if (rota === 'config') await verConfig();
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

  // ─── Boot ────────────────────────────────────────────────────────

  document.getElementById('botao-sair').addEventListener('click', sair);
  window.addEventListener('hashchange', renderizar);

  if (!localStorage.getItem('saferpet_token')) {
    window.location.href = '/';
  } else {
    carregarSessao()
      .then(() => {
        document.getElementById('nome-empresa').textContent = sessao.empresa.nome;
        renderizar();
      })
      .catch(() => sair());
  }
})();
