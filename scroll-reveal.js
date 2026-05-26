const REVEAL_THRESHOLD = 0.12;

function revealElement(el) {
  el.classList.add('is-revealed');
}

function initScrollReveal() {
  const revealEls = document.querySelectorAll('[data-reveal]');
  if (!revealEls.length) return;

  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (prefersReducedMotion) {
    revealEls.forEach(revealElement);
    return;
  }

  if (typeof IntersectionObserver === 'undefined') {
    revealEls.forEach(revealElement);
    return;
  }

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        revealElement(entry.target);
        observer.unobserve(entry.target);
      });
    },
    { threshold: REVEAL_THRESHOLD, rootMargin: '0px 0px -24px 0px' }
  );

  revealEls.forEach((el) => observer.observe(el));
}

initScrollReveal();
