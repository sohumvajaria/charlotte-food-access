// ─── Config ───────────────────────────────────────────────────
const CHARLOTTE_CENTER = [35.2271, -80.8431];

const colors = {
  snap: '#3B82F6',
  food_bank: '#F97316',
  free_meals_all_ages: '#EAB308',
  free_meals_under_18: '#EC4899',
  wic: '#A855F7',
};

const CATEGORY_LABELS = {
  snap: 'SNAP Retailer',
  food_bank: 'Food Pantry',
  free_meals_all_ages: 'Free Meals (all ages)',
  free_meals_under_18: 'Free Meals (under 18)',
  wic: 'WIC Location',
};

const FILTER_TYPE_MAP = {
  snap: 'snap',
  foodbank: 'food_bank',
  'meal-all': 'free_meals_all_ages',
  'meal-under18': 'free_meals_under_18',
  wic: 'wic',
};

const CARD_CLASS_MAP = {
  snap: 'snap',
  food_bank: 'foodbank',
  free_meals_all_ages: 'meal-all',
  free_meals_under_18: 'meal-under18',
  wic: 'wic',
};

const SCARCITY_TRACKER_LABEL = 'Food Scarcity Tracker';

// ─── State ────────────────────────────────────────────────────
let map;
let markersLayer = [];
let radiusCircle = null;
let selectedMiles = 2;
let allResources = [];
let searchCenter = null;
let searchGeneration = 0;
let foodDesertLayer = null;
let foodDesertData = null;
let transitLayer = null;
let transitStopLayer = null;
let transitStopFeatures = [];
let transitDataLoaded = false;
let transitLoadPromise = null;

// ─── Init Map ─────────────────────────────────────────────────
function initMap() {
  map = L.map('map', {
    center: CHARLOTTE_CENTER,
    zoom: 12,
    zoomControl: true,
  });

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors',
    maxZoom: 19,
  }).addTo(map);

  map.on('zoomend', updateTransitStopVisibility);
}

function getActiveCategories() {
  const active = [];
  document.querySelectorAll('.filter-cb').forEach((cb) => {
    if (cb.checked) {
      const key = FILTER_TYPE_MAP[cb.dataset.type];
      if (key) active.push(key);
    }
  });
  return active;
}

function getActiveCategoryHashIds() {
  const ids = [];
  document.querySelectorAll('.filter-cb').forEach((cb) => {
    if (cb.checked && cb.dataset.type) ids.push(cb.dataset.type);
  });
  return ids;
}

function applyCategoryFiltersFromHash(catParam) {
  const allowed = new Set(
    catParam
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean)
  );
  if (!allowed.size) return;

  document.querySelectorAll('.filter-cb').forEach((cb) => {
    if (!cb.dataset.type) return;
    cb.checked = allowed.has(cb.dataset.type);
  });
}

function setRadiusFromHash(radiusParam) {
  const miles = parseInt(radiusParam, 10);
  if (![2, 5, 10].includes(miles)) return;

  selectedMiles = miles;
  document.querySelectorAll('.radius-btn').forEach((btn) => {
    const btnMiles = parseInt(btn.dataset.miles, 10);
    btn.classList.toggle('active', btnMiles === miles);
  });
}

function updateShareableHash() {
  if (!searchCenter) return;

  const zip = document.getElementById('zip-input')?.value.trim();
  if (!/^\d{5}$/.test(zip)) return;

  const params = new URLSearchParams();
  params.set('zip', zip);
  params.set('r', String(selectedMiles));
  params.set('cat', getActiveCategoryHashIds().join(','));

  const hash = params.toString();
  if (window.location.hash.slice(1) === hash) return;

  const nextUrl = `${window.location.pathname}${window.location.search}#${hash}`;
  window.history.replaceState(null, '', nextUrl);
}

function setCopyLinkVisible(visible) {
  const utilityBtns = document.querySelector('.results-utility-btns');
  const copyBtn = document.getElementById('copy-link-btn');
  const printBtn = document.getElementById('print-btn');

  if (utilityBtns) utilityBtns.style.display = visible ? 'flex' : 'none';
  if (copyBtn) copyBtn.style.display = visible ? '' : 'none';
  if (printBtn) printBtn.style.display = visible ? '' : 'none';
}

function printResourceList() {
  if (!searchCenter) return;

  const zip = document.getElementById('zip-input')?.value.trim() || '';
  const today = new Date().toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  const header = document.createElement('div');
  header.id = 'print-header';
  header.innerHTML = `
    <h2>Food resources near ${escapeHtml(zip)} · within ${selectedMiles} miles</h2>
    <p>Found via Provide · provide-nc.org · ${escapeHtml(today)}</p>
    <p>For help finding food resources, call 2-1-1</p>
  `;
  document.body.prepend(header);

  window.addEventListener(
    'afterprint',
    () => {
      document.getElementById('print-header')?.remove();
    },
    { once: true }
  );

  window.print();
}

function restoreSearchFromHash() {
  const hash = window.location.hash.slice(1);
  if (!hash) return;

  const params = new URLSearchParams(hash);
  const zip = params.get('zip');
  if (!zip || !/^\d{5}$/.test(zip)) return;

  document.getElementById('zip-input').value = zip;

  const radius = params.get('r');
  if (radius) setRadiusFromHash(radius);

  const cats = params.get('cat');
  if (cats) applyCategoryFiltersFromHash(cats);

  doSearch();
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function getFoodDesertStyle(feature) {
  const val = feature.properties.lapop1share;

  if (val === null || val === undefined) {
    return { fillOpacity: 0, stroke: false, weight: 0 };
  }

  let fillColor;
  let fillOpacity;

  if (val >= 0.7) {
    fillColor = '#dc2626';
    fillOpacity = 0.65;
  } else if (val >= 0.5) {
    fillColor = '#ea580c';
    fillOpacity = 0.55;
  } else if (val >= 0.3) {
    fillColor = '#ca8a04';
    fillOpacity = 0.45;
  } else if (val >= 0.15) {
    fillColor = '#65a30d';
    fillOpacity = 0.25;
  } else {
    fillColor = '#16a34a';
    fillOpacity = 0.10;
  }

  return {
    fillColor,
    fillOpacity,
    color: fillColor,
    weight: 0.3,
    opacity: 0.4,
  };
}

function onEachTract(feature, layer) {
  const p = feature.properties;

  if (p.lapop1share === null || p.lapop1share === undefined) return;

  const pct = `${(p.lapop1share * 100).toFixed(0)}%`;
  const poverty =
    p.PovertyRate != null && p.PovertyRate !== undefined
      ? `${(p.PovertyRate * 100).toFixed(0)}%`
      : 'N/A';
  const income = p.MedianFamilyIncome
    ? `$${Number(p.MedianFamilyIncome).toLocaleString()}`
    : 'N/A';
  const desertLabel = p.isDesert
    ? '<span style="color:#dc2626; font-weight:600;">⚠️ USDA Food Desert</span>'
    : '<span style="color:#16a34a;">✓ Not classified as food desert</span>';
  const areaType = p.Urban === 1 ? 'Urban tract' : 'Rural tract';

  layer.bindTooltip(`
    <div style="
      font-family: sans-serif;
      font-size: 12px;
      min-width: 180px;
      line-height: 1.6;
    ">
      ${desertLabel}<br/>
      <span style="color:#999; font-size:11px;">${areaType}</span><br/>
      <hr style="border-color:#333; margin:4px 0;"/>
      <span style="color:#ccc;">Low access population:</span>
      <strong style="color:#fff;">${pct}</strong><br/>
      <span style="color:#ccc;">Poverty rate:</span>
      <strong style="color:#fff;">${poverty}</strong><br/>
      <span style="color:#ccc;">Median family income:</span>
      <strong style="color:#fff;">${income}</strong>
    </div>
  `, {
    sticky: true,
    opacity: 0.95,
    className: 'food-desert-tooltip',
  });
}

async function renderFoodDesertOverlay() {
  if (!foodDesertData) {
    try {
      const res = await fetch('data/nc-food-desert.geojson');
      if (!res.ok) throw new Error('Failed to load food desert data');
      foodDesertData = await res.json();
    } catch (err) {
      console.error('Food desert overlay error:', err);
      showFoodDesertError();
      return;
    }
  }

  foodDesertLayer = L.geoJSON(foodDesertData, {
    style: getFoodDesertStyle,
    onEachFeature: onEachTract,
  });

  foodDesertLayer.addTo(map);
  foodDesertLayer.bringToBack();
}

function removeFoodDesertOverlay() {
  if (foodDesertLayer) {
    map.removeLayer(foodDesertLayer);
    foodDesertLayer = null;
  }
}

function shouldShowTransitOverlayUi(options) {
  if (options && options.silent) return false;
  return Boolean(document.getElementById('transit-toggle')?.checked);
}

function hasActiveSearchResults() {
  return allResources.length > 0;
}

async function loadTransitOverlay(options = {}) {
  if (transitDataLoaded) return;
  if (!transitLoadPromise) {
    transitLoadPromise = loadTransitOverlayWork(options).finally(() => {
      transitLoadPromise = null;
    });
  }
  return transitLoadPromise;
}

async function loadTransitOverlayWork(options = {}) {
  const showUi = shouldShowTransitOverlayUi(options);
  const loadingEl = document.getElementById('transit-loading');
  const errorEl = document.getElementById('transit-error');

  if (showUi && loadingEl) loadingEl.style.display = 'inline';
  if (showUi && errorEl) errorEl.style.display = 'none';

  const geojson = await window.ProvideDataSources.loadTransitData();

  const toggleChecked = Boolean(document.getElementById('transit-toggle')?.checked);
  if (loadingEl) loadingEl.style.display = 'none';

  if (!geojson) {
    if (toggleChecked && errorEl) errorEl.style.display = 'inline';
    return;
  }

  transitDataLoaded = true;

  const routeFeatures = geojson.features.filter((f) => f.properties.layer === 'route');
  const stopFeatures = geojson.features.filter((f) => f.properties.layer === 'stop');
  transitStopFeatures = stopFeatures;

  transitLayer = L.layerGroup();
  routeFeatures.forEach((feature) => {
    const color = feature.properties.color || '#6B7280';
    const latlngs = feature.geometry.coordinates.map(([lng, lat]) => [lat, lng]);
    const line = L.polyline(latlngs, { color, weight: 2.5, opacity: 0.75 });
    const routeName = escapeHtml(
      `${feature.properties.route_short_name || ''} ${feature.properties.route_long_name || ''}`.trim()
    );
    const agencyName = escapeHtml(feature.properties.agency_name || '');
    line.bindPopup(
      `<strong>${routeName}</strong><br>` +
      `<span style="color:#666;font-size:12px">${agencyName}</span>`
    );
    transitLayer.addLayer(line);
  });

  transitStopLayer = L.layerGroup();
  stopFeatures.forEach((feature) => {
    const [lng, lat] = feature.geometry.coordinates;
    const marker = L.circleMarker([lat, lng], {
      radius: 4,
      fillColor: '#ffffff',
      fillOpacity: 1,
      color: '#555555',
      weight: 1.5,
    });
    marker.bindPopup(
      `<strong>${escapeHtml(feature.properties.stop_name)}</strong><br>` +
      '<span style="color:#666;font-size:12px">Bus stop</span>'
    );
    transitStopLayer.addLayer(marker);
  });

  if (document.getElementById('transit-toggle')?.checked) {
    transitLayer.addTo(map);
  }
  updateTransitStopVisibility();

  if (hasActiveSearchResults()) {
    renderAll();
  }
}

function updateTransitStopVisibility() {
  if (!transitDataLoaded || !transitStopLayer) return;
  const zoom = map.getZoom();
  const toggleOn = document.getElementById('transit-toggle')?.checked;
  if (toggleOn && zoom >= 13) {
    if (!map.hasLayer(transitStopLayer)) transitStopLayer.addTo(map);
  } else if (map.hasLayer(transitStopLayer)) {
    map.removeLayer(transitStopLayer);
  }
}

function appendTransitPopupBlock(popupHtml, lat, lng) {
  const nearestStop = window.ProvideDataSources.getNearestStop(
    lat,
    lng,
    transitStopFeatures
  );
  if (!nearestStop) return popupHtml;

  return `${popupHtml}
      <div class="popup-transit">
        🚌 <strong>${escapeHtml(nearestStop.stop_name)}</strong>
        &mdash; ${nearestStop.distance_mi} mi &middot; ~${nearestStop.walk_min} min walk
      </div>`;
}

function showFoodDesertError() {
  const toggle = document.getElementById('food-desert-toggle');
  if (toggle) {
    toggle.checked = false;
    const label = toggle.parentElement.querySelector('.food-desert-label');
    if (label) {
      label.textContent = `${SCARCITY_TRACKER_LABEL} (unavailable)`;
    }
  }
  const legend = document.getElementById('food-desert-legend');
  if (legend) {
    legend.classList.add('hidden');
    legend.hidden = true;
  }
}

function buildWicPopupHtml(resource) {
  const name = escapeHtml(resource.name);
  const address = escapeHtml(resource.address);
  const phone = resource.phone ? escapeHtml(resource.phone) : '';
  const telHref = resource.phone
    ? `tel:${String(resource.phone).replace(/[^\d+]/g, '')}`
    : '';

  let popupHtml = `
    <div style="font-family: sans-serif; min-width: 180px;">
      <strong style="font-size: 13px;">${name}</strong><br/>
      <span style="font-size: 12px; color: #666;">${address}</span><br/><br/>

      <div style="
        background: #fef3c7;
        border: 1px solid #f59e0b;
        border-radius: 4px;
        padding: 5px 8px;
        font-size: 11px;
        color: #92400e;
        margin-bottom: 8px;
      ">
        📞 <strong>Appointment required</strong><br/>
        Call before visiting · Walk-ins not accepted
      </div>

      ${phone ? `
      <a href="${telHref}" style="
        display: block;
        font-size: 12px;
        color: #a855f7;
        margin-bottom: 6px;
        text-decoration: none;
      ">📱 ${phone}</a>` : ''}

      <a href="https://www.google.com/maps/dir/?api=1&destination=${resource.lat},${resource.lng}"
         target="_blank"
         rel="noopener noreferrer"
         style="font-size: 12px; color: #a855f7; text-decoration: none;">
        Get Directions →
      </a>
    </div>
  `;

  return appendTransitPopupBlock(popupHtml, resource.lat, resource.lng);
}

function buildSnapStoreTypeBlock(resource) {
  const storeType = resource.storeType;
  if (!storeType) return '';

  const category = window.ProvideDataSources.getSnapStoreCategory(storeType);
  if (category === 'grocery') {
    return '<span class="store-type-badge store-type-grocery">🛒 Grocery Store</span>';
  }
  if (category === 'convenience') {
    return `
      <span class="store-type-badge store-type-convenience">⚠️ Convenience Store</span>
      <p class="store-type-warning">
        Limited grocery selection — may not carry fresh produce or staple foods.
        Consider calling ahead before traveling.
      </p>
    `;
  }
  return '';
}

function isSnapGroceryOnlyFilterActive() {
  const el = document.getElementById('snap-grocery-only');
  return Boolean(el && el.checked);
}

function resourcePassesMapFilters(resource, activeCategories) {
  if (!activeCategories.includes(resource.category)) return false;
  if (
    resource.category === 'snap' &&
    isSnapGroceryOnlyFilterActive() &&
    window.ProvideDataSources.getSnapStoreCategory(resource.storeType || '') !==
      'grocery'
  ) {
    return false;
  }
  return true;
}

function buildPopupHtml(resource) {
  if (resource.category === 'wic') {
    return buildWicPopupHtml(resource);
  }

  const name = escapeHtml(resource.name);
  const address = escapeHtml(resource.address);
  const snapStoreTypeBlock =
    resource.category === 'snap' ? buildSnapStoreTypeBlock(resource) : '';
  let popupHtml = `
    <div style="font-family: sans-serif; min-width: 160px;">
      <strong style="font-size: 13px;">${name}</strong><br/>
      ${snapStoreTypeBlock}
      <span style="font-size: 12px; color: #666;">${address}</span><br/><br/>
      <a href="https://www.google.com/maps/dir/?api=1&destination=${resource.lat},${resource.lng}"
         target="_blank"
         rel="noopener noreferrer"
         style="font-size: 12px; color: #22c55e; text-decoration: none;">
        Get Directions →
      </a>
    </div>
  `;

  return appendTransitPopupBlock(popupHtml, resource.lat, resource.lng);
}

// ─── Geocode ZIP ──────────────────────────────────────────────
async function geocodeZip(zip) {
  const res = await fetch(
    `https://nominatim.openstreetmap.org/search?postalcode=${zip}&country=US&format=json&limit=1`
  );
  const data = await res.json();
  if (!data.length) return null;
  const result = data[0];
  return { lat: parseFloat(result.lat), lng: parseFloat(result.lon) };
}

function clearMarkers() {
  markersLayer.forEach((marker) => map.removeLayer(marker));
  markersLayer = [];
}

function drawRadiusCircle(lat, lng, radiusMiles) {
  if (radiusCircle) {
    map.removeLayer(radiusCircle);
    radiusCircle = null;
  }
  radiusCircle = L.circle([lat, lng], {
    radius: radiusMiles * 1609.34,
    color: '#4ade80',
    fillOpacity: 0.05,
    weight: 1.5,
  }).addTo(map);
}

function renderMarkers(activeCategories) {
  clearMarkers();
  const visible = [];

  allResources.forEach((resource) => {
    if (!resourcePassesMapFilters(resource, activeCategories)) return;

    const marker = L.circleMarker([resource.lat, resource.lng], {
      radius: 8,
      fillColor: colors[resource.category],
      color: '#ffffff',
      weight: 2,
      opacity: 1,
      fillOpacity: 0.95,
    });

    marker.bindPopup(buildPopupHtml(resource));
    marker.addTo(map);
    markersLayer.push(marker);
    visible.push({ resource, marker });
  });

  if (foodDesertLayer) foodDesertLayer.bringToBack();

  return visible;
}

const LIMITED_FOOD_RESULTS_HTML = `
  <div style="
    background: #1a1a1a;
    border: 1px solid #333;
    border-radius: 6px;
    padding: 12px;
    font-size: 12px;
    color: #999;
    margin-top: 8px;
  ">
    <strong style="color: #fff;">Limited results in this area</strong><br/>
    Call <strong style="color: #22c55e;">2-1-1</strong> or visit
    <a href="https://nc211.org" target="_blank" rel="noopener noreferrer" style="color: #22c55e;">nc211.org</a>
    for additional local food resources.
  </div>
`;

function appendLimitedFoodResultsNotice() {
  const list = document.getElementById('results-list');
  if (!list) return;

  const foodPantryResults = allResources.filter((r) => r.category === 'food_bank');
  if (foodPantryResults.length > 0 || !searchCenter) return;

  if (list.querySelector('[data-limited-food-notice]')) return;

  const notice = document.createElement('div');
  notice.setAttribute('data-limited-food-notice', '');
  notice.innerHTML = LIMITED_FOOD_RESULTS_HTML;
  list.appendChild(notice);
}

function setSearchStatus(html) {
  const status = document.getElementById('search-status');
  if (!status) return;

  if (html) {
    status.innerHTML = html;
    status.hidden = false;
  } else {
    status.innerHTML = '';
    status.hidden = true;
  }
}

function showResultsMessage(html, options = {}) {
  const hideStats = options.hideStats !== false;
  const list = document.getElementById('results-list');
  const statsBar = document.getElementById('stats-bar');

  if (!list) {
    setSearchStatus(html);
    if (hideStats && statsBar) statsBar.classList.add('hidden');
    return;
  }

  const placeholder = document.getElementById('results-placeholder');
  placeholder.innerHTML = html;
  placeholder.style.display = 'block';
  list.innerHTML = '';
  list.appendChild(placeholder);
  document.getElementById('results-count').textContent = '—';
  if (hideStats && statsBar) statsBar.classList.add('hidden');
  appendLimitedFoodResultsNotice();
}

function renderResultsPanel(visibleEntries) {
  const list = document.getElementById('results-list');
  if (!list) {
    setSearchStatus('');
    return;
  }

  const placeholder = document.getElementById('results-placeholder');
  const visibleResources = visibleEntries.map((entry) => entry.resource);

  document.getElementById('results-count').textContent =
    `Showing ${visibleResources.length} locations`;

  if (!visibleResources.length) {
    const emptyMsg = allResources.length
      ? '<p>No resources match the selected filters.</p>'
      : '<p>No resources found in this area. Try increasing the radius.</p>';
    showResultsMessage(emptyMsg, { hideStats: allResources.length === 0 });
    return;
  }

  setSearchStatus('');
  placeholder.style.display = 'none';
  list.innerHTML = '';

  const fragment = document.createDocumentFragment();

  visibleEntries.forEach(({ resource, marker }) => {
    const cardClass = CARD_CLASS_MAP[resource.category] || 'foodbank';
    const card = document.createElement('div');
    card.className = `result-card ${cardClass}`;
    const badgeColor = colors[resource.category];
    card.innerHTML = `
      <div class="result-name">${escapeHtml(resource.name)}</div>
      <div class="result-address">${escapeHtml(resource.address)}</div>
      <div class="result-meta">
        <span class="result-badge" style="background: ${badgeColor}22; color: ${badgeColor};">
          ${escapeHtml(CATEGORY_LABELS[resource.category])}
        </span>
      </div>
    `;
    card.addEventListener('click', () => {
      map.setView([resource.lat, resource.lng], 15);
      marker.openPopup();
      document.querySelectorAll('.result-card.active').forEach((el) => el.classList.remove('active'));
      card.classList.add('active');
    });
    fragment.appendChild(card);
  });

  list.appendChild(fragment);
  appendLimitedFoodResultsNotice();
}

function countResourcesByCategory(resources) {
  const counts = {
    snap: 0,
    food_bank: 0,
    free_meals_all_ages: 0,
    free_meals_under_18: 0,
    wic: 0,
  };
  resources.forEach((r) => {
    if (counts[r.category] !== undefined) counts[r.category]++;
  });
  return counts;
}

function applyStatsCounts(counts) {
  document.querySelector('#stat-snap .stat-num').textContent = counts.snap;
  document.querySelector('#stat-foodbank .stat-num').textContent = counts.food_bank;
  document.querySelector('#stat-meal-all .stat-num').textContent =
    counts.free_meals_all_ages;
  document.querySelector('#stat-meal-under18 .stat-num').textContent =
    counts.free_meals_under_18;
  document.querySelector('#stat-wic .stat-num').textContent = counts.wic;
}

function updateStatsBar() {
  const activeCategories = getActiveCategories();
  const matching = allResources.filter((r) =>
    resourcePassesMapFilters(r, activeCategories)
  );
  applyStatsCounts(countResourcesByCategory(matching));

  const statsBar = document.getElementById('stats-bar');
  if (searchCenter && allResources.length > 0) {
    statsBar.classList.remove('hidden');
  }
}

function renderAll() {
  if (searchCenter && radiusCircle) {
    radiusCircle.addTo(map);
  }

  updateStatsBar();

  const activeCategories = getActiveCategories();
  const visibleEntries = renderMarkers(activeCategories);
  renderResultsPanel(visibleEntries);

  if (searchCenter) {
    updateShareableHash();
    setCopyLinkVisible(true);
  }
}

async function loadResourcesAt(lat, lng) {
  const generation = ++searchGeneration;

  setLoading(true);
  clearMarkers();
  allResources = [];
  applyStatsCounts(countResourcesByCategory([]));
  document.getElementById('detail-panel').classList.add('hidden');

  let resources = [];
  try {
    const result = await window.ProvideDataSources.fetchAllResources(
      lat,
      lng,
      selectedMiles
    );
    if (generation !== searchGeneration) return;
    resources = result.resources;
  } catch {
    if (generation !== searchGeneration) return;
    setLoading(false);
    showResultsMessage(
      '<p>Could not load map data. Please refresh and try again.</p>'
    );
    return;
  }

  if (generation !== searchGeneration) return;

  allResources = resources;
  setLoading(false);
  renderAll();
}

// ─── Search ───────────────────────────────────────────────────
async function doSearch() {
  const zip = document.getElementById('zip-input').value.trim();
  if (!/^\d{5}$/.test(zip)) {
    setCopyLinkVisible(false);
    showResultsMessage('<p>Enter a valid 5-digit ZIP code.</p>');
    return;
  }

  if (!window.ProvideDataSources) {
    showResultsMessage('<p>Data layer failed to load. Refresh the page.</p>');
    return;
  }

  let center;
  try {
    center = await geocodeZip(zip);
  } catch {
    center = null;
  }

  if (!center) {
    searchGeneration += 1;
    setLoading(false);
    setCopyLinkVisible(false);
    showResultsMessage('<p>ZIP code not found</p>');
    if (radiusCircle) {
      map.removeLayer(radiusCircle);
      radiusCircle = null;
    }
    searchCenter = null;
    allResources = [];
    applyStatsCounts(countResourcesByCategory([]));
    return;
  }

  searchCenter = center;
  const { lat, lng } = center;

  map.setView([lat, lng], 13);
  drawRadiusCircle(lat, lng, selectedMiles);
  map.invalidateSize();

  await loadResourcesAt(lat, lng);
}

// ─── Loading ──────────────────────────────────────────────────
function setLoading(on) {
  const btn = document.getElementById('search-btn');
  btn.disabled = on;
  btn.textContent = on ? 'Searching...' : 'Find';
  document.getElementById('loading-overlay').classList.toggle('hidden', !on);
  const loadingText = document.getElementById('loading-text');
  if (loadingText) {
    loadingText.textContent = on ? 'Searching...' : 'Finding resources...';
  }
}

// ─── Event Listeners ──────────────────────────────────────────
document.getElementById('search-btn').addEventListener('click', doSearch);
document.getElementById('zip-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') doSearch();
});

document.querySelectorAll('.radius-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.radius-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    selectedMiles = parseInt(btn.dataset.miles, 10);
    if (searchCenter) {
      drawRadiusCircle(searchCenter.lat, searchCenter.lng, selectedMiles);
      loadResourcesAt(searchCenter.lat, searchCenter.lng);
      return;
    }
    if (allResources.length) renderAll();
  });
});

document.querySelectorAll('.filter-cb').forEach((cb) => {
  cb.addEventListener('change', () => {
    if (searchCenter || allResources.length) renderAll();
  });
});

const snapGroceryOnlyCb = document.getElementById('snap-grocery-only');
if (snapGroceryOnlyCb) {
  snapGroceryOnlyCb.addEventListener('change', () => {
    if (searchCenter || allResources.length) renderAll();
  });
}

document.getElementById('detail-close').addEventListener('click', () => {
  document.getElementById('detail-panel').classList.add('hidden');
  document.querySelectorAll('.result-card.active').forEach((el) => el.classList.remove('active'));
});

const copyLinkBtn = document.getElementById('copy-link-btn');
if (copyLinkBtn) {
  copyLinkBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(window.location.href).then(() => {
      copyLinkBtn.textContent = 'Copied!';
      setTimeout(() => {
        copyLinkBtn.textContent = 'Copy link';
      }, 2000);
    });
  });
}

const printBtn = document.getElementById('print-btn');
if (printBtn) {
  printBtn.addEventListener('click', printResourceList);
}

const transitToggle = document.getElementById('transit-toggle');
if (transitToggle) {
  transitToggle.addEventListener('change', async function () {
    if (this.checked) {
      const loadingEl = document.getElementById('transit-loading');
      if (!transitDataLoaded && transitLoadPromise && loadingEl) {
        loadingEl.style.display = 'inline';
      }
      await loadTransitOverlay();
      if (transitLayer && transitDataLoaded) transitLayer.addTo(map);
      updateTransitStopVisibility();
    } else {
      const loadingEl = document.getElementById('transit-loading');
      const errorEl = document.getElementById('transit-error');
      if (loadingEl) loadingEl.style.display = 'none';
      if (errorEl) errorEl.style.display = 'none';
      if (transitLayer) map.removeLayer(transitLayer);
      if (transitStopLayer) map.removeLayer(transitStopLayer);
    }
  });
}

const foodDesertToggle = document.getElementById('food-desert-toggle');
if (foodDesertToggle) {
  foodDesertToggle.addEventListener('change', async (e) => {
    const legend = document.getElementById('food-desert-legend');
    const label = e.target.nextElementSibling;

    if (e.target.checked) {
      if (label) label.textContent = 'Loading...';
      await renderFoodDesertOverlay();
      if (e.target.checked) {
        if (label) label.textContent = SCARCITY_TRACKER_LABEL;
        if (legend) {
          legend.classList.remove('hidden');
          legend.hidden = false;
        }
      }
    } else {
      removeFoodDesertOverlay();
      if (legend) {
        legend.classList.add('hidden');
        legend.hidden = true;
      }
    }
  });
}

// ─── Boot ─────────────────────────────────────────────────────
initMap();
loadTransitOverlay({ silent: true });
restoreSearchFromHash();
