// src/hooks/usePlaces.js
import { Loader } from "@googlemaps/js-api-loader";

let mapsPromise = null;
function loadMaps() {
  if (!mapsPromise) {
    const key = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;
    mapsPromise = new Loader({ apiKey: key, version: "weekly", libraries: ["places"] }).load();
  }
  return mapsPromise;
}

export async function fetchNearbyPOIs(lat, lng, radius = 600) {
  await loadMaps();
  const center = new google.maps.LatLng(lat, lng);
  const svc = new google.maps.places.PlacesService(document.createElement("div"));

  const queries = [
    { keyword: "Amazon Locker", radius },
    { keyword: "UPS Store", radius },
    { keyword: "USPS", radius },
    { keyword: "FedEx", radius },
    { keyword: "Whole Foods", radius },
    { keyword: "Target", radius },
    { keyword: "Domino's", radius },
    { keyword: "Starbucks", radius },
  ];

  const results = await Promise.all(queries.map(q => nearby(svc, center, q)));
  const merged = dedupeById([].concat(...results));

  return merged.map(p => ({
    id: p.place_id,
    name: p.name,
    address: p.vicinity || p.formatted_address || "",
    lat: p.geometry?.location?.lat(),
    lng: p.geometry?.location?.lng(),
    cat: detectCategory(p.name),
  }));
}

function nearby(service, location, opts) {
  return new Promise((resolve) => {
    service.nearbySearch({ location, ...opts }, (res, status) => {
      if (status === google.maps.places.PlacesServiceStatus.OK && Array.isArray(res)) resolve(res);
      else resolve([]);
    });
  });
}

function dedupeById(list){
  const seen = new Set(); const out = [];
  for (const x of list) { if (x && x.place_id && !seen.has(x.place_id)) { seen.add(x.place_id); out.push(x); } }
  return out;
}

function detectCategory(name) {
  const s = (name||"").toLowerCase();
  if (s.includes("amazon locker") || s.includes("ups") || s.includes("fedex")) return "returns";
  if (s.includes("usps") || s.includes("post office")) return "mail";
  if (s.includes("whole foods") || s.includes("target") || s.includes("market")) return "groceries";
  if (s.includes("domino")) return "anchor_pizza";
  if (s.includes("starbucks")) return "anchor_coffee";
  return "general";
}
