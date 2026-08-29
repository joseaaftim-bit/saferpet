'use strict';

(function () {
  const abaEntrar = document.getElementById('aba-entrar');
  const abaCriar = document.getElementById('aba-criar');
  const formEntrar = document.getElementById('form-entrar');
  const formCriar = document.getElementById('form-criar');
  const mensagem = document.getElementById('mensagem');

  if (localStorage.getItem('saferpet_token')) {
    window.location.href = '/app';
    return;
  }

  function mostrarAba(qual) {
    const entrar = qual === 'entrar';
    abaEntrar.classList.toggle('ativa', entrar);
    abaCriar.classList.toggle('ativa', !entrar);
    formEntrar.style.display = entrar ? 'flex' : 'none';
    formCriar.style.display = entrar ? 'none' : 'flex';
    mensagem.style.display = 'none';
  }
  abaEntrar.addEventListener('click', () => mostrarAba('entrar'));
  abaCriar.addEventListener('click', () => mostrarAba('criar'));

  // A landing manda direto para a aba certa: /entrar#criar
  if (window.location.hash === '#criar') mostrarAba('criar');

  function mostrarErro(texto) {
    mensagem.textContent = texto;
    mensagem.style.display = 'block';
  }

  async function enviar(url, corpo) {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(corpo),
    });
    const dados = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(dados.erro || 'Não foi possível completar. Tente novamente.');
    return dados;
  }

  formEntrar.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try {
      const dados = await enviar('/api/auth/login', {
        email: document.getElementById('login-email').value,
        senha: document.getElementById('login-senha').value,
      });
      localStorage.setItem('saferpet_token', dados.token);
      window.location.href = '/app';
    } catch (err) {
      mostrarErro(err.message);
    }
  });

  formCriar.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try {
      const dados = await enviar('/api/auth/registrar', {
        empresa_nome: document.getElementById('criar-empresa').value,
        whatsapp: document.getElementById('criar-whatsapp').value,
        nome: document.getElementById('criar-nome').value,
        email: document.getElementById('criar-email').value,
        senha: document.getElementById('criar-senha').value,
      });
      localStorage.setItem('saferpet_token', dados.token);
      window.location.href = '/app';
    } catch (err) {
      mostrarErro(err.message);
    }
  });
})();
