'use strict';

// App do cliente. Acesso pelo link com token — sem senha. Permite ver
// créditos, comprar pacote, agendar (com leva-e-traz) e cancelar.

(function () {
  const raiz = document.getElementById('portal');
  const token = decodeURIComponent(window.location.pathname.split('/').pop());
  let dados = null;
  let extras = null;
  const carrinho = new Map(); // produto_id -> quantidade

  const PATA = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="15.5" rx="4.2" ry="3.4"></ellipse><circle cx="6.2" cy="10.4" r="1.9"></circle><circle cx="10" cy="7.2" r="1.9"></circle><circle cx="14" cy="7.2" r="1.9"></circle><circle cx="17.8" cy="10.4" r="1.9"></circle></svg>';
  const FONE = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 2 .7 2.9a2 2 0 0 1-.5 2.1L8 10a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.5c.9.3 1.9.6 2.9.7a2 2 0 0 1 1.7 2z"></path></svg>';

  function esc(texto) {
    return String(texto === null || texto === undefined ? '' : texto)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function hojeISO() { return new Date().toLocaleDateString('sv-SE'); }

  const SITUACAO_PEDIDO = {
    AGUARDANDO_PAGAMENTO: 'Aguardando pagamento', PAGO: 'Pagamento confirmado',
    SEPARADO: 'Separado, saindo para entrega', EM_ROTA: 'A caminho', ENTREGUE: 'Entregue',
  };

  // Data de calendário (DATE) ancora ao meio-dia local; timestamp de
  // verdade (hora do registro) converte normalmente. Sem isso o fuso
  // mostra o dia anterior.
  function ehDataDeCalendario(texto) {
    return /^\d{4}-\d{2}-\d{2}$/.test(texto) || /^\d{4}-\d{2}-\d{2}T00:00:00(\.000)?Z$/.test(texto);
  }

  function dataCurta(valor) {
    if (!valor) return '';
    const texto = String(valor);
    const d = ehDataDeCalendario(texto)
      ? new Date(`${texto.slice(0, 10)}T12:00:00`)
      : new Date(valor);
    return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
  }

  function dataLonga(valor) {
    if (!valor) return '';
    return new Date(`${String(valor).slice(0, 10)}T12:00:00`).toLocaleDateString('pt-BR');
  }

  function formatarReais(centavos) {
    return (Number(centavos || 0) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  }

  function toast(texto, ehErro) {
    const el = document.createElement('div');
    el.className = 'toast' + (ehErro ? ' erro' : '');
    el.textContent = texto;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 4500);
  }

  async function api(caminho, opcoes = {}) {
    const resp = await fetch(`/api/portal/${encodeURIComponent(token)}${caminho}`, {
      ...opcoes,
      headers: { 'Content-Type': 'application/json', ...(opcoes.headers || {}) },
      body: opcoes.body ? JSON.stringify(opcoes.body) : undefined,
    });
    const corpo = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(corpo.erro || 'Algo deu errado. Tente de novo.');
    return corpo;
  }

  async function apiPagamentos(caminho, opcoes = {}) {
    const resp = await fetch(`/api/pagamentos/portal/${encodeURIComponent(token)}${caminho}`, {
      ...opcoes,
      headers: { 'Content-Type': 'application/json', ...(opcoes.headers || {}) },
      body: opcoes.body ? JSON.stringify(opcoes.body) : undefined,
    });
    const corpo = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(corpo.erro || 'Algo deu errado. Tente de novo.');
    return corpo;
  }

  // ─── Modal ───────────────────────────────────────────────────────

  function abrirModal(html) {
    fecharModal();
    const fundo = document.createElement('div');
    fundo.className = 'modal-fundo';
    fundo.id = 'modal-portal';
    fundo.innerHTML = `<div class="modal">${html}</div>`;
    fundo.addEventListener('click', (ev) => { if (ev.target === fundo) fecharModal(); });
    document.body.appendChild(fundo);
    fundo.querySelectorAll('[data-fechar]').forEach(b => b.addEventListener('click', fecharModal));
    return fundo.querySelector('.modal');
  }

  function fecharModal() {
    const atual = document.getElementById('modal-portal');
    if (atual) atual.remove();
  }

  // ─── Créditos disponíveis por serviço ────────────────────────────

  function creditosPorServico() {
    const hoje = hojeISO();
    const totais = new Map();
    for (const p of dados.pacotes || []) {
      if (p.status !== 'ATIVO') continue;
      if (p.validade_ate && String(p.validade_ate).slice(0, 10) < hoje) continue;
      for (const item of p.itens || []) {
        if (!item.saldo) continue;
        totais.set(item.servico_id, (totais.get(item.servico_id) || 0) + item.saldo);
      }
    }
    return totais;
  }

  // ─── Tela principal ──────────────────────────────────────────────

  function renderizar() {
    const ativos = (dados.pacotes || []).filter(p => p.status === 'ATIVO');
    const pacote = ativos[0] || (dados.pacotes || [])[0] || null;
    const proximos = ativos.slice(1);
    const saldoProximos = proximos.reduce((soma, p) => soma + p.saldo, 0);
    const percentual = pacote && pacote.qtd_banhos ? Math.round((pacote.saldo / pacote.qtd_banhos) * 100) : 0;
    const acabando = pacote && (pacote.saldo + saldoProximos) <= 3;

    const petsNomes = (dados.pets || []).map(p => esc(p.nome)).join(' e ');
    const numeroWhats = String(dados.petshop.whatsapp || '').replace(/\D/g, '');
    const linkWhats = numeroWhats
      ? `https://wa.me/${numeroWhats.length <= 11 ? '55' + numeroWhats : numeroWhats}?text=${encodeURIComponent('Olá! Falo sobre os meus pets.')}`
      : null;

    const podeAgendar = dados.petshop.aceita_online && (dados.servicos || []).length > 0;
    const podeComprar = dados.petshop.pagamento_disponivel && (dados.pacotes_a_venda || []).length > 0;

    raiz.innerHTML = `
      <div style="display: flex; align-items: center; gap: 12px">
        <div class="marca-icone" style="width: 44px; height: 44px; ${dados.petshop.tem_logo ? 'padding: 2px; background: var(--bg-panel)' : ''}">
          ${dados.petshop.tem_logo
            ? `<img src="/api/portal/${encodeURIComponent(token)}/logo?v=${esc(dados.petshop.logo_versao || '')}" alt=""
                 style="width: 100%; height: 100%; object-fit: contain; border-radius: 10px">`
            : PATA}
        </div>
        <div>
          <div class="marca-nome" style="font-size: 1.35rem">${esc(dados.petshop.nome)}</div>
          <div class="marca-empresa">Olá, ${esc(dados.cliente.nome)}</div>
        </div>
      </div>

      ${pacote ? `
      <div class="cartao" style="padding: 22px; display: flex; flex-direction: column; gap: 14px">
        <div style="display: flex; justify-content: space-between; align-items: center">
          <div class="rotulo-secao">Seu saldo</div>
          <div class="chip ${pacote.status === 'ESGOTADO' || acabando ? 'alerta' : 'ok'}">
            ${pacote.status === 'ESGOTADO' ? 'Esgotado' : (acabando ? 'Acabando' : 'Em dia')}
          </div>
        </div>
        <div style="display: flex; align-items: baseline; gap: 10px">
          <div class="portal-saldo">${pacote.saldo}</div>
          <div style="font-size: 0.95rem; color: var(--text-muted)">
            crédito${pacote.saldo === 1 ? '' : 's'} restante${pacote.saldo === 1 ? '' : 's'}
          </div>
        </div>
        <div class="barra" style="height: 9px"><div class="${acabando ? 'baixa' : ''}" style="width: ${percentual}%"></div></div>
        ${(pacote.itens || []).length > 1 ? `
        <div style="display: flex; flex-direction: column; gap: 6px; border-top: 1px solid var(--border); padding-top: 10px">
          ${pacote.itens.map(i => `
            <div style="display: flex; justify-content: space-between; font-size: 0.82rem">
              <span style="font-weight: 600">${esc(i.servico_nome)}</span>
              <span style="color: var(--text-muted); font-variant-numeric: tabular-nums">${i.saldo} de ${i.quantidade}</span>
            </div>`).join('')}
        </div>` : ''}
        <div style="display: flex; justify-content: space-between; font-size: 0.78rem; color: var(--text-subtle)">
          <span>${esc(pacote.nome)}</span>
          <span>${pacote.validade_ate ? 'válido até ' + dataLonga(pacote.validade_ate) : 'sem validade'}</span>
        </div>
        ${proximos.map(p => `
        <div style="display: flex; justify-content: space-between; font-size: 0.78rem; color: var(--text-muted); border-top: 1px solid var(--border); padding-top: 10px">
          <span>Próximo: ${esc(p.nome)}</span>
          <span>+${p.saldo} crédito${p.saldo === 1 ? '' : 's'}</span>
        </div>`).join('')}
      </div>` : `
      <div class="vazio">Você ainda não tem pacote ativo.${podeComprar ? '<br>Compre um abaixo e já saia agendando.' : '<br>Fale com o petshop para contratar.'}</div>`}

      <div style="display: flex; gap: 10px; flex-wrap: wrap">
        ${podeAgendar ? '<button class="btn-primario" id="botao-agendar" type="button" style="flex: 1; min-width: 140px">Agendar horário</button>' : ''}
        ${podeComprar ? `<button class="${pacote ? 'btn-fantasma' : 'btn-primario'}" id="botao-comprar" type="button" style="flex: 1; min-width: 140px">Comprar pacote</button>` : ''}
        ${dados.petshop.vende_produtos ? '<button class="btn-fantasma" id="botao-loja" type="button" style="flex: 1; min-width: 140px">Loja</button>' : ''}
      </div>

      ${(extras && extras.a_avaliar) ? `
      <div class="cartao" style="padding: 18px; display: flex; flex-direction: column; gap: 10px; border-color: var(--primary-border)">
        <div class="rotulo-secao">Como foi o atendimento?</div>
        <div style="font-size: 0.86rem; color: var(--text-muted)">
          ${esc(extras.a_avaliar.pet_nome || 'Seu pet')} · ${esc(extras.a_avaliar.servico_nome || '')} em ${dataCurta(extras.a_avaliar.data)}
        </div>
        <div style="display: flex; gap: 8px" id="estrelas">
          ${[1, 2, 3, 4, 5].map(n => `
            <button type="button" class="btn-fantasma" data-nota="${n}"
              style="flex: 1; min-width: 44px; min-height: 44px; font-size: 1.1rem">${n}</button>`).join('')}
        </div>
      </div>` : ''}

      ${(dados.pedidos || []).length ? `
      <div class="cartao" style="padding: 18px; display: flex; flex-direction: column; gap: 10px">
        <div class="rotulo-secao">Seus pedidos</div>
        ${dados.pedidos.map(p => `
          <div style="display: flex; align-items: center; gap: 12px; padding: 10px 14px; background: var(--bg-inset); border: 1px solid var(--border); border-radius: 12px">
            <div style="flex: 1">
              <div style="font-size: 0.86rem; font-weight: 600">Pedido #${p.id} · ${formatarReais(p.valor_centavos)}</div>
              <div style="font-size: 0.74rem; color: var(--text-muted)">
                ${esc(SITUACAO_PEDIDO[p.status] || p.status)}${p.entrega_data ? ` · entrega ${dataCurta(p.entrega_data)} às ${p.entrega_inicio}` : (p.entrega === 'RETIRADA' ? ' · retirada no balcão' : '')}
              </div>
            </div>
          </div>`).join('')}
      </div>` : ''}

      ${(extras && extras.fotos.length) ? `
      <div class="cartao" style="padding: 18px; display: flex; flex-direction: column; gap: 12px">
        <div class="rotulo-secao">Fotos do seu pet</div>
        <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(96px, 1fr)); gap: 8px">
          ${extras.fotos.map(f => `
            <img src="${esc(f.conteudo)}" alt="${esc(f.legenda || 'Foto do pet')}"
                 style="width: 100%; aspect-ratio: 1; object-fit: cover; border-radius: 12px; border: 1px solid var(--border)">`).join('')}
        </div>
      </div>` : ''}

      ${(extras && extras.vacinas.length) ? `
      <div class="cartao" style="padding: 18px; display: flex; flex-direction: column; gap: 10px">
        <div class="rotulo-secao">Carteirinha de vacinação</div>
        ${extras.vacinas.map(v => {
          const vencida = v.reforco_em && String(v.reforco_em).slice(0, 10) < hojeISO();
          return `
          <div style="display: flex; align-items: center; gap: 12px; padding: 10px 14px; background: var(--bg-inset); border: 1px solid var(--border); border-radius: 12px">
            <div style="flex: 1">
              <div style="font-size: 0.86rem; font-weight: 600">${esc(v.pet_nome)} · ${esc(v.nome)}</div>
              <div style="font-size: 0.74rem; color: var(--text-muted)">
                ${dataCurta(v.aplicada_em)}${v.reforco_em ? ` · reforço em ${dataLonga(v.reforco_em)}` : ''}
              </div>
            </div>
            ${v.reforco_em ? `<span class="chip ${vencida ? 'alerta' : 'ok'}">${vencida ? 'Renovar' : 'Em dia'}</span>` : ''}
          </div>`;
        }).join('')}
      </div>` : ''}

      ${(dados.agendamentos || []).length ? `
      <div class="cartao" style="padding: 18px; display: flex; flex-direction: column; gap: 12px">
        <div class="rotulo-secao" style="font-size: 0.7rem">Próximos agendamentos</div>
        <div style="display: flex; flex-direction: column; gap: 8px">
          ${dados.agendamentos.map(a => `
            <div style="display: flex; align-items: center; gap: 12px; padding: 10px 14px; background: var(--bg-inset); border: 1px solid var(--border); border-radius: 12px">
              <div style="font-family: var(--fonte-titulo); font-size: 1rem; font-weight: 550; color: var(--primary-ink); min-width: 52px; font-variant-numeric: tabular-nums">${dataCurta(a.data)}</div>
              <div style="flex: 1">
                <div style="font-size: 0.86rem; font-weight: 600">${a.inicio} · ${esc(a.servico_nome || '')}</div>
                <div style="font-size: 0.74rem; color: var(--text-muted)">${a.pet_nome ? esc(a.pet_nome) : ''}${a.leva_traz ? ' · vamos buscar em casa' : ''}</div>
              </div>
              <button class="btn-fantasma btn-mini perigo" data-cancelar="${a.id}" type="button">Desmarcar</button>
            </div>`).join('')}
        </div>
      </div>` : ''}

      ${petsNomes ? `
      <div class="cartao" style="padding: 16px 18px; display: flex; align-items: center; gap: 12px">
        <div style="flex: 1">
          <div class="rotulo-secao">Seus pets</div>
          <div style="font-size: 0.95rem; font-weight: 600; margin-top: 4px">${petsNomes}</div>
        </div>
        <button class="btn-fantasma btn-mini" id="botao-novo-pet" type="button">Adicionar</button>
      </div>` : `
      <div class="cartao" style="padding: 16px 18px; display: flex; align-items: center; gap: 12px">
        <div style="flex: 1"><div class="rotulo-secao">Seus pets</div>
          <div style="font-size: 0.82rem; color: var(--text-muted); margin-top: 4px">Nenhum cadastrado ainda.</div></div>
        <button class="btn-fantasma btn-mini" id="botao-novo-pet" type="button">Adicionar</button>
      </div>`}

      ${(dados.ultimas_baixas || []).length ? `
      <div class="cartao" style="padding: 18px; display: flex; flex-direction: column; gap: 12px">
        <div class="rotulo-secao">Últimos serviços</div>
        <div style="display: flex; flex-direction: column; gap: 8px">
          ${dados.ultimas_baixas.slice(0, 5).map(b => `
            <div style="display: flex; align-items: center; gap: 12px; padding: 10px 14px; background: var(--bg-inset); border: 1px solid var(--border); border-radius: 12px">
              <div style="font-family: var(--fonte-titulo); font-size: 1rem; font-weight: 550; color: var(--primary-ink); min-width: 52px; font-variant-numeric: tabular-nums">${dataCurta(b.registrado_em)}</div>
              <div style="flex: 1">
                <div style="font-size: 0.86rem; font-weight: 600">${b.pet_nome ? esc(b.pet_nome) + ' · ' : ''}${esc(b.servico)}</div>
                <div style="font-size: 0.74rem; color: var(--text-muted)">restavam ${b.saldo_apos} deste serviço</div>
              </div>
            </div>`).join('')}
        </div>
      </div>` : ''}

      <div style="display: flex; gap: 10px">
        <button class="btn-fantasma" id="botao-meus-dados" type="button" style="flex: 1">Meus dados</button>
        ${linkWhats ? `<a class="btn-fantasma" style="flex: 1; text-decoration: none" href="${linkWhats}">${FONE} WhatsApp</a>` : ''}
      </div>

      <div style="font-size: 0.72rem; color: var(--text-subtle); text-align: center">Controle de pacotes por SaferPet</div>
    `;

    const bAgendar = document.getElementById('botao-agendar');
    if (bAgendar) bAgendar.addEventListener('click', modalAgendar);
    const bComprar = document.getElementById('botao-comprar');
    if (bComprar) bComprar.addEventListener('click', modalComprar);
    const bLoja = document.getElementById('botao-loja');
    if (bLoja) bLoja.addEventListener('click', modalLoja);
    document.getElementById('botao-novo-pet').addEventListener('click', modalNovoPet);
    document.getElementById('botao-meus-dados').addEventListener('click', modalMeusDados);

    raiz.querySelectorAll('[data-nota]').forEach(b =>
      b.addEventListener('click', async () => {
        const nota = parseInt(b.dataset.nota, 10);
        try {
          await api('/avaliar', { method: 'POST', body: {
            agendamento_id: extras.a_avaliar.id, nota,
          }});
          toast(nota >= 4 ? 'Obrigado pela avaliação!' : 'Obrigado — vamos melhorar.');
          await carregar();
        } catch (err) { toast(err.message, true); }
      }));

    raiz.querySelectorAll('[data-cancelar]').forEach(b =>
      b.addEventListener('click', async () => {
        if (!window.confirm('Desmarcar este horário?')) return;
        try {
          await api(`/agendamentos/${b.dataset.cancelar}/cancelar`, { method: 'POST' });
          toast('Horário desmarcado.');
          await carregar();
        } catch (err) { toast(err.message, true); }
      }));
  }

  // ─── Agendar ─────────────────────────────────────────────────────

  function modalAgendar() {
    const creditos = creditosPorServico();
    const servicos = dados.servicos || [];
    const temEndereco = !!dados.cliente.endereco;

    const modal = abrirModal(`
      <h3>Agendar horário</h3>
      <form id="form-agendar" style="display: flex; flex-direction: column; gap: 14px">
        <div class="campo"><label>Serviço</label>
          <select name="servico_id">
            ${servicos.map(s => {
              const cred = creditos.get(s.id) || 0;
              const rotulo = cred > 0
                ? `${s.nome} — ${cred} crédito${cred === 1 ? '' : 's'}`
                : `${s.nome}${s.preco_centavos ? ' — ' + formatarReais(s.preco_centavos) : ''}`;
              return `<option value="${s.id}">${esc(rotulo)}</option>`;
            }).join('')}
          </select>
        </div>
        ${(dados.pets || []).length ? `
        <div class="campo"><label>Pet</label>
          <select name="pet_id">
            ${dados.pets.map(p => `<option value="${p.id}">${esc(p.nome)}</option>`).join('')}
          </select>
        </div>` : ''}
        <div class="campo"><label>Dia</label>
          <input name="data" type="date" min="${hojeISO()}" value="${hojeISO()}" required>
        </div>
        <label id="rotulo-leva-traz" style="display: none; align-items: center; gap: 10px; font-size: 0.9rem; cursor: pointer">
          <input type="checkbox" name="leva_traz" style="width: 18px; height: 18px; accent-color: var(--primary)">
          Buscar meu pet em casa
        </label>
        <div id="aviso-endereco" style="display: none; font-size: 0.8rem; color: var(--danger)">
          Cadastre o endereço em "Meus dados" para pedir busca em casa.
        </div>
        <div class="campo"><label>Horário</label>
          <div class="pilulas-horario" id="pilulas"></div>
          <input type="hidden" name="inicio">
        </div>
        <div id="aviso-credito" style="font-size: 0.8rem; color: var(--text-muted)"></div>
        <div style="display: flex; gap: 10px; justify-content: flex-end">
          <button type="button" class="btn-fantasma" data-fechar>Cancelar</button>
          <button type="submit" class="btn-primario">Confirmar</button>
        </div>
      </form>`);

    const form = modal.querySelector('#form-agendar');
    const pilulas = modal.querySelector('#pilulas');
    const campoInicio = form.querySelector('[name="inicio"]');
    const rotuloLevaTraz = modal.querySelector('#rotulo-leva-traz');
    const avisoEndereco = modal.querySelector('#aviso-endereco');
    const avisoCredito = modal.querySelector('#aviso-credito');
    const caixaLevaTraz = form.querySelector('[name="leva_traz"]');

    function atualizarAvisoCredito() {
      const servicoId = parseInt(form.querySelector('[name="servico_id"]').value, 10);
      const servico = servicos.find(s => s.id === servicoId);
      const cred = creditos.get(servicoId) || 0;
      avisoCredito.textContent = cred > 0
        ? `Você tem ${cred} crédito${cred === 1 ? '' : 's'} de ${servico ? servico.nome : 'serviço'} — será descontado quando o serviço for concluído.`
        : `Sem crédito deste serviço: o petshop cobra${servico && servico.preco_centavos ? ' ' + formatarReais(servico.preco_centavos) : ''} no atendimento.`;
    }

    async function carregarHorarios() {
      campoInicio.value = '';
      pilulas.innerHTML = '<span style="color: var(--text-subtle); font-size: 0.85rem">Carregando…</span>';
      const data = form.querySelector('[name="data"]').value;
      const servicoId = form.querySelector('[name="servico_id"]').value;
      if (!data || !servicoId) { pilulas.innerHTML = ''; return; }
      try {
        const r = await api(`/horarios-livres?data=${data}&servico_id=${servicoId}&leva_traz=${caixaLevaTraz.checked}`);
        rotuloLevaTraz.style.display = r.leva_traz_disponivel ? 'flex' : 'none';
        avisoEndereco.style.display = (r.leva_traz_disponivel && !temEndereco) ? 'block' : 'none';
        if (!r.horarios.length) {
          // Dia cheio: em vez de só dizer não, oferece a fila de encaixe.
          pilulas.innerHTML = `
            <div style="display: flex; flex-direction: column; gap: 8px; width: 100%">
              <span style="color: var(--text-muted); font-size: 0.85rem">Este dia está cheio.</span>
              <button type="button" class="btn-fantasma" id="botao-fila" style="align-self: flex-start">
                Avisem-me se abrir vaga
              </button>
            </div>`;
          const botaoFila = pilulas.querySelector('#botao-fila');
          botaoFila.addEventListener('click', async () => {
            botaoFila.disabled = true;
            try {
              await api('/fila', { method: 'POST', body: {
                servico_id: parseInt(form.querySelector('[name="servico_id"]').value, 10),
                pet_id: form.querySelector('[name="pet_id"]') ? parseInt(form.querySelector('[name="pet_id"]').value, 10) : null,
                data,
              }});
              fecharModal();
              toast('Pronto! O petshop avisa você se abrir vaga neste dia.');
            } catch (err) {
              toast(err.message, true);
              botaoFila.disabled = false;
            }
          });
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

    form.querySelector('[name="servico_id"]').addEventListener('change', () => {
      atualizarAvisoCredito(); carregarHorarios();
    });
    form.querySelector('[name="data"]').addEventListener('change', carregarHorarios);
    caixaLevaTraz.addEventListener('change', () => {
      if (caixaLevaTraz.checked && !temEndereco) {
        caixaLevaTraz.checked = false;
        toast('Cadastre o endereço em "Meus dados" primeiro.', true);
        return;
      }
      carregarHorarios();
    });
    atualizarAvisoCredito();
    carregarHorarios();

    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const botao = form.querySelector('[type="submit"]');
      if (botao.disabled) return;
      const f = new FormData(form);
      if (!f.get('inicio')) { toast('Escolha um horário.', true); return; }
      botao.disabled = true;
      try {
        const r = await api('/agendar', { method: 'POST', body: {
          pet_id: f.get('pet_id') ? parseInt(f.get('pet_id'), 10) : null,
          servico_id: parseInt(f.get('servico_id'), 10),
          data: f.get('data'),
          inicio: f.get('inicio'),
          leva_traz: caixaLevaTraz.checked,
        }});
        fecharModal();
        if (r.busca && r.aviso_entrega) {
          // Não prometa o que a agenda não comporta.
          toast(`Agendado! Buscamos às ${r.busca.inicio}. A volta o petshop combina com você.`, true);
        } else if (r.busca && r.entrega) {
          toast(`Agendado! Buscamos às ${r.busca.inicio} e devolvemos às ${r.entrega.inicio}.`);
        } else if (r.busca) {
          toast(`Agendado! Vamos buscar seu pet às ${r.busca.inicio}.`);
        } else {
          toast(`Agendado para ${f.get('inicio')}.`);
        }
        await carregar();
      } catch (err) {
        toast(err.message, true);
        botao.disabled = false;
        carregarHorarios();
      }
    });
  }

  // ─── Comprar pacote ──────────────────────────────────────────────

  function modalComprar() {
    const modal = abrirModal(`
      <h3>Comprar pacote</h3>
      <p style="font-size: 0.86rem; color: var(--text-muted); line-height: 1.5">
        O pagamento é pelo Mercado Pago (Pix ou cartão). Assim que for aprovado,
        os créditos entram aqui e você já pode agendar.
      </p>
      <div style="display: flex; flex-direction: column; gap: 10px">
        ${(dados.pacotes_a_venda || []).map(m => `
          <button type="button" class="linha" data-modelo="${m.id}" style="width: 100%; text-align: left; cursor: pointer; background: var(--bg-panel)">
            <div style="flex: 1">
              <div class="linha-titulo">${esc(m.nome)}</div>
              <div class="linha-sub">${(m.itens || []).map(i => `${i.quantidade} ${esc(i.servico_nome)}`).join(' + ')}${m.validade_meses ? ` · vale ${m.validade_meses} meses` : ''}</div>
            </div>
            <div style="font-family: var(--fonte-titulo); font-size: 1.15rem; font-weight: 550; color: var(--primary-ink)">${formatarReais(m.valor_centavos)}</div>
          </button>`).join('')}
      </div>
      <div style="display: flex; justify-content: flex-end"><button class="btn-fantasma" data-fechar type="button">Fechar</button></div>`);

    modal.querySelectorAll('[data-modelo]').forEach(b =>
      b.addEventListener('click', async () => {
        if (b.disabled) return;
        b.disabled = true;
        b.style.opacity = '0.6';
        try {
          const r = await apiPagamentos('/comprar', { method: 'POST', body: {
            modelo_id: parseInt(b.dataset.modelo, 10),
          }});
          if (!r.url) throw new Error('Não foi possível abrir o pagamento.');
          window.location.href = r.url;
        } catch (err) {
          toast(err.message, true);
          b.disabled = false;
          b.style.opacity = '1';
        }
      }));
  }

  // ─── Loja (carrinho) ─────────────────────────────────────────────

  function modalLoja() {
    const produtos = dados.produtos || [];
    if (!produtos.length) { toast('A loja está sem produtos no momento.', true); return; }
    const temEndereco = !!dados.cliente.endereco;
    const taxa = dados.petshop.taxa_entrega_centavos || 0;
    const gratisAcima = dados.petshop.entrega_gratis_acima_centavos;

    const modal = abrirModal(`
      <h3>Loja</h3>
      <div style="display: flex; flex-direction: column; gap: 10px; max-height: 46vh; overflow-y: auto">
        ${produtos.map(p => `
          <div style="display: flex; align-items: center; gap: 12px; padding: 12px 14px; background: var(--bg-inset); border: 1px solid var(--border); border-radius: 12px">
            ${p.tem_foto ? `<img src="/api/portal/${encodeURIComponent(token)}/produtos/${p.id}/foto?v=${esc(p.foto_versao || '')}"
                 alt="" decoding="async" width="56" height="56"
                 style="width: 56px; height: 56px; object-fit: cover; border-radius: 10px; border: 1px solid var(--border); flex-shrink: 0">` : ''}
            <div style="flex: 1; min-width: 0">
              <div style="font-size: 0.9rem; font-weight: 600">${esc(p.nome)}</div>
              <div style="font-size: 0.76rem; color: var(--text-muted)">
                ${formatarReais(p.preco_centavos)}${p.controla_estoque ? ` · ${p.estoque} disponível(is)` : ''}
              </div>
              ${p.descricao ? `<div style="font-size: 0.74rem; color: var(--text-subtle)">${esc(p.descricao)}</div>` : ''}
            </div>
            <div style="display: flex; align-items: center; gap: 8px">
              <button type="button" class="btn-fantasma" data-menos="${p.id}"
                style="min-width: 44px; min-height: 44px; padding: 0">−</button>
              <span data-qtd="${p.id}" style="min-width: 20px; text-align: center; font-variant-numeric: tabular-nums; font-weight: 600">0</span>
              <button type="button" class="btn-fantasma" data-mais="${p.id}"
                style="min-width: 44px; min-height: 44px; padding: 0">+</button>
            </div>
          </div>`).join('')}
      </div>

      <div style="display: flex; flex-direction: column; gap: 10px; border-top: 1px solid var(--border); padding-top: 14px">
        <label style="display: flex; align-items: center; gap: 10px; font-size: 0.9rem; cursor: pointer">
          <input type="checkbox" id="quero-entrega" ${temEndereco ? '' : 'disabled'} style="width: 18px; height: 18px; accent-color: var(--primary)">
          Receber em casa${taxa ? ` (${formatarReais(taxa)}${gratisAcima ? `, grátis acima de ${formatarReais(gratisAcima)}` : ''})` : ' (sem taxa)'}
        </label>
        ${temEndereco ? '' : '<div style="font-size: 0.78rem; color: var(--danger)">Cadastre o endereço em "Meus dados" para receber em casa.</div>'}
        <div id="resumo-carrinho" style="font-size: 0.9rem; font-weight: 600">Total: R$ 0,00</div>
        <div style="display: flex; gap: 10px; justify-content: flex-end">
          <button type="button" class="btn-fantasma" data-fechar>Fechar</button>
          <button type="button" class="btn-primario" id="botao-fechar-pedido" disabled>Ir para o pagamento</button>
        </div>
      </div>`);

    carrinho.clear();
    const resumo = modal.querySelector('#resumo-carrinho');
    const botaoPedido = modal.querySelector('#botao-fechar-pedido');
    const caixaEntrega = modal.querySelector('#quero-entrega');

    function subtotal() {
      let soma = 0;
      for (const [id, qtd] of carrinho) {
        const p = produtos.find(x => x.id === id);
        if (p) soma += p.preco_centavos * qtd;
      }
      return soma;
    }
    function atualizar() {
      const sub = subtotal();
      const gratis = gratisAcima !== null && gratisAcima !== undefined && sub >= gratisAcima;
      const frete = caixaEntrega.checked && !gratis ? taxa : 0;
      resumo.textContent = `Total: ${formatarReais(sub + frete)}` +
        (frete ? ` (produtos ${formatarReais(sub)} + entrega ${formatarReais(frete)})` : '') +
        (caixaEntrega.checked && gratis ? ' — entrega grátis' : '');
      botaoPedido.disabled = sub === 0;
    }

    modal.querySelectorAll('[data-mais]').forEach(b => b.addEventListener('click', () => {
      const id = parseInt(b.dataset.mais, 10);
      const p = produtos.find(x => x.id === id);
      const atual = carrinho.get(id) || 0;
      const limite = p.controla_estoque ? Math.min(p.estoque, 50) : 50;
      if (atual >= limite) { toast('Sem mais unidades disponíveis.', true); return; }
      carrinho.set(id, atual + 1);
      modal.querySelector(`[data-qtd="${id}"]`).textContent = String(atual + 1);
      atualizar();
    }));
    modal.querySelectorAll('[data-menos]').forEach(b => b.addEventListener('click', () => {
      const id = parseInt(b.dataset.menos, 10);
      const atual = carrinho.get(id) || 0;
      if (atual <= 0) return;
      if (atual === 1) carrinho.delete(id); else carrinho.set(id, atual - 1);
      modal.querySelector(`[data-qtd="${id}"]`).textContent = String(atual - 1);
      atualizar();
    }));
    caixaEntrega.addEventListener('change', atualizar);
    atualizar();

    botaoPedido.addEventListener('click', async () => {
      if (botaoPedido.disabled) return;
      botaoPedido.disabled = true;
      botaoPedido.textContent = 'Abrindo pagamento…';
      try {
        const r = await apiPagamentos('/pedido', { method: 'POST', body: {
          itens: [...carrinho.entries()].map(([produto_id, quantidade]) => ({ produto_id, quantidade })),
          entrega: caixaEntrega.checked ? 'ENTREGA' : 'RETIRADA',
        }});
        if (!r.url) throw new Error('Não foi possível abrir o pagamento.');
        window.location.href = r.url;
      } catch (err) {
        toast(err.message, true);
        botaoPedido.disabled = false;
        botaoPedido.textContent = 'Ir para o pagamento';
      }
    });
  }

  // ─── Pets e dados ────────────────────────────────────────────────

  function modalNovoPet() {
    const modal = abrirModal(`
      <h3>Adicionar pet</h3>
      <form id="form-pet" style="display: flex; flex-direction: column; gap: 14px">
        <div class="campo"><label>Nome</label><input name="nome" required></div>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px">
          <div class="campo"><label>Raça</label><input name="raca"></div>
          <div class="campo"><label>Porte</label>
            <select name="porte"><option value="">—</option><option>pequeno</option><option>médio</option><option>grande</option></select>
          </div>
        </div>
        <div style="display: flex; gap: 10px; justify-content: flex-end">
          <button type="button" class="btn-fantasma" data-fechar>Cancelar</button>
          <button type="submit" class="btn-primario">Adicionar</button>
        </div>
      </form>`);
    modal.querySelector('#form-pet').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const botao = ev.target.querySelector('[type="submit"]');
      if (botao.disabled) return;
      botao.disabled = true;
      const f = new FormData(ev.target);
      try {
        await api('/pets', { method: 'POST', body: {
          nome: f.get('nome'), raca: f.get('raca'), porte: f.get('porte'),
        }});
        fecharModal(); toast('Pet adicionado.'); await carregar();
      } catch (err) { toast(err.message, true); botao.disabled = false; }
    });
  }

  function modalMeusDados() {
    const c = dados.cliente;
    const modal = abrirModal(`
      <h3>Meus dados</h3>
      <form id="form-dados" style="display: flex; flex-direction: column; gap: 14px">
        <div class="campo"><label>Telefone / WhatsApp</label><input name="telefone" value="${esc(c.telefone || '')}"></div>
        <div class="campo"><label>E-mail</label><input name="email" type="email" value="${esc(c.email || '')}"></div>
        <div class="campo"><label>Endereço para busca em casa</label>
          <textarea name="endereco" rows="3" placeholder="Rua, número, bairro e ponto de referência">${esc(c.endereco || '')}</textarea>
        </div>
        <div style="display: flex; gap: 10px; justify-content: flex-end">
          <button type="button" class="btn-fantasma" data-fechar>Cancelar</button>
          <button type="submit" class="btn-primario">Salvar</button>
        </div>
      </form>`);
    modal.querySelector('#form-dados').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const botao = ev.target.querySelector('[type="submit"]');
      if (botao.disabled) return;
      botao.disabled = true;
      const f = new FormData(ev.target);
      try {
        await api('/dados', { method: 'PUT', body: {
          telefone: f.get('telefone'), email: f.get('email'), endereco: f.get('endereco'),
        }});
        fecharModal(); toast('Dados salvos.'); await carregar();
      } catch (err) { toast(err.message, true); botao.disabled = false; }
    });
  }

  // ─── Boot ────────────────────────────────────────────────────────

  async function carregar() {
    const [principal, adicionais] = await Promise.all([
      api(''),
      api('/extras').catch(() => ({ fotos: [], vacinas: [], a_avaliar: null })),
    ]);
    dados = principal;
    extras = adicionais;
    renderizar();
  }

  carregar().catch(err => {
    raiz.innerHTML = `<div class="vazio">${esc(err.message)}</div>`;
  });

  // Voltou do Mercado Pago: o cliente PRECISA saber o que aconteceu, mesmo
  // que o crédito demore. Mostra a situação e acompanha até resolver.
  const params = new URLSearchParams(window.location.search);
  const situacao = params.get('status') || params.get('collection_status');
  if (situacao || params.get('payment_id')) {
    if (situacao === 'failure' || situacao === 'rejected') {
      toast('O pagamento não foi aprovado. Nada foi cobrado — pode tentar de novo.', true);
      history.replaceState(null, '', window.location.pathname);
    } else {
      const aviso = document.createElement('div');
      aviso.className = 'cartao';
      aviso.style.cssText = 'padding: 16px 18px; margin-bottom: 4px; border-color: var(--primary-border)';
      aviso.innerHTML = '<div style="font-size: 0.9rem; font-weight: 600">Confirmando seu pagamento…</div>' +
        '<div style="font-size: 0.8rem; color: var(--text-muted); margin-top: 4px">Isso leva alguns segundos.</div>';
      raiz.prepend(aviso);

      let tentativas = 0;
      const antes = (dados && dados.pacotes || []).reduce((s, p) => s + p.saldo, 0);
      const pedidosAntes = (dados && dados.pedidos || []).length;
      const pagosAntes = (dados && dados.pedidos || [])
        .filter(p => p.status !== 'AGUARDANDO_PAGAMENTO').length;
      const timer = setInterval(async () => {
        tentativas += 1;
        try {
          await carregar();
          const depois = (dados.pacotes || []).reduce((s, p) => s + p.saldo, 0);
          const pedidosDepois = (dados.pedidos || []).length;
          // Só confirma se ALGO mudou desde antes de voltar do checkout —
          // um pedido antigo já pago não pode virar "pagamento confirmado".
          const pagosAgora = (dados.pedidos || []).filter(p => p.status !== 'AGUARDANDO_PAGAMENTO').length;
          if (depois > antes || pedidosDepois > pedidosAntes || pagosAgora > pagosAntes) {
            clearInterval(timer);
            toast('Pagamento confirmado!');
            history.replaceState(null, '', window.location.pathname);
            return;
          }
          // renderizar() recria a tela: reinsere o aviso.
          raiz.prepend(aviso);
        } catch (_e) { /* segue tentando */ }

        if (tentativas >= 6) {
          clearInterval(timer);
          aviso.innerHTML = '<div style="font-size: 0.9rem; font-weight: 600">Ainda confirmando o pagamento</div>' +
            '<div style="font-size: 0.8rem; color: var(--text-muted); margin-top: 4px">' +
            'Se você pagou, o crédito entra em instantes — atualize esta página em alguns minutos. ' +
            'Não pague de novo; se demorar, fale com o petshop.</div>';
          history.replaceState(null, '', window.location.pathname);
        }
      }, 5000);
    }
  }
})();
