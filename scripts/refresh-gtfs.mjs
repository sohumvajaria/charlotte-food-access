#!/usr/bin/env node
/**
 * Download NC GTFS feeds (Mobility Database), parse routes/stops, write simplified GeoJSON.
 * Usage: node scripts/refresh-gtfs.mjs
 * Offline: GTFS_ZIP_PATH=/path/a.zip,/path/b.zip node scripts/refresh-gtfs.mjs
 */
import {
  createReadStream,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { Readable } from 'node:stream';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { parse as parseSync } from 'csv-parse/sync';
import { parse as parseStream } from 'csv-parse';
import AdmZip from 'adm-zip';
import rewind from '@mapbox/geojson-rewind';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = join(ROOT, 'data');
const OUT_PATH = join(DATA_DIR, 'gtfs-nc-routes.geojson');

const MOBILITY_DB_CSV_URL = 'https://files.mobilitydatabase.org/feeds_v2.csv';
const NTD_GTFS_API_URL =
  "https://data.transportation.gov/resource/2u7n-ub22.json?$where=state='NC'&$limit=100";
const USER_AGENT =
  'ProvideNC-GTFSRefresher/1.0 (food-access-map; contact: [project email])';
const DOWNLOAD_TIMEOUT_MS = 30000;

const NC_GTFS_FALLBACK = [
  {
    provider: 'GoTriangle (Research Triangle)',
    mdb_id: 'fallback-gotriangle-trillium',
    url: 'http://data.trilliumtransit.com/gtfs/tta-regionalbus-nc-us/tta-regionalbus-nc-us.zip',
  },
  {
    provider: 'GoTriangle (TripSpark mirror)',
    mdb_id: 'fallback-gotriangle-tripspark',
    url: 'https://gotriangle.tripsparkhost.com/gtfs/Realtime/google_transit.zip',
  },
  {
    provider: 'CATS (Charlotte Area Transit System)',
    mdb_id: 'fallback-cats',
    url: 'https://charlottenc.gov/cats/google_transit.zip',
  },
];

const ROUTE_COLOR_PALETTE = [
  '#3B82F6',
  '#F97316',
  '#A855F7',
  '#10B981',
  '#EF4444',
  '#F59E0B',
  '#6366F1',
  '#EC4899',
];

const FEED_REQUIRED_FILES = [
  'agency.txt',
  'routes.txt',
  'trips.txt',
  'shapes.txt',
];

function findZipEntry(zip, filename) {
  const target = filename.toLowerCase();
  return zip
    .getEntries()
    .find(
      (entry) =>
        !entry.isDirectory &&
        entry.entryName.toLowerCase().split('/').pop() === target
    );
}

function parseTxtFromZip(zip, filename) {
  const entry = findZipEntry(zip, filename);
  if (!entry) return null;

  const text = entry.getData().toString('utf8');
  return parseSync(text, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
  });
}

function pickColumn(row, candidates) {
  const keys = Object.keys(row);
  for (const candidate of candidates) {
    const exact = keys.find((key) => key === candidate);
    if (exact && row[exact] !== undefined && String(row[exact]).trim() !== '') {
      return String(row[exact]).trim();
    }
    const insensitive = keys.find(
      (key) => key.toLowerCase() === candidate.toLowerCase()
    );
    if (
      insensitive &&
      row[insensitive] !== undefined &&
      String(row[insensitive]).trim() !== ''
    ) {
      return String(row[insensitive]).trim();
    }
  }
  return '';
}

function isInactiveStatus(status) {
  const normalized = String(status).toLowerCase().trim();
  return normalized === 'deprecated' || normalized === 'inactive';
}

function isGtfsScheduleRow(row) {
  const dataType = pickColumn(row, [
    'data_type',
    'dataType',
    'type',
    'feed_type',
  ]).toLowerCase();
  if (dataType === 'gtfs') return true;
  if (dataType.includes('gtfs') && !dataType.includes('rt')) return true;
  return false;
}

function isNorthCarolinaRow(row) {
  const subdivision = pickColumn(row, [
    'location.subdivision_name',
    'subdivision_name',
    'subdivision',
    'state',
    'region',
  ]);
  if (subdivision === 'North Carolina') return true;
  if (/^north carolina$/i.test(subdivision)) return true;
  if (subdivision === 'NC' || subdivision === 'N.C.') return true;
  return false;
}

function feedUrlFromRow(row) {
  const latest = pickColumn(row, [
    'urls.latest',
    'latest_url',
    'latestUrl',
    'latest',
  ]);
  if (latest) return latest;
  return pickColumn(row, [
    'urls.direct_download',
    'direct_download_url',
    'directDownloadUrl',
    'url',
    'download_url',
  ]);
}

function rowToFeedDescriptor(row) {
  const url = feedUrlFromRow(row);
  if (!url) return null;

  const provider =
    pickColumn(row, [
      'provider',
      'name',
      'provider_name',
      'agency_name',
      'source_name',
    ]) || 'Unknown provider';
  const mdbId =
    pickColumn(row, [
      'id',
      'mdb_source_id',
      'mdb_id',
      'source_id',
      'feed_id',
    ]) || url;

  return { provider, mdb_id: mdbId, url };
}

async function streamMobilityDatabaseNcFeeds() {
  const res = await fetch(MOBILITY_DB_CSV_URL, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Mobility Database CSV failed: HTTP ${res.status}`);
  }
  if (!res.body) throw new Error('Mobility Database CSV: no response body');

  const feeds = [];
  let headersLogged = false;

  await new Promise((resolve, reject) => {
    const parser = parseStream({
      columns: true,
      skip_empty_lines: true,
      trim: true,
      relax_column_count: true,
    });

    parser.on('readable', () => {
      let row = parser.read();
      while (row !== null) {
        if (!headersLogged) {
          console.log(`Mobility Database CSV columns: ${Object.keys(row).join(', ')}`);
          headersLogged = true;
        }

        const status = pickColumn(row, ['status', 'feed_status']);
        if (status && isInactiveStatus(status)) {
          row = parser.read();
          continue;
        }
        if (!isGtfsScheduleRow(row) || !isNorthCarolinaRow(row)) {
          row = parser.read();
          continue;
        }

        const descriptor = rowToFeedDescriptor(row);
        if (descriptor) feeds.push(descriptor);

        row = parser.read();
      }
    });

    parser.on('error', reject);
    parser.on('end', resolve);

    const bodyStream =
      typeof res.body.pipe === 'function'
        ? res.body
        : Readable.fromWeb(res.body);
    bodyStream.pipe(parser);
  });

  return feeds;
}

function resolveLocalFeedSources() {
  const raw = process.env.GTFS_ZIP_PATH;
  if (!raw) return null;

  return raw
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((localPath, index) => ({
      provider: `local: ${localPath}`,
      mdb_id: `local-${index}`,
      url: null,
      localPath,
    }));
}

async function discoverNcFeeds() {
  try {
    const feeds = await streamMobilityDatabaseNcFeeds();
    if (feeds.length) {
      return feeds.map((feed) => ({ ...feed, source: 'mobilitydb' }));
    }
    console.warn('⚠️  Mobility Database CSV returned no matching NC GTFS feeds');
  } catch (err) {
    console.warn(
      `⚠️  Mobility Database CSV unavailable — using hardcoded seed list (${err.message})`
    );
  }

  return NC_GTFS_FALLBACK.map((feed) => ({ ...feed, source: 'mobilitydb' }));
}

function normalizeFeedUrl(url) {
  return String(url || '')
    .trim()
    .toLowerCase()
    .replace(/\/+$/, '');
}

function buildQueuedUrlSet(feeds) {
  const urls = new Set();
  for (const feed of feeds) {
    if (feed.url) urls.add(normalizeFeedUrl(feed.url));
  }
  return urls;
}

function pickNtdGtfsUrl(record) {
  const flat = pickColumn(record, [
    'gtfs_static_url',
    'gtfs_url',
    'static_url',
    'url',
    'download_url',
  ]);
  if (flat) return flat;

  const weblink = record.weblink;
  if (weblink && typeof weblink === 'object' && weblink.url) {
    return String(weblink.url).trim();
  }

  return '';
}

async function fetchNtdNcRecords() {
  const res = await fetch(NTD_GTFS_API_URL, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }

  const records = await res.json();
  if (!Array.isArray(records)) {
    throw new Error('Unexpected NTD response (not a JSON array)');
  }

  if (records.length > 0) {
    console.log(`NTD API record keys (first row): ${Object.keys(records[0]).join(', ')}`);
  }

  return records;
}

async function appendNtdFeeds(feeds) {
  let records;
  try {
    records = await fetchNtdNcRecords();
  } catch {
    console.warn('⚠️  NTD API unavailable — skipping supplemental feeds');
    return feeds;
  }

  const queuedUrls = buildQueuedUrlSet(feeds);
  const seenAgencyKeys = new Set();
  const added = [];

  for (const record of records) {
    const stateCode = pickColumn(record, ['state', 'state_code', 'state_abbreviation']);
    if (stateCode && stateCode.toUpperCase() !== 'NC') continue;

    const url = pickNtdGtfsUrl(record);
    if (!url) continue;

    const normalizedUrl = normalizeFeedUrl(url);
    if (queuedUrls.has(normalizedUrl)) continue;

    const ntdId = pickColumn(record, ['ntd_id', 'ntdId', 'ntdid', 'id']);
    const agencyName =
      pickColumn(record, ['agency_name', 'agency', 'transit_agency', 'name']) ||
      'Unknown NTD agency';

    const agencyKey = (ntdId || agencyName).toLowerCase();
    if (seenAgencyKeys.has(agencyKey)) continue;
    seenAgencyKeys.add(agencyKey);

    queuedUrls.add(normalizedUrl);
    added.push({
      provider: agencyName,
      mdb_id: ntdId ? `ntd-${ntdId}` : `ntd-${added.length}`,
      url,
      source: 'ntd',
      ntd_id: ntdId || '',
    });
  }

  if (added.length) {
    console.log(
      `📋 NTD added ${added.length} additional NC feeds not in Mobility Database:`
    );
    for (const feed of added) {
      const idLabel = feed.ntd_id || feed.mdb_id.replace(/^ntd-/, '');
      console.log(`  • ${feed.provider} (${idLabel})`);
    }
    return [...feeds, ...added];
  }

  console.log('📋 NTD: no additional feeds beyond Mobility Database');
  return feeds;
}

async function downloadFeedZip(url, provider) {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    redirect: 'follow',
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

function formatRouteColor(color, fallbackColor) {
  if (!color || !String(color).trim()) return fallbackColor;
  const trimmed = String(color).trim();
  return trimmed.startsWith('#') ? trimmed : `#${trimmed}`;
}

function parseAgencies(rows) {
  const agencies = new Map();
  if (!rows) return agencies;

  for (const row of rows) {
    agencies.set(row.agency_id, row.agency_name);
  }
  return agencies;
}

function parseRoutes(rows) {
  const routes = new Map();
  const agencyFallbackIndex = new Map();

  if (!rows) return routes;

  for (const row of rows) {
    const agencyId = row.agency_id;
    let color = row.route_color;

    if (!color || !String(color).trim()) {
      const fallbackIndex = agencyFallbackIndex.get(agencyId) ?? 0;
      color = ROUTE_COLOR_PALETTE[fallbackIndex % ROUTE_COLOR_PALETTE.length];
      agencyFallbackIndex.set(agencyId, fallbackIndex + 1);
    }

    routes.set(row.route_id, {
      route_short_name: row.route_short_name || '',
      route_long_name: row.route_long_name || '',
      route_color: formatRouteColor(color, '#3B82F6'),
      route_text_color: formatRouteColor(row.route_text_color, '#FFFFFF'),
      agency_id: agencyId,
    });
  }

  return routes;
}

function parseTrips(rows) {
  const shapeIdToRouteId = new Map();
  const tripIdToRouteId = new Map();

  if (!rows) return { shapeIdToRouteId, tripIdToRouteId };

  for (const row of rows) {
    tripIdToRouteId.set(row.trip_id, row.route_id);

    if (row.shape_id && !shapeIdToRouteId.has(row.shape_id)) {
      shapeIdToRouteId.set(row.shape_id, row.route_id);
    }
  }

  return { shapeIdToRouteId, tripIdToRouteId };
}

function parseShapes(rows) {
  const shapePoints = new Map();

  if (!rows) return shapePoints;

  for (const row of rows) {
    const shapeId = row.shape_id;
    const sequence = Number(row.shape_pt_sequence);
    const lat = Number(row.shape_pt_lat);
    const lng = Number(row.shape_pt_lon);

    if (!shapePoints.has(shapeId)) shapePoints.set(shapeId, []);
    shapePoints.get(shapeId).push({ sequence, lng, lat });
  }

  const shapes = new Map();
  for (const [shapeId, points] of shapePoints) {
    points.sort((a, b) => a.sequence - b.sequence);
    shapes.set(
      shapeId,
      points.map((point) => [point.lng, point.lat])
    );
  }

  return shapes;
}

function parseStops(rows) {
  if (!rows) return [];

  return rows.map((row) => ({
    stop_id: row.stop_id,
    stop_name: row.stop_name,
    stop_lat: Number(row.stop_lat),
    stop_lon: Number(row.stop_lon),
  }));
}

function stopMapKey(agencyId, stopId) {
  return `${agencyId}::${stopId}`;
}

async function buildStopRouteMap(stopTimesPath, tripIdToRouteId, routes, defaultAgencyId) {
  const stopToRoutes = new Map();

  await new Promise((resolve, reject) => {
    createReadStream(stopTimesPath)
      .pipe(
        parseStream({
          columns: true,
          skip_empty_lines: true,
          trim: true,
          relax_column_count: true,
        })
      )
      .on('data', (row) => {
        const routeId = tripIdToRouteId.get(row.trip_id);
        if (!row.stop_id || !routeId) return;

        const agencyId =
          routes.get(routeId)?.agency_id || defaultAgencyId || 'unknown';
        const key = stopMapKey(agencyId, row.stop_id);

        if (!stopToRoutes.has(key)) stopToRoutes.set(key, new Set());
        stopToRoutes.get(key).add(routeId);
      })
      .on('end', resolve)
      .on('error', reject);
  });

  return stopToRoutes;
}

function buildRouteFeatures(shapeIdToRouteId, shapes, routes, agencies) {
  const features = [];

  for (const [shapeId, routeId] of shapeIdToRouteId) {
    const coordinates = shapes.get(shapeId);
    if (!coordinates || coordinates.length < 2) continue;

    const route = routes.get(routeId);
    if (!route) continue;

    features.push({
      type: 'Feature',
      properties: {
        layer: 'route',
        route_id: routeId,
        route_short_name: route.route_short_name,
        route_long_name: route.route_long_name,
        agency_id: route.agency_id,
        agency_name: agencies.get(route.agency_id) || route.agency_id,
        color: route.route_color,
      },
      geometry: {
        type: 'LineString',
        coordinates,
      },
    });
  }

  return features;
}

function buildStopFeatures(stops, stopToRoutes, defaultAgencyId) {
  return stops.map((stop) => {
    const suffix = `::${stop.stop_id}`;
    const routeIdSet = new Set();
    let dedupAgencyId = defaultAgencyId;

    for (const [key, routeIds] of stopToRoutes) {
      if (!key.endsWith(suffix)) continue;
      dedupAgencyId = key.slice(0, key.length - suffix.length);
      routeIds.forEach((routeId) => routeIdSet.add(routeId));
    }

    return {
      type: 'Feature',
      properties: {
        layer: 'stop',
        stop_id: stop.stop_id,
        stop_name: stop.stop_name,
        route_ids: [...routeIdSet],
        _dedup_agency_id: dedupAgencyId,
      },
      geometry: {
        type: 'Point',
        coordinates: [stop.stop_lon, stop.stop_lat],
      },
    };
  });
}

function deduplicateStopFeatures(stopFeatures) {
  const byKey = new Map();

  for (const feature of stopFeatures) {
    const agencyId = feature.properties._dedup_agency_id || 'unknown';
    const key = stopMapKey(agencyId, feature.properties.stop_id);
    const existing = byKey.get(key);

    if (!existing) {
      byKey.set(key, feature);
      continue;
    }

    const mergedRouteIds = new Set([
      ...existing.properties.route_ids,
      ...feature.properties.route_ids,
    ]);
    existing.properties.route_ids = [...mergedRouteIds];
  }

  return [...byKey.values()].map((feature) => {
    const { _dedup_agency_id, ...rest } = feature.properties;
    return {
      ...feature,
      properties: rest,
    };
  });
}

function getDefaultAgencyId(agencies, routes) {
  if (agencies.size === 1) return [...agencies.keys()][0];
  if (agencies.size > 0) return [...agencies.keys()][0];
  if (routes.size > 0) return routes.values().next().value.agency_id;
  return 'unknown';
}

function feedMissingRequiredFiles(zip) {
  return FEED_REQUIRED_FILES.filter((filename) => !findZipEntry(zip, filename));
}

async function processFeedZip(zipBuffer, feed, tempDir) {
  const zip = new AdmZip(zipBuffer);
  const missing = feedMissingRequiredFiles(zip);
  if (missing.length) {
    console.warn(
      `  ⚠ ${feed.provider}: missing required file(s) ${missing.join(', ')} — skipped`
    );
    return { routeFeatures: [], stopFeatures: [], agencies: new Map() };
  }

  const agencies = parseAgencies(parseTxtFromZip(zip, 'agency.txt'));
  const routes = parseRoutes(parseTxtFromZip(zip, 'routes.txt'));
  const { shapeIdToRouteId, tripIdToRouteId } = parseTrips(
    parseTxtFromZip(zip, 'trips.txt')
  );
  const shapes = parseShapes(parseTxtFromZip(zip, 'shapes.txt'));
  const stops = parseStops(parseTxtFromZip(zip, 'stops.txt'));
  const defaultAgencyId = getDefaultAgencyId(agencies, routes);

  let stopToRoutes = new Map();
  const stopTimesEntry = findZipEntry(zip, 'stop_times.txt');
  if (stopTimesEntry) {
    const safeId = String(feed.mdb_id).replace(/[^a-zA-Z0-9_-]/g, '_');
    const stopTimesPath = join(tempDir, `stop_times_${safeId}.txt`);
    writeFileSync(stopTimesPath, stopTimesEntry.getData());
    stopToRoutes = await buildStopRouteMap(
      stopTimesPath,
      tripIdToRouteId,
      routes,
      defaultAgencyId
    );
  }

  const routeFeatures = buildRouteFeatures(
    shapeIdToRouteId,
    shapes,
    routes,
    agencies
  );
  const stopFeatures = buildStopFeatures(stops, stopToRoutes, defaultAgencyId);

  return { routeFeatures, stopFeatures, agencies };
}

async function main() {
  let tempDir = null;

  try {
    mkdirSync(DATA_DIR, { recursive: true });
    tempDir = join(tmpdir(), `provide-gtfs-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });

    let feeds = resolveLocalFeedSources() || (await discoverNcFeeds());
    if (!feeds.length) {
      throw new Error('No NC GTFS feeds to process');
    }

    if (process.env.GTFS_ZIP_PATH) {
      console.log(`Using local GTFS ZIP(s): ${process.env.GTFS_ZIP_PATH}`);
    } else {
      console.log(`🔍 Found ${feeds.length} NC GTFS feeds in Mobility Database`);
      for (const feed of feeds) {
        console.log(`  • ${feed.provider} (${feed.mdb_id})`);
      }
      feeds = await appendNtdFeeds(feeds);
    }

    const allRouteFeatures = [];
    const allStopFeatures = [];
    const allAgencies = new Map();
    let mobilityDbFeedsOk = 0;
    let ntdFeedsOk = 0;

    for (const feed of feeds) {
      let zipBuffer;
      try {
        if (feed.localPath) {
          zipBuffer = readFileSync(feed.localPath);
        } else {
          zipBuffer = await downloadFeedZip(feed.url, feed.provider);
        }
      } catch (err) {
        console.warn(`  ⚠ ${feed.provider}: download failed (${err.message})`);
        continue;
      }

      try {
        const { routeFeatures, stopFeatures, agencies } = await processFeedZip(
          zipBuffer,
          feed,
          tempDir
        );

        if (!routeFeatures.length && !stopFeatures.length) continue;

        if (feed.source === 'ntd') {
          routeFeatures.forEach((feature) => {
            feature.properties.agency_name = feed.provider;
          });
        }

        routeFeatures.forEach((feature) => allRouteFeatures.push(feature));
        stopFeatures.forEach((feature) => allStopFeatures.push(feature));
        agencies.forEach((name, id) => allAgencies.set(id, name));

        if (feed.source === 'ntd') {
          ntdFeedsOk += 1;
        } else {
          mobilityDbFeedsOk += 1;
        }

        console.log(
          `  ✓ ${feed.provider}: ${routeFeatures.length} routes, ${stopFeatures.length} stops`
        );
      } catch (err) {
        console.warn(`  ⚠ ${feed.provider}: parse failed (${err.message})`);
      }
    }

    if (!allRouteFeatures.length && !allStopFeatures.length) {
      throw new Error('No route or stop features produced from any feed');
    }

    const stopFeatures = deduplicateStopFeatures(allStopFeatures);

    const geojson = {
      type: 'FeatureCollection',
      features: [...allRouteFeatures, ...stopFeatures],
    };

    rewind(geojson, false);
    writeFileSync(OUT_PATH, JSON.stringify(geojson));

    const routeIds = new Set(
      allRouteFeatures.map((feature) => feature.properties.route_id)
    );
    const sizeMb = statSync(OUT_PATH).size / 1024 / 1024;
    const feedsOk = mobilityDbFeedsOk + ntdFeedsOk;
    console.log(
      `✅ NC GTFS: ${feedsOk} agencies (${mobilityDbFeedsOk} from MobilityDB, ${ntdFeedsOk} from NTD), ${routeIds.size} routes, ${stopFeatures.length} stops → ${OUT_PATH} (${sizeMb.toFixed(1)} MB)`
    );
  } finally {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

main().catch((err) => {
  console.error(`NC GTFS pipeline failed: ${err.message}`);
  process.exit(1);
});
