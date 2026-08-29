'use strict';

// Vida da landing: reveal ao rolar, a barra de saldo enchendo e o número
// do saldo contando. O <head> marca <html class="js">; sem script, o CSS
// não esconde nada e a página inteira fica legível como estática.

(function () {
  const reduzido = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ─── Reveal ao entrar na viewport ────────────────────────────────
  const revelaveis = document.querySelectorAll('.revela');
  if (reduzido || !('IntersectionObserver' in window)) {
    revelaveis.forEach(el => el.classList.add('visto'));
  } else {
    const obs = new IntersectionObserver((entradas) => {
      for (const e of entradas) {
        if (e.isIntersecting) {
          e.target.classList.add('visto');
          obs.unobserve(e.target);
        }
      }
    }, { threshold: 0.18, rootMargin: '0px 0px -40px 0px' });
    revelaveis.forEach(el => obs.observe(el));
  }

  // ─── A cena do hero acorda: barra enche, saldo conta até 17 ──────
  function contarAte(el, alvo) {
    if (reduzido) { el.textContent = alvo; return; }
    el.textContent = '0';   // o markup nasce com o valor final (sem JS, fica)
    const inicio = performance.now();
    const duracao = 1100;
    function passo(agora) {
      const t = Math.min((agora - inicio) / duracao, 1);
      const suave = 1 - Math.pow(1 - t, 3);
      el.textContent = Math.round(alvo * suave);
      if (t < 1) requestAnimationFrame(passo);
    }
    requestAnimationFrame(passo);
  }

  function acordarCena(cena) {
    cena.classList.add('cena-viva');
    cena.querySelectorAll('[data-contador]').forEach(el => {
      contarAte(el, parseInt(el.dataset.contador, 10) || 0);
    });
  }

  const cenas = document.querySelectorAll('.hero-cena, .produto-demo, .fone-demo');
  if (reduzido || !('IntersectionObserver' in window)) {
    cenas.forEach(acordarCena);
  } else {
    const obsCena = new IntersectionObserver((entradas) => {
      for (const e of entradas) {
        if (e.isIntersecting) {
          acordarCena(e.target);
          obsCena.unobserve(e.target);
        }
      }
    }, { threshold: 0.35 });
    cenas.forEach(el => obsCena.observe(el));
  }
})();
