import express from "express";
import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';


const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static("public"));


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
// PROVIDERS & OUTBOUND CLICK LOGGING
// ======================================================

app.get('/api/providers', async (req, res) => {
  try {
    const file = await fs.readFile(path.join(process.cwd(), 'data', 'providers.json'), 'utf8');
    res.type('application/json').send(file);
  } catch (err) {
    console.error('Could not load providers.json', err);
    // return an empty array as fallback
    return res.json([]);
  }
});

app.post('/api/outbound-click', async (req, res) => {
  try {
    const { providerId, provider, place, type, expandedUrl } = req.body || {};

    const record = {
      id: typeof randomUUID === 'function' ? randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2,8)}`,
      providerId: providerId || (provider && provider.id) || provider,
      providerName: (provider && provider.id) || providerId || provider,
      place: place || null,
      type: type || null,
      url: expandedUrl || null,
      userAgent: req.headers['user-agent'] || null,
      timestamp: new Date().toISOString()
    };

    const clicksPath = path.join(process.cwd(), 'data', 'outbound-clicks.json');

    let existing = [];

    try {
      const contents = await fs.readFile(clicksPath, 'utf8');
      existing = JSON.parse(contents || '[]');
    } catch (err) {
      // file might not exist; we'll create it
      existing = [];
    }

    existing.push(record);

    await fs.mkdir(path.join(process.cwd(), 'data'), { recursive: true });
    await fs.writeFile(clicksPath, JSON.stringify(existing, null, 2), 'utf8');

    return res.json({ ok: true, id: record.id });

  } catch (err) {
    console.error('Error logging outbound click', err);
    return res.status(500).json({ error: 'Could not log click' });
  }
});

// New endpoint: expand provider template (server-side) and log the click
app.post('/api/expand-and-log', async (req, res) => {
  try {
    const { providerId, place, type } = req.body || {};

    if (!providerId || !place) {
      return res.status(400).json({ error: 'providerId and place are required' });
    }

    const providersPath = path.join(process.cwd(), 'data', 'providers.json');
    let providers = [];

    try {
      const pText = await fs.readFile(providersPath, 'utf8');
      providers = JSON.parse(pText || '[]');
    } catch (err) {
      console.error('Could not read providers.json', err);
      providers = [];
    }

    const provider = providers.find(p => p.id === providerId);

    if (!provider) {
      return res.status(404).json({ error: 'Provider not found' });
    }

    // Expand template
    const affiliateValue = provider.affiliateEnv ? (process.env[provider.affiliateEnv] || '') : '';

    const replacements = {
      query: encodeURIComponent(`${place.name || ''}`),
      name: encodeURIComponent(`${place.name || ''}`),
      lat: place.lat != null ? String(place.lat) : '',
      lon: place.lon != null ? String(place.lon) : '',
      affiliate: encodeURIComponent(affiliateValue)
    };

    const expandedUrl = provider.template.replace(/\{(query|name|lat|lon|affiliate)\}/g, (m, key) => replacements[key] ?? '');

    // Log the click
    const record = {
      id: typeof randomUUID === 'function' ? randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2,8)}`,
      providerId: provider.id,
      providerName: provider.name,
      place: place,
      type: type || null,
      url: expandedUrl,
      userAgent: req.headers['user-agent'] || null,
      timestamp: new Date().toISOString()
    };

    const clicksPath = path.join(process.cwd(), 'data', 'outbound-clicks.json');

    let existing = [];

    try {
      const contents = await fs.readFile(clicksPath, 'utf8');
      existing = JSON.parse(contents || '[]');
    } catch (err) {
      existing = [];
    }

    existing.push(record);

    await fs.mkdir(path.join(process.cwd(), 'data'), { recursive: true });
    await fs.writeFile(clicksPath, JSON.stringify(existing, null, 2), 'utf8');

    return res.json({ ok: true, expandedUrl });

  } catch (err) {
    console.error('Error expanding provider template', err);
    return res.status(500).json({ error: 'Could not expand provider URL' });
  }
});


// ======================================================
// ANALYTICS DASHBOARD
// ======================================================

app.get('/api/analytics/clicks', async (req, res) => {
  try {
    const clicksPath = path.join(process.cwd(), 'data', 'outbound-clicks.json');
    const contents = await fs.readFile(clicksPath, 'utf8');
    const clicks = JSON.parse(contents || '[]');

    // Aggregate stats
    const stats = {
      totalClicks: clicks.length,
      clicksByProvider: {},
      clicksByType: {},
      recentClicks: clicks.slice(-20).reverse()
    };

    clicks.forEach(click => {
      stats.clicksByProvider[click.providerName] = (stats.clicksByProvider[click.providerName] || 0) + 1;
      if (click.type) {
        stats.clicksByType[click.type] = (stats.clicksByType[click.type] || 0) + 1;
      }
    });

    res.json(stats);
  } catch (err) {
    console.error('Error reading analytics', err);
    return res.json({
      totalClicks: 0,
      clicksByProvider: {},
      clicksByType: {},
      recentClicks: []
    });
  }
});

app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(process.cwd(), 'public', 'dashboard.html'));
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
// FIND PLACES USING OVERPASS
// ======================================================

async function findPlaces(query) {
  const endpoints = [
  
  "https://overpass.private.coffee/api/interpreter",
  "https://overpass-api.de/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter"
];

  const failures = [];

  for (const endpoint of endpoints) {
    const controller = new AbortController();

    const timeout = setTimeout(() => {
      controller.abort();
    }, 30000);

    try {
      console.log(`Searching Overpass: ${endpoint}`);

      const response = await fetch(endpoint, {
        method: "POST",

        headers: {
          "Content-Type":
            "application/x-www-form-urlencoded",

          "User-Agent":
            "AppMySpareTime/1.0",

          "Accept":
            "application/json"
        },

        body: new URLSearchParams({
          data: query
        }),

        signal: controller.signal
      });

      if (!response.ok) {
        const errorText = await response.text();

        failures.push(
          `${endpoint} returned HTTP ${response.status}: ${errorText.slice(0, 300)}`
        );

        continue;
      }

      const data = await response.json();

      return (data.elements || [])
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

    } catch (error) {
      failures.push(
        `${endpoint}: ${error.message}`
      );

    } finally {
      clearTimeout(timeout);
    }
  }

  console.error(
    "All Overpass searches failed:",
    failures
  );

  throw new Error(
    `Place search failed. ${failures.join(" | ")}`
  );
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

  return results
    .filter(result => result.status === "fulfilled")
    .flatMap(result => result.value);
}

// ======================================================
// GOOGLE MAPS URL
// ======================================================

function buildMapsUrl(origin, stops, transport) {
  const destination =
    stops[stops.length - 1];

  const waypoints =
    stops.length > 1
      ? stops
          .slice(0, -1)
          .map(stop =>
            `${stop.lat},${stop.lon}`
          )
          .join("|")
      : "";

  let travelMode = "driving";

  if (transport === "Walking") {
    travelMode = "walking";
  }

  if (transport === "Bicycle") {
    travelMode = "bicycling";
  }

  if (transport === "Public transport") {
    travelMode = "transit";
  }

  const params = new URLSearchParams({
    api: "1",

    origin:
      `${origin.latitude},${origin.longitude}`,

    destination:
      `${destination.lat},${destination.lon}`,

    travelmode:
      travelMode
  });

  if (waypoints) {
    params.set(
      "waypoints",
      waypoints
    );
  }

  return (
    "https://www.google.com/maps/dir/?" +
    params.toString()
  );
}


// ======================================================
// ADVENTURE BUILDER
// ======================================================

app.post(
  "/api/adventure/build",
  async (req, res) => {

    try {
      console.log(
        "ADVENTURE BUILD REQUEST RECEIVED"
      );

      const origin =
        req.body.origin;

      const preferences =
        req.body.preferences || {};


      // --------------------------------------------------
      // LOCATION
      // --------------------------------------------------

      if (
        !origin ||
        typeof origin.latitude !== "number" ||
        typeof origin.longitude !== "number"
      ) {
        return res.status(400).json({
          error:
            "Please use your current location first."
        });
      }


      // --------------------------------------------------
      // DISTANCE
      // --------------------------------------------------

      const distanceChoice = String(preferences.distance || "20");

const isAnywhereUK = distanceChoice === "any";

const radiusMiles =
  distanceChoice === "10" ? 10 :
  distanceChoice === "20" ? 20 :
  distanceChoice === "30" ? 30 :
  distanceChoice === "50" ? 50 :
  Infinity;

const radiusMetres =
  isAnywhereUK
    ? 50000
    : radiusMiles * 1609.34;

      // --------------------------------------------------
      // ACTIVITY SEARCH
      // --------------------------------------------------

      const activityQuery = `
[out:json][timeout:20];

(
  nwr(
    around:${radiusMetres},
    ${origin.latitude},
    ${origin.longitude}
  )["tourism"~"attraction|museum|gallery|viewpoint|zoo|theme_park|heritage"];

  nwr(
    around:${radiusMetres},
    ${origin.latitude},
    ${origin.longitude}
  )["historic"];

  nwr(
    around:${radiusMetres},
    ${origin.latitude},
    ${origin.longitude}
  )["leisure"~"park|nature_reserve|garden"];

  nwr(
    around:${radiusMetres},
    ${origin.latitude},
    ${origin.longitude}
  )["natural"~"beach|waterfall"];
);

out center tags;
`;


      // --------------------------------------------------
      // FOOD SEARCH
      // --------------------------------------------------

      const foodQuery = `
[out:json][timeout:20];

(
  nwr(
    around:${radiusMetres},
    ${origin.latitude},
    ${origin.longitude}
  )["amenity"~"restaurant|cafe|pub|fast_food"];
);

out center tags;
`;


      console.log(
        "SEARCHING FOR ACTIVITIES AND FOOD"
      );


      // --------------------------------------------------
      // SEARCH
      // --------------------------------------------------

      const [
  activities,
  foods
] = await Promise.all([
  isAnywhereUK
    ? findPlacesUK(activityQuery)
    : findPlaces(activityQuery),

  isAnywhereUK
    ? findPlacesUK(foodQuery)
    : findPlaces(foodQuery)
]);

      // --------------------------------------------------
      // DISTANCE FILTERING
      // --------------------------------------------------

      const suitableActivities =
        activities
          .map(place => ({
            ...place,

            distance:
              distanceMiles(
                origin.latitude,
                origin.longitude,
                place.lat,
                place.lon
              )
          }))
          .filter(place =>
            radiusMiles === Infinity ||
            place.distance <= radiusMiles
          )
          .sort(
            (a, b) =>
              a.distance - b.distance
          );


      const suitableFoods =
        foods
          .map(place => ({
            ...place,

            distance:
              distanceMiles(
                origin.latitude,
                origin.longitude,
                place.lat,
                place.lon
              )
          }))
          .filter(place =>
            radiusMiles === Infinity ||
            place.distance <= radiusMiles
          )
          .sort(
            (a, b) =>
              a.distance - b.distance
          );


      // --------------------------------------------------
      // ACTIVITY CHECK
      // --------------------------------------------------

      if (!suitableActivities.length) {
        return res.status(404).json({
          error:
            "I couldn't find a suitable adventure nearby. Try increasing the distance."
        });
      }


      // --------------------------------------------------
      // CHOOSE ACTIVITY
      // --------------------------------------------------

      const interests = Array.isArray(preferences.interests)
  ? preferences.interests.map(value =>
      String(value).toLowerCase()
    )
  : [];

const interestKeywords = {
  walking: [
    "park",
    "nature_reserve",
    "garden",
    "viewpoint",
    "beach",
    "waterfall"
  ],

  nature: [
    "nature",
    "nature_reserve",
    "garden",
    "park",
    "beach",
    "waterfall"
  ],

  history: [
    "historic",
    "heritage",
    "museum",
    "memorial",
    "castle",
    "hall"
  ],

  castles: [
    "castle",
    "fort",
    "ruins"
  ],

  coast: [
    "beach",
    "coast",
    "seaside",
    "cliff",
    "waterfront"
  ],

  photography: [
    "viewpoint",
    "gallery",
    "attraction",
    "garden",
    "beach",
    "waterfall"
  ],

  food: [
    "market"
  ],

  adventure: [
    "theme_park",
    "waterfall",
    "beach",
    "attraction"
  ],

  wildlife: [
    "zoo",
    "nature_reserve",
    "wildlife",
    "nature"
  ],

  "something unusual": [
    "attraction",
    "heritage",
    "waterfall",
    "theme_park",
    "historic"
  ],

  "scenic views": [
    "viewpoint",
    "waterfall",
    "beach",
    "scenic",
    "view"
  ],

  gardens: [
    "garden"
  ],

  museums: [
    "museum"
  ],

  markets: [
    "market"
  ],

  "surprise me": []
};

const activity = suitableActivities
  .map(place => {
    const name =
      String(place.name || "").toLowerCase();

    const tagText =
      Object.values(place.tags || {})
        .join(" ")
        .toLowerCase();

    const searchable =
      `${name} ${tagText}`;

    let score = 0;

    interests.forEach((interest, index) => {
      const keywords =
        interestKeywords[interest] || [];

      const weight =
        index === 0 ? 6 : 3;

      if (
        keywords.some(keyword =>
          searchable.includes(keyword)
        )
      ) {
        score += weight;
      }

      if (
        interest !== "surprise me" &&
        name.includes(interest)
      ) {
        score += 2;
      }
    });

    return {
      ...place,
      score
    };
  })
  .sort(
    (a, b) =>
      b.score - a.score ||
      a.distance - b.distance
  )[0];

      // --------------------------------------------------
      // CHOOSE FOOD
      // --------------------------------------------------

      let food = null;

      if (suitableFoods.length) {
        const requestedFood =
          String(
            preferences.food || "Anything"
          ).toLowerCase();

        food =
          suitableFoods.find(place => {
            const tags =
              JSON.stringify(
                place.tags
              ).toLowerCase();

            if (
              requestedFood.includes("pub") &&
              tags.includes("pub")
            ) {
              return true;
            }

            if (
              requestedFood.includes("cafe") &&
              tags.includes("cafe")
            ) {
              return true;
            }

            if (
              requestedFood.includes("restaurant") &&
              tags.includes("restaurant")
            ) {
              return true;
            }

            if (
              requestedFood.includes("vegetarian") &&
              tags.includes("vegetarian")
            ) {
              return true;
            }

            return requestedFood === "anything";

          }) ||
          suitableFoods[0];
      }


      // --------------------------------------------------
      // BUILD STOPS
      // --------------------------------------------------

      const stops =
        food
          ? [activity, food]
          : [activity];


      // --------------------------------------------------
      // GOOGLE MAPS
      // --------------------------------------------------

      const mapsUrl =
        buildMapsUrl(
          origin,
          stops,
          preferences.transport || "Car"
        );


      // --------------------------------------------------
      // RESPONSE
      // --------------------------------------------------

      return res.json({

        title:
          "Your App My Spare Time Adventure",

        area:
          activity.name,

        summary:
          food
            ? `I've found ${activity.name} for your adventure, followed by ${food.name} for a meal.`
            : `I've found ${activity.name} as your adventure destination.`,

        activity: {
          name: activity.name,
          lat: activity.lat,
          lon: activity.lon,
          tags: activity.tags,
          distanceMiles:
            Math.round(
              activity.distance * 10
            ) / 10
        },

        food:
          food
            ? {
                name: food.name,
                lat: food.lat,
                lon: food.lon,
                tags: food.tags,
                distanceMiles:
                  Math.round(
                    food.distance * 10
                  ) / 10
              }
            : null,

        duration:
          preferences.duration || "Flexible",

        stops:
          stops.length,

        mapsUrl,

        travelpayoutsUrl:
          "https://www.travelpayouts.com/?marker=769134"

      });

    } catch (error) {

      console.error(
        "ADVENTURE BUILD ERROR:",
        error
      );

      return res.status(500).json({
        error:
          `Adventure Brain error: ${error.message}`
      });
    }
  }
);


// ======================================================
// START SERVER
// ======================================================

app.listen(
  PORT,
  () => {
    console.log(
      `App My Spare Time running on port ${PORT}`
    );
  }
);
