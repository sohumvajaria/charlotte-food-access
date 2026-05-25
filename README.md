# Charlotte Food Access

A web app that maps food resources in Charlotte, NC by ZIP code.

Built for the 2026 Congressional App Challenge, NC-12.

## What it does

Enter a ZIP code. The app finds SNAP retailers, food banks, free meal sites, and WIC locations within your chosen radius and plots them on a map.

## Features

- ZIP code geocoding via Nominatim (OpenStreetMap)
- Radius filter: 2, 5, or 10 miles
- Category filters: SNAP, Food Banks, Free Meals, WIC
- Live data from Overpass API (OpenStreetMap)
- Curated static dataset of verified Charlotte resources
- Directions via Google Maps
- Fully responsive

## Data Sources

- USDA Food and Nutrition Service (SNAP retailer data)
- Second Harvest Food Bank of Metrolina
- Mecklenburg County Public Health (WIC)
- Charlotte-Mecklenburg Schools (free meal sites)
- OpenStreetMap / Overpass API

## Run locally

No build step needed. Just open `index.html` in a browser.

Or deploy directly to GitHub Pages:

1. Push to a GitHub repo
2. Go to Settings > Pages
3. Set source to `main` branch, `/ (root)`
4. Your app is live at `https://<username>.github.io/<repo>`

## Tech

- Vanilla HTML/CSS/JS
- Leaflet.js for maps
- Nominatim for geocoding
- Overpass API for live OSM data

## Team

Built for Rep. Alma Adams (NC-12) Congressional App Challenge 2026.
