const STAT_COUNT_DURATION_MS = 3000;
const STAT_COUNT_STAGGER_MS = 100;

function easeInOutCubic(progress) {
  if (progress < 0.5) {
    return 4 * progress * progress * progress;
  }
  return 1 - Math.pow(-2 * progress + 2, 3) / 2;
}

function formatStatValue(value, decimals, isAnimating, useCommas) {
  const rounded = decimals > 0 ? value.toFixed(decimals) : String(Math.round(value));

  if (decimals > 0) {
    return value.toFixed(decimals);
  }
  if (isAnimating && value > 0 && value % 1 !== 0) {
    return value.toFixed(1);
  }
  if (useCommas) {
    return Math.round(value).toLocaleString('en-US');
  }
  return rounded;
}

function animateCounter(el, delayMs) {
  if (el.dataset.animated === 'true') return;
  el.dataset.animated = 'true';

  const end = parseFloat(el.dataset.value);
  const suffix = el.dataset.suffix || '';
  const prefix = el.dataset.prefix || '';
  const decimals = parseInt(el.dataset.decimals || '0', 10);
  const useCommas = el.dataset.commas === 'true';
  const startAt = performance.now() + delayMs;

  function tick(now) {
    const elapsed = now - startAt;

    if (elapsed < 0) {
      requestAnimationFrame(tick);
      return;
    }

    const progress = Math.min(elapsed / STAT_COUNT_DURATION_MS, 1);
    const eased = easeInOutCubic(progress);
    const current = end * eased;
    const isAnimating = progress < 1;

    el.textContent = `${prefix}${formatStatValue(current, decimals, isAnimating, useCommas)}${suffix}`;

    if (isAnimating) {
      requestAnimationFrame(tick);
      return;
    }

    el.textContent = `${prefix}${formatStatValue(end, decimals, false, useCommas)}${suffix}`;
  }

  requestAnimationFrame(tick);
}

function initStatSection(section) {
  const counters = section.querySelectorAll('.stat-counter');
  if (!counters.length) return;

  function runCounters() {
    counters.forEach((el, index) => {
      animateCounter(el, index * STAT_COUNT_STAGGER_MS);
    });
  }

  if (typeof IntersectionObserver === 'undefined') {
    runCounters();
    return;
  }

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        runCounters();
        observer.unobserve(entry.target);
      });
    },
    { threshold: 0.3 }
  );

  observer.observe(section);
}

function initStatCounters() {
  document.querySelectorAll('[data-stat-section]').forEach(initStatSection);
}

initStatCounters();
