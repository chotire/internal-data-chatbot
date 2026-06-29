  const slides = Array.from(document.querySelectorAll('.slide'));
  const total = slides.length;
  let cur = 0;

  const progress = document.getElementById('progress');
  const counter = document.getElementById('counter');
  const prevBtn = document.getElementById('prev');
  const nextBtn = document.getElementById('next');
  const dotsWrap = document.getElementById('dots');

  // build dots
  slides.forEach((_, i) => {
    const d = document.createElement('button');
    d.className = 'd' + (i === 0 ? ' active' : '');
    d.setAttribute('aria-label', '슬라이드 ' + (i + 1));
    d.addEventListener('click', () => go(i));
    dotsWrap.appendChild(d);
  });
  const dots = Array.from(dotsWrap.children);

  function go(n) {
    cur = Math.max(0, Math.min(total - 1, n));
    slides.forEach((s, i) => s.classList.toggle('active', i === cur));
    dots.forEach((d, i) => d.classList.toggle('active', i === cur));
    progress.style.width = ((cur + 1) / total * 100) + '%';
    counter.textContent = (cur + 1) + ' / ' + total;
    prevBtn.disabled = cur === 0;
    nextBtn.disabled = cur === total - 1;
    location.hash = cur + 1;
  }

  prevBtn.addEventListener('click', () => go(cur - 1));
  nextBtn.addEventListener('click', () => go(cur + 1));

  document.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') { e.preventDefault(); go(cur + 1); }
    else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); go(cur - 1); }
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(total - 1);
    else if (e.key.toLowerCase() === 'f') {
      if (!document.fullscreenElement) document.documentElement.requestFullscreen();
      else document.exitFullscreen();
    }
  });

  // swipe (touch)
  let tx = 0;
  document.addEventListener('touchstart', e => tx = e.touches[0].clientX, {passive:true});
  document.addEventListener('touchend', e => {
    const dx = e.changedTouches[0].clientX - tx;
    if (Math.abs(dx) > 50) go(cur + (dx < 0 ? 1 : -1));
  }, {passive:true});

  // deep-link
  const start = parseInt(location.hash.replace('#',''), 10);
  go(Number.isFinite(start) && start >= 1 ? start - 1 : 0);
