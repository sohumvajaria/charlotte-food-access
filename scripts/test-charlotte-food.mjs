#!/usr/bin/env node
/**
 * Verify Charlotte food pantry sources (ZIP 28202, 10 mi).
 * Usage: node scripts/test-charlotte-food.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHARLOTTE = { lat: 35.2271, lng: -80.8431, miles: 10 };

function withinRadius(centerLat, centerLng, pointLat, pointLng, radiusMiles) {
  const R = 3958.8;
  const dLat = (pointLat - centerLat) * Math.PI / 180;
  const dLng = (pointLng - centerLng) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((centerLat * Math.PI) / 180) *
      Math.cos((pointLat * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) <= radiusMiles;
}

function filterByRadius(rows, centerLat, centerLng, radiusMiles) {
  return rows.filter((r) =>
    withinRadius(centerLat, centerLng, r.lat, r.lng, radiusMiles)
  );
}

async function fetchNC211Live() {
  const url =
    'https://api.211.org/search/v1/api/search/keyword?keyword=food%20pantry&location=28202&distance=10&skip=0&top=100';
  const res = await fetch(url, {
    headers: { 'Api-Key': '21ccc53661d64eddbf492cb4f0c4492c' },
  });
  const data = await res.json();
  return (data.results || [])
    .map((item) => {
      const doc = item.document || item;
      const lat = parseFloat(doc.latitudeLocation);
      const lng = parseFloat(doc.longitudeLocation);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
      return { name: doc.nameService, lat, lng };
    })
    .filter(Boolean);
}

async function main() {
  const { lat, lng, miles } = CHARLOTTE;

  const nc211Live = await fetchNC211Live();
  const nc211LiveNear = filterByRadius(nc211Live, lat, lng, miles);
  console.log(`NC 211 live API (10 mi): ${nc211LiveNear.length}`);

  const nc211Cache = JSON.parse(
    readFileSync(join(ROOT, 'data', 'nc211-food-pantries.json'), 'utf8')
  );
  const nc211CacheNear = filterByRadius(nc211Cache, lat, lng, miles);
  console.log(`NC 211 cache (10 mi): ${nc211CacheNear.length}`);

  const cenc = JSON.parse(
    readFileSync(join(ROOT, 'data', 'foodbankcenc-locations.json'), 'utf8')
  );
  const cencNear = filterByRadius(cenc, lat, lng, miles);
  console.log(`Food Bank CENC FoodFinder (10 mi): ${cencNear.length}`);

  const removeHardcoded =
    nc211LiveNear.length >= 20 || nc211CacheNear.length >= 20;
  console.log(`Remove hardcoded Charlotte list: ${removeHardcoded}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
