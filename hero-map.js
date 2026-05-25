// Interactive US map for the Provide hero section
let heroMapResizeTimer = null;

function initHeroMap() {
  const container = document.getElementById('hero-map');
  if (!container || typeof d3 === 'undefined' || typeof topojson === 'undefined') return;

  container.querySelectorAll('svg').forEach((el) => el.remove());
  const oldTip = container.querySelector('.hero-map-tooltip');
  if (oldTip) oldTip.remove();

  const width = container.clientWidth || 640;
  const height = container.clientHeight || 520;

  const svg = d3
    .select(container)
    .append('svg')
    .attr('viewBox', `0 0 ${width} ${height}`)
    .attr('preserveAspectRatio', 'xMidYMid meet')
    .attr('role', 'img')
    .attr('aria-label', 'Interactive map of the United States');

  const defs = svg.append('defs');
  const glow = defs
    .append('filter')
    .attr('id', 'state-glow')
    .attr('x', '-40%')
    .attr('y', '-40%')
    .attr('width', '180%')
    .attr('height', '180%');
  glow.append('feGaussianBlur').attr('stdDeviation', '4').attr('result', 'blur');
  const merge = glow.append('feMerge');
  merge.append('feMergeNode').attr('in', 'blur');
  merge.append('feMergeNode').attr('in', 'SourceGraphic');

  const orbitG = svg.append('g').attr('class', 'hero-orbits');
  const mapG = svg.append('g').attr('class', 'hero-states');
  const dotsG = svg.append('g').attr('class', 'hero-dots');

  const projection = d3.geoAlbersUsa().translate([width / 2, height / 2]).scale(1);
  const path = d3.geoPath().projection(projection);

  const tooltip = document.createElement('div');
  tooltip.className = 'hero-map-tooltip hidden';
  tooltip.setAttribute('role', 'status');
  container.appendChild(tooltip);

  function showTooltip(name, event) {
    tooltip.textContent = name;
    tooltip.classList.remove('hidden');
    const rect = container.getBoundingClientRect();
    tooltip.style.left = `${event.clientX - rect.left + 14}px`;
    tooltip.style.top = `${event.clientY - rect.top - 36}px`;
  }

  function hideTooltip() {
    tooltip.classList.add('hidden');
  }

  function drawOrbits(cx, cy, rx, ry) {
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
  }

  function scatterDots(features, cx, cy) {
    const points = [];
    features.forEach((f) => {
      const c = path.centroid(f);
      if (!Number.isFinite(c[0])) return;
      const n = f.id === '06' || f.id === '48' ? 18 : 10;
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
  }

  function render(us) {
    const states = topojson.feature(us, us.objects.states).features;

    projection.fitExtent(
      [[width * 0.06, height * 0.1], [width * 0.94, height * 0.9]],
      { type: 'FeatureCollection', features: states }
    );

    const bounds = path.bounds({ type: 'FeatureCollection', features: states });
    const cx = (bounds[0][0] + bounds[1][0]) / 2;
    const cy = (bounds[0][1] + bounds[1][1]) / 2;
    const rx = (bounds[1][0] - bounds[0][0]) / 2 + 24;
    const ry = (bounds[1][1] - bounds[0][1]) / 2 + 18;

    drawOrbits(cx, cy, rx, ry);
    scatterDots(states, cx, cy);

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

  d3.json('https://cdn.jsdelivr.net/npm/us-atlas@3/states-10m.json')
    .then(render)
    .catch(() => {
      container.innerHTML =
        '<p class="hero-map-fallback">Map unavailable — <a href="explorer.html">open the explorer</a> to find food resources.</p>';
    });
}

function scrollToExplorer() {
  window.location.href = 'explorer.html';
}

initHeroMap();

window.addEventListener('resize', () => {
  clearTimeout(heroMapResizeTimer);
  heroMapResizeTimer = setTimeout(initHeroMap, 220);
});
