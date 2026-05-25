// Interactive US map for the Provide hero section
const US_ATLAS_URL = 'https://cdn.jsdelivr.net/npm/us-atlas@3/states-10m.json';

let heroMapResizeTimer = null;
let usTopologyCache = null;

function scrollToExplorer() {
  window.location.href = 'explorer.html';
}

function buildHeroMap(container, us) {
  container.querySelectorAll('svg').forEach((el) => el.remove());

  let tooltip = container.querySelector('.hero-map-tooltip');
  if (!tooltip) {
    tooltip = document.createElement('div');
    tooltip.className = 'hero-map-tooltip hidden';
    tooltip.setAttribute('role', 'status');
    container.appendChild(tooltip);
  }

  const width = container.clientWidth || 640;
  const height = container.clientHeight || 520;
  let pendingTooltip = null;

  const positionTooltip = window.ProvideMotion
    ? window.ProvideMotion.bindRafPointer((clientX, clientY) => {
        if (!pendingTooltip) return;
        const rect = container.getBoundingClientRect();
        tooltip.style.left = `${clientX - rect.left + 14}px`;
        tooltip.style.top = `${clientY - rect.top - 36}px`;
      })
    : null;

  function showTooltip(name, event) {
    tooltip.textContent = name;
    tooltip.classList.remove('hidden');
    pendingTooltip = name;
    if (positionTooltip) {
      positionTooltip(event);
      return;
    }
    const rect = container.getBoundingClientRect();
    tooltip.style.left = `${event.clientX - rect.left + 14}px`;
    tooltip.style.top = `${event.clientY - rect.top - 36}px`;
  }

  function hideTooltip() {
    pendingTooltip = null;
    tooltip.classList.add('hidden');
  }

  const svg = d3
    .select(container)
    .append('svg')
    .attr('viewBox', `0 0 ${width} ${height}`)
    .attr('preserveAspectRatio', 'xMidYMid meet')
    .attr('role', 'img')
    .attr('aria-label', 'Interactive map of the United States');

  const orbitG = svg.append('g').attr('class', 'hero-orbits');
  const mapG = svg.append('g').attr('class', 'hero-states');
  const dotsG = svg.append('g').attr('class', 'hero-dots');

  const projection = d3.geoAlbersUsa().translate([width / 2, height / 2]).scale(1);
  const path = d3.geoPath().projection(projection);
  const states = topojson.feature(us, us.objects.states).features;

  projection.fitExtent(
    [[width * 0.06, height * 0.1], [width * 0.94, height * 0.9]],
    { type: 'FeatureCollection', features: states }
  );

  const bounds = path.bounds({ type: 'FeatureCollection', features: states });
  const cx = (bounds[0][0] + bounds[1][0]) / 2;
  const cy = (bounds[0][1] + bounds[1][1]) / 2;
  const rx = (bounds[1][0] - bounds[0][0]) / 2 + 24;
  const ry = (bounds[1][1] - bounds[1][1]) / 2 + 18;

  const orbits = [
    { rx: rx * 1.05, ry: ry * 1.12, dash: '6 10', opacity: 0.35 },
    { rx: rx * 1.22, ry: ry * 1.28, dash: '4 14', opacity: 0.22 },
    { rx: rx * 0.88, ry: ry * 0.92, dash: '2 8', opacity: 0.18 },
  ];

  orbitG
    .selectAll('ellipse')
    .data(orbits)
    .join('ellipse')
    .attr('cx', cx)
    .attr('cy', cy)
    .attr('rx', (d) => d.rx)
    .attr('ry', (d) => d.ry)
    .attr('fill', 'none')
    .attr('stroke', 'var(--leaf)')
    .attr('stroke-width', 1)
    .attr('stroke-dasharray', (d) => d.dash)
    .attr('opacity', (d) => d.opacity);

  const points = [];
  states.forEach((f) => {
    const c = path.centroid(f);
    if (!Number.isFinite(c[0])) return;
    const n = f.id === '06' || f.id === '48' ? 10 : 6;
    for (let i = 0; i < n; i++) {
      const angle = Math.random() * Math.PI * 2;
      const dist = Math.random() * 28 + 4;
      points.push({
        x: c[0] + Math.cos(angle) * dist,
        y: c[1] + Math.sin(angle) * dist,
        delay: Math.random() * 4,
      });
    }
  });
  points.push({ x: cx, y: cy, delay: 0, isCore: true });

  dotsG
    .selectAll('circle')
    .data(points)
    .join('circle')
    .attr('cx', (d) => d.x)
    .attr('cy', (d) => d.y)
    .attr('r', (d) => (d.isCore ? 3.5 : 1.2 + Math.random() * 0.8))
    .attr('class', (d) => (d.isCore ? 'hero-dot-core' : 'hero-dot'))
    .style('animation-delay', (d) => `${d.delay}s`);

  mapG
    .selectAll('path')
    .data(states)
    .join('path')
    .attr('d', path)
    .attr('class', 'hero-state')
    .attr('tabindex', '0')
    .attr('data-name', (d) => d.properties.name)
    .on('mouseenter', function (event, d) {
      d3.select(this).classed('is-hovered', true);
      showTooltip(d.properties.name, event);
    })
    .on('mousemove', (event, d) => showTooltip(d.properties.name, event))
    .on('mouseleave', function () {
      d3.select(this).classed('is-hovered', false);
      hideTooltip();
    })
    .on('focus', function (event, d) {
      d3.select(this).classed('is-hovered', true);
      showTooltip(d.properties.name, event);
    })
    .on('blur', function () {
      d3.select(this).classed('is-hovered', false);
      hideTooltip();
    })
    .on('click', scrollToExplorer)
    .on('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        scrollToExplorer();
      }
    });
}

function initHeroMap() {
  const container = document.getElementById('hero-map');
  if (!container || typeof d3 === 'undefined' || typeof topojson === 'undefined') return;

  if (usTopologyCache) {
    buildHeroMap(container, usTopologyCache);
    return;
  }

  d3.json(US_ATLAS_URL)
    .then((us) => {
      usTopologyCache = us;
      buildHeroMap(container, us);
    })
    .catch(() => {
      container.innerHTML =
        '<p class="hero-map-fallback">Map unavailable — <a href="explorer.html">open the explorer</a> to find food resources.</p>';
    });
}

initHeroMap();

window.addEventListener('resize', () => {
  clearTimeout(heroMapResizeTimer);
  heroMapResizeTimer = setTimeout(initHeroMap, 280);
});
