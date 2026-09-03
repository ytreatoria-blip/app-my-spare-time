import express from "express";
import helmet from "helmet";
import cors from "cors";
import morgan from "morgan";
import rateLimit from "express-rate-limit";

const app = express();
const PORT = process.env.PORT || 3000;

// Basic security / observability middlewares
app.use(helmet());
app.use(cors({ origin: process.env.CORS_ORIGIN || true }));
app.use(morgan(process.env.LOG_FORMAT || "combined"));
app.use(express.json());
app.use(express.static("public"));

// Basic rate limiter to protect Overpass and the server from abuse
app.use(
  rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: Number(process.env.RATE_LIMIT_MAX) || 60
  })
);


// ======================================================
// HEALTH CHECK
// ======================================================

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    app: "App My Spare Time",
    stage: "Adventure Brain v1-clean"
  });
});


// ======================================================
// DISTANCE CALCULATOR
// ======================================================

function distanceMiles(lat1, lon1, lat2, lon2) {
  const R = 3958.8;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) *
    Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;

  return R * 2 *
    Math.atan2(
      Math.sqrt(a),
      Math.sqrt(1 - a)
    );
}


// ======================================================
// OVERPASS FETCH WITH RETRIES
// ======================================================

async function tryFetchWithRetries(endpoint, query, attempts = 2) {
  let lastError;
  const timeoutMs = Number(process.env.OVERPASS_TIMEOUT_MS) || 30000;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": process.env.USER_AGENT || "AppMySpareTime/1.0 (contact@example.com)",
          "Accept": "application/json"
        },
        body: new URLSearchParams({ data: query }),
        signal: controller.signal
      });

      clearTimeout(timeout);

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
      }

      return await res.json();
    } catch (err) {
      clearTimeout(timeout);
      lastError = err;
      if (attempt < attempts) {
        // exponential-ish backoff
        await new Promise(r => setTimeout(r, 150 * Math.pow(2, attempt)));
      }
    }
  }

  throw lastError;
}


// ======================================================
// FIND PLACES USING OVERPASS
// ======================================================

async function findPlaces(query) {
  const endpoints = [
    process.env.OVERPASS_ENDPOINT_1 || "https://overpass.private.coffee/api/interpreter",
    process.env.OVERPASS_ENDPOINT_2 || "https://overpass-api.de/api/interpreter",
    process.env.OVERPASS_ENDPOINT_3 || "https://maps.mail.ru/osm/tools/overpass/api/interpreter"
  ];

  const failures = [];

  for (const endpoint of endpoints) {
    try {
      console.log(`Searching Overpass: ${endpoint}`);

      const data = await tryFetchWithRetries(endpoint, query, Number(process.env.OVERPASS_RETRIES) || 2);

      const places = (data.elements || [])
        .map(place => ({
          name: place.tags?.name,
          lat: place.lat ?? place.center?.lat,
          lon: place.lon ?? place.center?.lon,
          tags: place.tags || {}
        }))
        .filter(place =>
          place.name &&
          typeof place.lat === "number" &&
          typeof place.lon === "number"
        );

      if (places.length) return places;

      // If this endpoint returned ok but no places, record a short note and continue
      failures.push(`${endpoint} returned no places`);
    } catch (error) {
      failures.push(`${endpoint}: ${error.message}`);
    }
  }

  console.error("All Overpass searches failed:", failures.slice(0, 5));
  throw new Error(`Place search failed. ${failures.slice(0, 5).join(" | ")}`);
}
// =========================================
// UK-WIDE SEARCH
// =========================================

async function findPlacesUK(query) {
  const ukRegions = [
    { lat: 51.5074, lon: -0.1278 },  // London
    { lat: 52.4862, lon: -1.8904 },  // Birmingham
    { lat: 53.4808, lon: -2.2426 },  // Manchester
    { lat: 53.8008, lon: -1.5491 },  // Leeds
    { lat: 55.9533, lon: -3.1883 },  // Edinburgh
    { lat: 55.8642, lon: -4.2518 },  // Glasgow
    { lat: 54.9783, lon: -1.6178 },  // Newcastle
    { lat: 53.4084, lon: -2.9916 },  // Liverpool
    { lat: 51.4816, lon: -3.1791 },  // Cardiff
    { lat: 51.4545, lon: -2.5879 },  // Bristol
    { lat: 52.6309, lon: 1.2974 },   // Norwich
    { lat: 50.3755, lon: -4.1427 }   // Plymouth
  ];

  const searches = ukRegions.map(region => {
    const regionalQuery = query.replace(
      /around:\d+(?:\.\d+)?,[-\d.]+,[-\d.]+/g,
      `around:50000,${region.lat},${region.lon}`
    );

    return findPlaces(regionalQuery);
  });

  const results = await Promise.allSettled(searches);

  const allPlaces = results
    .filter(r => r.status === "fulfilled")
    .flatMap(r => r.value || []);

  // Deduplicate by name + rounded coordinates, limit total results
  const dedupeKey = p => `${p.name}-${p.lat.toFixed(5)}-${p.lon.toFixed(5)}`;
  const map = new Map();
  for (const p of allPlaces) {
    const key = dedupeKey(p);
    if (!map.has(key)) map.set(key, p);
  }

  const maxResults = Number(process.env.MAX_UK_RESULTS) || 300;
  return Array.from(map.values()).slice(0, maxResults);
}

// ======================================================
// GOOGLE MAPS URL
// ======================================================

function buildMapsUrl(origin, stops, transport) {
  const destination = stops[stops.length - 1];

  const waypoints =
    stops.length > 1
      ? stops
          .slice(0, -1)
          .map(stop => `${stop.lat},${stop.lon}`)
          .join("|")
      : "";

  let travelMode = "driving";
  if (transport === "Walking") travelMode = "walking";
  if (transport === "Bicycle") travelMode = "bicycling";
  if (transport === "Public transport") travelMode = "transit";

  const params = new URLSearchParams({
    api: "1",
    origin: `${origin.latitude},${origin.longitude}`,
    destination: `${destination.lat},${destination.lon}`,
    travelmode: travelMode
  });

  if (waypoints) params.set("waypoints", waypoints);

  return "https://www.google.com/maps/dir/?" + params.toString();
}


// ======================================================
// ADVENTURE BUILDER
// ======================================================

app.post("/api/adventure/build", async (req, res) => {
  try {
    console.log("ADVENTURE BUILD REQUEST RECEIVED");

    const origin = req.body.origin;
    const preferences = req.body.preferences || {};

    // --------------------------------------------------
    // LOCATION
    // --------------------------------------------------
    if (!origin || typeof origin.latitude !== "number" || typeof origin.longitude !== "number") {
      return res.status(400).json({ error: "Please use your current location first." });
    }

    // --------------------------------------------------
    // DISTANCE (sanitize input)
    // --------------------------------------------------
    const allowedDistanceMap = { "10": 10, "20": 20, "30": 30, "50": 50, "any": "any" };
    const rawDistanceChoice = String(preferences.distance ?? "20");
    const normalizedChoice = Object.prototype.hasOwnProperty.call(allowedDistanceMap, rawDistanceChoice)
      ? rawDistanceChoice
      : "20";

    const isAnywhereUK = normalizedChoice === "any";
    const radiusMiles = isAnywhereUK ? Infinity : allowedDistanceMap[normalizedChoice];
    const radiusMetres = isAnywhereUK ? 50000 : radiusMiles * 1609.34;

    // --------------------------------------------------
    // ACTIVITY SEARCH
    // --------------------------------------------------
    const activityQuery = `\n[out:json][timeout:20];\n\n(\n  nwr(\n    around:${radiusMetres},\n    ${origin.latitude},\n    ${origin.longitude}\n  )["tourism"~"attraction|museum|gallery|viewpoint|zoo|theme_park|heritage"];\n\n  nwr(\n    around:${radiusMetres},\n    ${origin.latitude},\n    ${origin.longitude}\n  )["historic"];\n\n  nwr(\n    around:${radiusMetres},\n    ${origin.latitude},\n    ${origin.longitude}\n  )["leisure"~"park|nature_reserve|garden"];\n\n  nwr(\n    around:${radiusMetres},\n    ${origin.latitude},\n    ${origin.longitude}\n  )["natural"~"beach|waterfall"];\n);\n\nout center tags;\n`;

    // --------------------------------------------------
    // FOOD SEARCH
    // --------------------------------------------------
    const foodQuery = `\n[out:json][timeout:20];\n\n(\n  nwr(\n    around:${radiusMetres},\n    ${origin.latitude},\n    ${origin.longitude}\n  )["amenity"~"restaurant|cafe|pub|fast_food"];\n);\n\nout center tags;\n`;

    console.log("SEARCHING FOR ACTIVITIES AND FOOD");

    // --------------------------------------------------
    // SEARCH
    // --------------------------------------------------
    const [activities, foods] = await Promise.all([
      isAnywhereUK ? findPlacesUK(activityQuery) : findPlaces(activityQuery),
      isAnywhereUK ? findPlacesUK(foodQuery) : findPlaces(foodQuery)
    ]);

    // --------------------------------------------------
    // DISTANCE FILTERING
    // --------------------------------------------------
    const suitableActivities = (activities || [])
      .map(place => ({
        ...place,
        distance: distanceMiles(origin.latitude, origin.longitude, place.lat, place.lon)
      }))
      .filter(place => radiusMiles === Infinity || place.distance <= radiusMiles)
      .sort((a, b) => a.distance - b.distance);

    const suitableFoods = (foods || [])
      .map(place => ({
        ...place,
        distance: distanceMiles(origin.latitude, origin.longitude, place.lat, place.lon)
      }))
      .filter(place => radiusMiles === Infinity || place.distance <= radiusMiles)
      .sort((a, b) => a.distance - b.distance);

    // --------------------------------------------------
    // ACTIVITY CHECK
    // --------------------------------------------------
    if (!suitableActivities.length) {
      return res.status(404).json({ error: "I couldn't find a suitable adventure nearby. Try increasing the distance." });
    }

    // --------------------------------------------------
    // CHOOSE ACTIVITY
    // --------------------------------------------------
    const interests = Array.isArray(preferences.interests)
      ? preferences.interests.map(value => String(value).toLowerCase())
      : [];

    const interestKeywords = {
      walking: ["park", "nature_reserve", "garden", "viewpoint", "beach", "waterfall"],
      nature: ["nature", "nature_reserve", "garden", "park", "beach", "waterfall"],
      history: ["historic", "heritage", "museum", "memorial", "castle", "hall"],
      castles: ["castle", "fort", "ruins"],
      coast: ["beach", "coast", "seaside", "cliff", "waterfront"],
      photography: ["viewpoint", "gallery", "attraction", "garden", "beach", "waterfall"],
      food: ["market"],
      adventure: ["theme_park", "waterfall", "beach", "attraction"],
      wildlife: ["zoo", "nature_reserve", "wildlife", "nature"],
      "something unusual": ["attraction", "heritage", "waterfall", "theme_park", "historic"],
      "scenic views": ["viewpoint", "waterfall", "beach", "scenic", "view"],
      gardens: ["garden"],
      museums: ["museum"],
      markets: ["market"],
      "surprise me": []
    };

    const activity = suitableActivities
      .map(place => {
        const name = String(place.name || "").toLowerCase();
        const tagText = Object.values(place.tags || {}).join(" ").toLowerCase();
        const searchable = `${name} ${tagText}`;
        let score = 0;

        interests.forEach((interest, index) => {
          const keywords = interestKeywords[interest] || [];
          const weight = index === 0 ? 6 : 3;

          if (keywords.some(keyword => searchable.includes(keyword))) score += weight;
          if (interest !== "surprise me" && name.includes(interest)) score += 2;
        });

        return { ...place, score };
      })
      .sort((a, b) => b.score - a.score || a.distance - b.distance)[0];

    // --------------------------------------------------
    // CHOOSE FOOD
    // --------------------------------------------------
    let food = null;
    if (suitableFoods.length) {
      const requestedFood = String(preferences.food || "Anything").toLowerCase();
      food = suitableFoods.find(place => {
        const tags = JSON.stringify(place.tags).toLowerCase();
        if (requestedFood.includes("pub") && tags.includes("pub")) return true;
        if (requestedFood.includes("cafe") && tags.includes("cafe")) return true;
        if (requestedFood.includes("restaurant") && tags.includes("restaurant")) return true;
        if (requestedFood.includes("vegetarian") && tags.includes("vegetarian")) return true;
        return requestedFood === "anything";
      }) || suitableFoods[0];
    }

    // --------------------------------------------------
    // BUILD STOPS
    // --------------------------------------------------
    const stops = food ? [activity, food] : [activity];

    // --------------------------------------------------
    // GOOGLE MAPS
    // --------------------------------------------------
    const mapsUrl = buildMapsUrl(origin, stops, preferences.transport || "Car");

    // --------------------------------------------------
    // RESPONSE
    // --------------------------------------------------
    return res.json({
      title: "Your App My Spare Time Adventure",
      area: activity.name,
      summary: food ? `I've found ${activity.name} for your adventure, followed by ${food.name} for a meal.` : `I've found ${activity.name} as your adventure destination.`,
      activity: {
        name: activity.name,
        distanceMiles: Math.round(activity.distance * 10) / 10
      },
      food: food
        ? {
            name: food.name,
            distanceMiles: Math.round(food.distance * 10) / 10
          }
        : null,
      duration: preferences.duration || "Flexible",
      stops: stops.length,
      mapsUrl
    });
  } catch (error) {
    console.error("ADVENTURE BUILD ERROR:", error);
    return res.status(500).json({ error: `Adventure Brain error: ${error.message}` });
  }
});


// ======================================================
// START SERVER
// ======================================================

app.listen(PORT, () => {
  console.log(`App My Spare Time running on port ${PORT}`);
});
