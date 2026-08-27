'use strict';

(function () {
  const raiz = document.getElementById('portal');
  const token = window.location.pathname.split('/').pop();

  const PATA = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="15.5" rx="4.2" ry="3.4"></ellipse><circle cx="6.2" cy="10.4" r="1.9"></circle><circle cx="10" cy="7.2" r="1.9"></circle><circle cx="14" cy="7.2" r="1.9"></circle><circle cx="17.8" cy="10.4" r="1.9"></circle></svg>';
  const FONE = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 2 .7 2.9a2 2 0 0 1-.5 2.1L8 10a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.5c.9.3 1.9.6 2.9.7a2 2 0 0 1 1.7 2z"></path></svg>';

  function esc(texto) {
    return String(texto === null || texto === undefined ? '' : texto)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function dataCurta(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
  }

  function dataLonga(iso) {
    if (!iso) return '';
    return new Date(`${String(iso).slice(0, 10)}T12:00:00`).toLocaleDateString('pt-BR');
  }

  function renderizar(dados) {
    const ativos = (dados.pacotes || []).filter(p => p.status === 'ATIVO');
    const pacote = ativos[0] || (dados.pacotes || [])[0] || null;
    const proximos = ativos.slice(1);
    const saldoProximos = proximos.reduce((soma, p) => soma + p.saldo, 0);
    const percentual = pacote && pacote.qtd_banhos
      ? Math.round((pacote.saldo / pacote.qtd_banhos) * 100) : 0;
    const acabando = pacote && (pacote.saldo + saldoProximos) <= 3;

    const petsNomes = (dados.pets || []).map(p => esc(p.nome)).join(' e ');
    const petsDetalhe = (dados.pets || [])
      .map(p => [p.raca, p.porte ? `porte ${p.porte}` : null].filter(Boolean).map(esc).join(' · '))
      .filter(Boolean)[0] || '';

    const numeroWhats = String(dados.petshop.whatsapp || '').replace(/\D/g, '');
    const linkWhats = numeroWhats
      ? `https://wa.me/${numeroWhats.length <= 11 ? '55' + numeroWhats : numeroWhats}?text=${encodeURIComponent('Olá! Quero agendar um banho.')}`
      : null;

    raiz.innerHTML = `
      <div style="display: flex; align-items: center; gap: 12px">
        <div class="marca-icone" style="width: 44px; height: 44px">${PATA}</div>
        <div>
          <div class="marca-nome" style="font-size: 1.35rem">${esc(dados.petshop.nome)}</div>
          <div class="marca-empresa">Olá, ${esc(dados.cliente.nome)}</div>
        </div>
      </div>

      ${pacote ? `
      <div class="cartao" style="padding: 22px; display: flex; flex-direction: column; gap: 14px">
        <div style="display: flex; justify-content: space-between; align-items: center">
          <div class="rotulo-secao">Seu saldo</div>
          <div class="chip ${pacote.status === 'ESGOTADO' ? 'alerta' : (acabando ? 'alerta' : 'ok')}">
            ${pacote.status === 'ESGOTADO' ? 'Esgotado' : (acabando ? 'Acabando' : 'Em dia')}
          </div>
        </div>
        <div style="display: flex; align-items: baseline; gap: 10px">
          <div class="portal-saldo">${pacote.saldo}</div>
          <div style="font-size: 0.95rem; color: var(--text-muted)">
            banho${pacote.saldo === 1 ? '' : 's'} restante${pacote.saldo === 1 ? '' : 's'}
          </div>
        </div>
        <div class="barra" style="height: 9px"><div class="${acabando ? 'baixa' : ''}" style="width: ${percentual}%"></div></div>
        <div style="display: flex; justify-content: space-between; font-size: 0.78rem; color: var(--text-subtle)">
          <span>${esc(pacote.nome)}</span>
          <span>${pacote.validade_ate ? 'válido até ' + dataLonga(pacote.validade_ate) : 'sem validade'}</span>
        </div>
        ${proximos.map(p => `
        <div style="display: flex; justify-content: space-between; font-size: 0.78rem; color: var(--text-muted); border-top: 1px solid var(--border); padding-top: 10px">
          <span>Próximo: ${esc(p.nome)}</span>
          <span>+${p.saldo} banho${p.saldo === 1 ? '' : 's'}</span>
        </div>`).join('')}
      </div>` : `
      <div class="vazio">Nenhum pacote ativo no momento.<br>Fale com o petshop para contratar.</div>`}

      ${petsNomes ? `
      <div class="cartao" style="padding: 16px 18px; display: flex; align-items: center; gap: 12px">
        <div style="flex: 1">
          <div class="rotulo-secao">Seus pets</div>
          <div style="font-size: 0.95rem; font-weight: 600; margin-top: 4px">${petsNomes}</div>
          ${petsDetalhe ? `<div style="font-size: 0.78rem; color: var(--text-muted); margin-top: 2px">${petsDetalhe}</div>` : ''}
        </div>
        <div style="color: var(--primary-ink)">${PATA}</div>
      </div>` : ''}

      ${(dados.ultimas_baixas || []).length ? `
      <div class="cartao" style="padding: 18px; display: flex; flex-direction: column; gap: 12px">
        <div class="rotulo-secao">Últimos banhos</div>
        <div class="lista" style="gap: 8px">
          ${dados.ultimas_baixas.map(b => `
            <div class="linha linha-inset" style="padding: 10px 14px">
              <div class="linha-data" style="font-size: 1rem; min-width: 52px">${dataCurta(b.registrado_em)}</div>
              <div style="flex: 1">
                <div class="linha-titulo" style="font-size: 0.86rem">${b.pet_nome ? esc(b.pet_nome) + ' · ' : ''}${esc(b.servico)}</div>
                <div class="linha-sub" style="font-size: 0.74rem">restavam ${b.saldo_apos}</div>
              </div>
            </div>`).join('')}
        </div>
      </div>` : ''}

      ${linkWhats ? `
      <a class="btn-primario" style="padding: 15px; font-size: 0.95rem; text-decoration: none" href="${linkWhats}">
        ${FONE} Agendar pelo WhatsApp
      </a>` : ''}

      <div style="font-size: 0.72rem; color: var(--text-subtle); text-align: center">Controle de pacotes por SaferPet</div>
    `;
  }

  fetch(`/api/portal/${encodeURIComponent(token)}`)
    .then(async (resp) => {
      const dados = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(dados.erro || 'Link inválido.');
      renderizar(dados);
    })
    .catch((err) => {
      raiz.innerHTML = `<div class="vazio">${esc(err.message)}</div>`;
    });
})();
