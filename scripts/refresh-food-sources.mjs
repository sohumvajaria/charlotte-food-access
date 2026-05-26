#!/usr/bin/env node
/**
 * Refresh local caches for NC 211 and Food Bank CENC FoodFinder (browser CORS fallback).
 * Usage: node scripts/refresh-food-sources.mjs
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NC211_API_KEY = '21ccc53661d64eddbf492cb4f0c4492c';
const NC211_SEARCH_URL =
  'https://api.211.org/search/v1/api/search/keyword';
const FOOD_FINDER_LOCATIONS_URL =
  'https://foodfinder.foodbankcenc.org/api/v1/locations';

const NC211_RADIUS_MILES = 25;
const NC211_TOP = 100;
const API_PAUSE_MS = 300;

const NC211_PANTRY_KEYWORD = 'food pantry';

const NC211_SOUP_KEYWORDS = [
  'soup kitchen',
  'hot meal',
  'community meal',
  'free meal',
];

/** Major NC population centers — 25 mi radius each, merged statewide. */
const NC211_QUERY_ZIPS = [
  { zip: '28202', label: 'Charlotte' },
  { zip: '27601', label: 'Raleigh' },
  { zip: '27701', label: 'Durham' },
  { zip: '27401', label: 'Greensboro' },
  { zip: '27101', label: 'Winston-Salem' },
  { zip: '28801', label: 'Asheville' },
  { zip: '28401', label: 'Wilmington' },
  { zip: '28301', label: 'Fayetteville' },
  { zip: '27834', label: 'Greenville' },
  { zip: '28543', label: 'Jacksonville' },
  { zip: '28144', label: 'Salisbury' },
  { zip: '28115', label: 'Mooresville' },
  { zip: '28025', label: 'Concord' },
  { zip: '28358', label: 'Lumberton (Robeson County)' },
  { zip: '27870', label: 'Roanoke Rapids (Halifax County)' },
  { zip: '27893', label: 'Wilson (Wilson County)' },
  { zip: '28501', label: 'Kinston (Lenoir County)' },
  { zip: '27288', label: 'Eden (Rockingham County)' },
  { zip: '27292', label: 'Lexington (Davidson County)' },
  { zip: '28655', label: 'Morganton (Burke County)' },
  { zip: '28334', label: 'Dunn (Harnett County)' },
  { zip: '28374', label: 'Pinehurst (Moore County)' },
  { zip: '27909', label: 'Elizabeth City' },
  { zip: '28607', label: 'Boone' },
  { zip: '28540', label: 'Jacksonville' },
];

const CHARLOTTE_CENTER = { lat: 35.2271, lng: -80.8431 };

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withinRadius(centerLat, centerLng, pointLat, pointLng, radiusMiles) {
  const R = 3958.8;
  const dLat = ((pointLat - centerLat) * Math.PI) / 180;
  const dLng = ((pointLng - centerLng) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((centerLat * Math.PI) / 180) *
      Math.cos((pointLat * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) <= radiusMiles;
}

async function fetchNC211Keyword(location, keyword, distanceMiles, top) {
  const url = new URL(NC211_SEARCH_URL);
  url.searchParams.set('keyword', keyword);
  url.searchParams.set('location', location);
  url.searchParams.set('distance', String(distanceMiles));
  url.searchParams.set('skip', '0');
  url.searchParams.set('top', String(top));

  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const res = await fetch(url.toString(), {
        headers: { 'Api-Key': NC211_API_KEY },
      });
      if (!res.ok) {
        throw new Error(
          `NC 211 search failed: ${res.status} (${keyword} @ ${location})`
        );
      }
      return res.json();
    } catch (err) {
      lastError = err;
      if (attempt === 0) await sleep(1000);
    }
  }
  throw lastError;
}

async function fetchNC211KeywordSafe(location, keyword, distanceMiles, top) {
  try {
    return await fetchNC211Keyword(location, keyword, distanceMiles, top);
  } catch (err) {
    console.warn(`    WARN "${keyword}" @ ${location}: ${err.message}`);
    return { results: [], count: 0 };
  }
}

function mapNC211PantryDocument(doc) {
  const lat = parseFloat(doc.latitudeLocation);
  const lng = parseFloat(doc.longitudeLocation);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  const locationId =
    doc.idLocation || doc.idServiceAtLocation || doc.idService || doc.id;
  if (!locationId) return null;

  const address = [
    doc.address1PhysicalAddress,
    doc.cityPhysicalAddress,
    doc.statePhysicalAddress,
    doc.regionPhysicalAddress,
  ]
    .filter(Boolean)
    .join(', ');

  return {
    nc211LocationId: String(locationId),
    name: (doc.nameService || doc.nameOrganization || 'Food Pantry').trim(),
    lat,
    lng,
    address: address || 'North Carolina',
    phone: doc.phone || doc.phoneNumber || '',
    category: 'food_bank',
  };
}

function mapNC211SoupKitchenDocument(doc) {
  const lat = parseFloat(doc.latitudeLocation);
  const lng = parseFloat(doc.longitudeLocation);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  const locationId =
    doc.idLocation || doc.idServiceAtLocation || doc.idService || doc.id;
  if (!locationId) return null;

  const agencyName = (doc.nameOrganization || '').trim();
  const serviceName = (doc.nameService || doc.nameOrganization || '').trim();
  const name = agencyName || serviceName || 'Free Meal Site';

  const address = (doc.address1PhysicalAddress || '').trim();
  const city = (doc.cityPhysicalAddress || '').trim();
  const state = (doc.statePhysicalAddress || '').trim();
  const zip = (
    doc.zipPhysicalAddress ||
    doc.postalCodePhysicalAddress ||
    doc.zipCodePhysicalAddress ||
    ''
  )
    .toString()
    .trim();

  const phone = (
    doc.phone ||
    doc.phoneNumber ||
    doc.phoneMain ||
    doc.mainPhone ||
    ''
  )
    .toString()
    .trim();

  const hours =
    doc.hours ||
    doc.hoursOfOperation ||
    doc.serviceHours ||
    doc.operationHours ||
    null;

  return {
    name,
    address,
    city,
    state,
    zip,
    lat,
    lng,
    phone,
    hours: hours ? String(hours).trim() : null,
    nc211LocationId: String(locationId),
    category: 'free_meals_all_ages',
  };
}

function dedupeNC211ByLocationId(rows) {
  const byId = new Map();
  for (const row of rows) {
    if (!row?.nc211LocationId) continue;
    byId.set(row.nc211LocationId, row);
  }
  return [...byId.values()];
}

async function fetchNC211StatewidePantry() {
  const merged = [];

  for (const { zip, label } of NC211_QUERY_ZIPS) {
    const data = await fetchNC211KeywordSafe(
      zip,
      NC211_PANTRY_KEYWORD,
      NC211_RADIUS_MILES,
      NC211_TOP
    );
    const rows = (data.results || [])
      .map((item) => mapNC211PantryDocument(item.document || item))
      .filter(Boolean);
    console.log(
      `  ${label} (${zip}): ${rows.length} rows (API count ${data.count ?? '?'})`
    );
    merged.push(...rows);
    await sleep(API_PAUSE_MS);
  }

  const deduped = dedupeNC211ByLocationId(merged);
  console.log(
    `NC 211 pantries merged: ${merged.length} raw → ${deduped.length} unique`
  );
  return deduped;
}

async function fetchNC211StatewideSoupKitchens() {
  const merged = [];
  const hubKeywordCounts = [];

  console.log('\nSoup kitchen / meal keyword pass (per hub × keyword):');

  for (const { zip, label } of NC211_QUERY_ZIPS) {
    console.log(`\n  ${label} (${zip})`);
    for (const keyword of NC211_SOUP_KEYWORDS) {
      const data = await fetchNC211KeywordSafe(
        zip,
        keyword,
        NC211_RADIUS_MILES,
        NC211_TOP
      );
      const rows = (data.results || [])
        .map((item) => mapNC211SoupKitchenDocument(item.document || item))
        .filter(Boolean);
      console.log(
        `    "${keyword}": ${rows.length} rows (API count ${data.count ?? '?'})`
      );
      hubKeywordCounts.push({ zip, label, keyword, rows: rows.length });
      merged.push(...rows);
      await sleep(API_PAUSE_MS);
    }
  }

  const deduped = dedupeNC211ByLocationId(merged);
  console.log(
    `\nNC 211 soup kitchens merged: ${merged.length} raw → ${deduped.length} unique`
  );

  const charlotte10mi = deduped.filter((row) =>
    withinRadius(
      CHARLOTTE_CENTER.lat,
      CHARLOTTE_CENTER.lng,
      row.lat,
      row.lng,
      10
    )
  );
  console.log(
    `Within 10 mi of Charlotte (28202 center): ${charlotte10mi.length} unique locations`
  );

  return { deduped, hubKeywordCounts };
}

function mapFoodFinderLocation(loc) {
  const lat = parseFloat(loc.latitude);
  const lng = parseFloat(loc.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  return {
    name: String(loc.name || 'Food Assistance Site').trim(),
    lat,
    lng,
    address: String(loc.address || '')
      .replace(/\s+/g, ' ')
      .trim(),
    phone: loc.phone ? String(loc.phone) : '',
    category: 'food_bank',
  };
}

async function main() {
  console.log('Fetching NC 211 food pantries (statewide ZIP hubs)...');
  const nc211Rows = await fetchNC211StatewidePantry();

  writeFileSync(
    join(ROOT, 'data', 'nc211-food-pantries.json'),
    JSON.stringify(nc211Rows, null, 2)
  );
  console.log(`Wrote ${nc211Rows.length} NC 211 food pantry rows`);

  console.log('\nFetching NC 211 soup kitchens / all-ages meals...');
  const { deduped: soupRows } = await fetchNC211StatewideSoupKitchens();

  writeFileSync(
    join(ROOT, 'data', 'nc211-soup-kitchens.json'),
    JSON.stringify(soupRows, null, 2)
  );
  console.log(`Wrote ${soupRows.length} rows to data/nc211-soup-kitchens.json`);

  const ffRes = await fetch(FOOD_FINDER_LOCATIONS_URL, {
    headers: { Accept: 'application/json' },
  });
  if (!ffRes.ok) throw new Error(`FoodFinder API failed: ${ffRes.status}`);
  const ffData = await ffRes.json();
  const ffRows = (ffData.locations || [])
    .map(mapFoodFinderLocation)
    .filter(Boolean);

  writeFileSync(
    join(ROOT, 'data', 'foodbankcenc-locations.json'),
    JSON.stringify(ffRows, null, 2)
  );
  console.log(`Wrote ${ffRows.length} Food Bank CENC locations`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
