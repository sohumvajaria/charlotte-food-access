(function initProvideMotion() {
  function initOffscreenMotionPause() {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const groups = document.querySelectorAll('[data-motion-group]');
    if (!groups.length) return;

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          entry.target.classList.toggle('motion-paused', !entry.isIntersecting);
        });
      },
      { rootMargin: '100px', threshold: 0 }
    );

    groups.forEach((el) => observer.observe(el));
  }

  function bindRafPointer(onMove) {
    let frameId = 0;
    let clientX = 0;
    let clientY = 0;

    return function handlePointer(event) {
      clientX = event.clientX;
      clientY = event.clientY;
      if (frameId) return;
      frameId = window.requestAnimationFrame(() => {
        frameId = 0;
        onMove(clientX, clientY);
      });
    };
  }

  window.ProvideMotion = {
    bindRafPointer,
    initOffscreenMotionPause,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initOffscreenMotionPause);
  } else {
    initOffscreenMotionPause();
  }
})();
