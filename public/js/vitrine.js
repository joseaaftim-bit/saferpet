'use strict';

// Vitrine pública do petshop: pet.safersoftware.com.br/salvapatas
// Quem chega aqui ainda não tem conta. A página mostra o que o petshop
// oferece e abre as duas portas: criar conta ou entrar.

(function () {
  const raiz = document.getElementById('vitrine');
  const slug = decodeURIComponent(window.location.pathname.replace(/^\//, '').split('/')[0]);
  const CHAVE_SESSAO = 'saferpet_conta';

  const PATA = '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="15.5" rx="4.2" ry="3.4"></ellipse><circle cx="6.2" cy="10.4" r="1.9"></circle><circle cx="10" cy="7.2" r="1.9"></circle><circle cx="14" cy="7.2" r="1.9"></circle><circle cx="17.8" cy="10.4" r="1.9"></circle></svg>';
  const RELOGIO = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="9"></circle><path d="M12 7v5l3 2"></path></svg>';

  function esc(texto) {
    return String(texto === null || texto === undefined ? '' : texto)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function reais(centavos) {
    return (Number(centavos || 0) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  }

  function duracao(minutos) {
    const m = Number(minutos || 0);
    if (!m) return '';
    if (m < 60) return m + ' min';
    const h = Math.floor(m / 60);
    const resto = m % 60;
    return resto ? h + 'h' + String(resto).padStart(2, '0') : h + 'h';
  }

  function toast(texto, ehErro) {
    const el = document.createElement('div');
    el.className = 'toast' + (ehErro ? ' erro' : '');
    el.textContent = texto;
    document.body.appendChild(el);
    setTimeout(function () { el.remove(); }, 4500);
  }

  async function api(caminho, opcoes) {
    const op = opcoes || {};
    const resp = await fetch('/api/vitrine/' + encodeURIComponent(slug) + caminho, {
      method: op.method || 'GET',
      headers: { 'Content-Type': 'application/json' },
      body: op.body ? JSON.stringify(op.body) : undefined,
    });
    const corpo = await resp.json().catch(function () { return {}; });
    return { ok: resp.ok, status: resp.status, corpo: corpo };
  }

  function entrarNaConta(resposta) {
    try {
      localStorage.setItem(CHAVE_SESSAO, resposta.token);
      localStorage.setItem(CHAVE_SESSAO + '_slug', slug);
    } catch (_e) {
      // Navegador com armazenamento bloqueado: avisa em vez de sumir.
      toast('Libere o armazenamento do navegador para manter a sessão.', true);
      return;
    }
    window.location.href = '/portal/conta';
  }

  // ─── Página ──────────────────────────────────────────────────────

  function pintar(dados) {
    const p = dados.petshop;
    const inicial = esc((p.nome || '?').trim().charAt(0).toUpperCase());
    const logo = p.tem_logo
      ? '<img class="vitrine-logo" src="/api/vitrine/' + encodeURIComponent(slug) +
        '/logo?v=' + esc(p.logo_versao || '') + '" alt="' + esc(p.nome) + '">'
      : '<div class="vitrine-logo vitrine-logo-vazia">' + inicial + '</div>';

    const zap = p.whatsapp
      ? '<a class="btn-fantasma" href="https://wa.me/55' + esc(String(p.whatsapp).replace(/\D/g, '')) +
        '" target="_blank" rel="noopener">Falar no WhatsApp</a>'
      : '';

    const secoes = [];

    if (dados.servicos.length) {
      secoes.push(
        '<section class="vitrine-secao"><h2>Serviços</h2><div class="lista">' +
        dados.servicos.map(function (s) {
          return '<div class="linha"><div style="flex:1">' +
            '<div class="linha-titulo">' + esc(s.nome) + '</div>' +
            (s.duracao_minutos
              ? '<div class="linha-sub" style="display:flex;align-items:center;gap:5px">' +
                RELOGIO + ' ' + esc(duracao(s.duracao_minutos)) + '</div>'
              : '') +
            '</div>' +
            (s.preco_centavos ? '<div class="vitrine-preco">' + esc(reais(s.preco_centavos)) + '</div>' : '') +
            '</div>';
        }).join('') +
        '</div></section>');
    }

    if (dados.pacotes.length) {
      secoes.push(
        '<section class="vitrine-secao"><h2>Pacotes</h2>' +
        '<p style="color:var(--text-muted);font-size:0.9rem;margin-top:-6px">' +
        'Compre uma vez e vá usando. O saldo fica guardado na sua conta.</p>' +
        dados.pacotes.map(function (m) {
          return '<div class="cartao vitrine-pacote">' +
            '<div class="vitrine-pacote-topo"><h3>' + esc(m.nome) + '</h3>' +
            '<div class="vitrine-preco">' + esc(reais(m.valor_centavos)) + '</div></div>' +
            (m.itens.length
              ? '<div class="vitrine-itens">' + m.itens.map(function (i) {
                  return '<span class="chip acento">' + esc(i.quantidade) + '&times; ' + esc(i.servico_nome) + '</span>';
                }).join('') + '</div>'
              : '') +
            (m.validade_meses
              ? '<div class="linha-sub">Válido por ' + esc(m.validade_meses) + ' ' +
                (m.validade_meses === 1 ? 'mês' : 'meses') + '</div>'
              : '') +
            '</div>';
        }).join('') +
        '</section>');
    }

    if (dados.produtos.length) {
      secoes.push(
        '<section class="vitrine-secao"><h2>Loja</h2><div class="vitrine-produtos">' +
        dados.produtos.map(function (pr) {
          return '<div class="cartao vitrine-produto">' +
            (pr.tem_foto
              ? '<img src="/api/vitrine/' + encodeURIComponent(slug) + '/produtos/' + pr.id +
                '/foto?v=' + esc(pr.foto_versao || '') + '" alt="' + esc(pr.nome) + '">'
              : '<div class="sem-foto">' + PATA + '</div>') +
            '<div class="vitrine-produto-nome">' + esc(pr.nome) + '</div>' +
            '<div class="vitrine-preco" style="font-size:1rem">' + esc(reais(pr.preco_centavos)) + '</div>' +
            '</div>';
        }).join('') +
        '</div></section>');
    }

    if (!secoes.length) {
      secoes.push('<div class="vazio">O ' + esc(p.nome) + ' ainda está montando a vitrine.<br>' +
        'Fale com eles pelo WhatsApp para agendar.</div>');
    }

    raiz.innerHTML =
      '<header class="vitrine-capa">' + logo +
      '<h1>' + esc(p.nome) + '</h1>' +
      '<p>Agende, acompanhe o saldo dos seus pacotes e compre sem sair de casa.</p>' +
      '<div class="vitrine-acoes">' +
      '<button class="btn-primario" id="btn-entrar">Entrar na minha conta</button>' +
      '<button class="btn-fantasma" id="btn-criar">Criar conta</button>' + zap +
      '</div></header>' +
      secoes.join('') +
      '<footer class="vitrine-rodape">' +
      '<a href="https://safersoftware.com.br" target="_blank" rel="noopener">Feito com SaferPet</a>' +
      '</footer>';

    document.getElementById('btn-entrar').onclick = function () { abrirFormulario('entrar'); };
    document.getElementById('btn-criar').onclick = function () { abrirFormulario('criar'); };
  }

  // ─── Entrar / criar conta ────────────────────────────────────────

  function abrirFormulario(modo, valoresIniciais) {
    const fundo = document.createElement('div');
    fundo.className = 'modal-fundo';

    function desenhar(modoAtual, valores) {
      const v0 = valores || {};
      const criando = modoAtual === 'criar';

      fundo.innerHTML =
        '<div class="modal" role="dialog" aria-modal="true">' +
        '<h3>' + (criando ? 'Criar minha conta' : 'Entrar') + '</h3>' +
        '<p style="color:var(--text-muted);font-size:0.88rem;margin-top:-8px">' +
        (criando
          ? 'É rápido: seu telefone e uma senha. Depois é só entrar por aqui sempre que quiser.'
          : 'Use o telefone que você cadastrou no petshop.') +
        '</p>' +
        (criando
          ? '<div class="campo"><label for="f-nome">Seu nome</label>' +
            '<input id="f-nome" autocomplete="name" value="' + esc(v0.nome || '') + '"></div>'
          : '') +
        '<div class="campo"><label for="f-telefone">Telefone com DDD</label>' +
        '<input id="f-telefone" inputmode="tel" autocomplete="tel" placeholder="(67) 99999-0000" value="' +
        esc(v0.telefone || '') + '"></div>' +
        (criando
          ? '<div class="campo"><label for="f-email">E-mail (opcional)</label>' +
            '<input id="f-email" type="email" autocomplete="email" value="' + esc(v0.email || '') + '"></div>'
          : '') +
        '<div class="campo"><label for="f-senha">Senha</label>' +
        '<input id="f-senha" type="password" autocomplete="' +
        (criando ? 'new-password' : 'current-password') + '" placeholder="' +
        (criando ? 'No mínimo 6 caracteres' : '') + '"></div>' +
        '<div class="erro-campo" id="f-erro" hidden></div>' +
        '<div style="display:flex;gap:10px;justify-content:space-between;align-items:center;flex-wrap:wrap">' +
        '<button class="link-texto" id="f-trocar">' +
        (criando ? 'Já tenho conta' : 'Ainda não tenho conta') + '</button>' +
        '<div style="display:flex;gap:10px">' +
        '<button class="btn-fantasma" id="f-fechar">Cancelar</button>' +
        '<button class="btn-primario" id="f-ok">' + (criando ? 'Criar conta' : 'Entrar') + '</button>' +
        '</div></div></div>';

      function campos() {
        const pega = function (id) {
          const el = document.getElementById(id);
          return el ? el.value : '';
        };
        return {
          nome: pega('f-nome'), telefone: pega('f-telefone'),
          email: pega('f-email'), senha: pega('f-senha'),
        };
      }

      function mostrarErro(texto) {
        const erro = document.getElementById('f-erro');
        erro.textContent = texto || '';
        erro.hidden = !texto;
      }

      document.getElementById('f-fechar').onclick = function () { fundo.remove(); };
      document.getElementById('f-trocar').onclick = function () {
        desenhar(criando ? 'entrar' : 'criar', campos());
      };

      const botao = document.getElementById('f-ok');

      async function enviar() {
        const v = campos();
        mostrarErro('');
        botao.disabled = true;
        try {
          const r = criando
            ? await api('/conta', { method: 'POST', body: v })
            : await api('/entrar', { method: 'POST', body: { telefone: v.telefone, senha: v.senha } });

          // O petshop já tem esse telefone no cadastro: fica pendente.
          if (r.status === 202 && r.corpo.pendente) {
            fundo.innerHTML =
              '<div class="modal" role="dialog" aria-modal="true">' +
              '<h3>Falta a confirmação do petshop</h3>' +
              '<div class="aviso-suave">' + esc(r.corpo.mensagem) + '</div>' +
              '<button class="btn-primario" id="f-ok2">Entendi</button></div>';
            document.getElementById('f-ok2').onclick = function () { fundo.remove(); };
            return;
          }
          if (r.corpo.ja_tem_conta) {
            desenhar('entrar', v);
            mostrarErro('Você já tem conta com este telefone. Entre com a sua senha.');
            return;
          }
          if (!r.ok) {
            mostrarErro(r.corpo.erro || 'Não deu certo. Tente de novo.');
            return;
          }
          entrarNaConta(r.corpo);
        } catch (_e) {
          mostrarErro('Sem conexão. Tente de novo.');
        } finally {
          botao.disabled = false;
        }
      }

      botao.onclick = enviar;
      Array.prototype.forEach.call(fundo.querySelectorAll('input'), function (el) {
        el.onkeydown = function (ev) { if (ev.key === 'Enter') enviar(); };
      });
      const primeiro = fundo.querySelector('input');
      if (primeiro) primeiro.focus();
    }

    fundo.onclick = function (ev) { if (ev.target === fundo) fundo.remove(); };
    document.body.appendChild(fundo);
    desenhar(modo, valoresIniciais);
  }

  // ─── Início ──────────────────────────────────────────────────────

  (async function iniciar() {
    // Já entrou antes neste aparelho: vai direto para o app.
    let sessao = null;
    try { sessao = localStorage.getItem(CHAVE_SESSAO); } catch (_e) { sessao = null; }
    if (sessao) {
      window.location.replace('/portal/conta');
      return;
    }

    const r = await api('').catch(function () { return { ok: false, corpo: {} }; });
    if (!r.ok) {
      raiz.innerHTML = '<div class="vazio" style="margin-top:60px">' +
        esc(r.corpo.erro || 'Não encontramos este petshop.') + '</div>';
      return;
    }
    document.title = r.corpo.petshop.nome + ' — agendamento e pacotes';
    pintar(r.corpo);
  })();
})();
