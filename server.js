import express from "express";
import fs from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";

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
    stage: "Adventure Brain v2-single-affiliate"
  });
});

// ======================================================
// UNIVERSAL AFFILIATE LINK (NO PROVIDERS)
// ======================================================

const TRAVELPAYOUTS_URL =
  "https://www.travelpayouts.com/click?marker=769134";

// ======================================================
// OUTBOUND CLICK LOGGING (NO PROVIDERS)
// ======================================================

app.post("/api/outbound-click", async (req, res) => {
  try {
    const { place, type } = req.body || {};

    const record = {
      id: randomUUID(),
      place: place || null,
      type: type || null,
      url: TRAVELPAYOUTS_URL,
      userAgent: req.headers["user-agent"] || null,
      timestamp: new Date().toISOString()
    };

    const clicksPath = path.join(process.cwd(), "data", "outbound-clicks.json");

    let existing = [];
    try {
      const contents = await fs.readFile(clicksPath, "utf8");
      existing = JSON.parse(contents || "[]");
    } catch {
      existing = [];
    }

    existing.push(record);

    await fs.mkdir(path.join(process.cwd(), "data"), { recursive: true });
    await fs.writeFile(clicksPath, JSON.stringify(existing, null, 2), "utf8");

    return res.json({ ok: true, id: record.id });
  } catch (err) {
    console.error("Error logging outbound click", err);
    return res.status(500).json({ error: "Could not log click" });
  }
});

// ======================================================
// ANALYTICS DASHBOARD
// ======================================================

app.get("/api/analytics/clicks", async (req, res) => {
  try {
    const clicksPath = path.join(process.cwd(), "data", "outbound-clicks.json");
    const contents = await fs.readFile(clicksPath, "utf8");
    const clicks = JSON.parse(contents || "[]");

    const stats = {
      totalClicks: clicks.length,
      clicksByType: {},
      recentClicks: clicks.slice(-20).reverse()
    };

    clicks.forEach(click => {
      if (click.type) {
        stats.clicksByType[click.type] =
          (stats.clicksByType[click.type] || 0) + 1;
      }
    });

    res.json(stats);
  } catch (err) {
    console.error("Error reading analytics", err);
    return res.json({
      totalClicks: 0,
      clicksByType: {},
      recentClicks: []
    });
  }
});

app.get("/dashboard", (req, res) => {
  res.sendFile(path.join(process.cwd(), "public", "dashboard.html"));
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

  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ======================================================
// OVERPASS + NOMINATIM SEARCH
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
    const timeout = setTimeout(() => controller.abort(), 30000);

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "AppMySpareTime/1.0",
          "Accept": "application/json"
        },
        body: new URLSearchParams({ data: query }),
        signal: controller.signal
      });

      if (!response.ok) {
        failures.push(`${endpoint} returned HTTP ${response.status}`);
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
      failures.push(`${endpoint}: ${error.message}`);
    } finally {
      clearTimeout(timeout);
    }
  }

  // Fallback: Nominatim
  try {
    const nominatimUrl =
      `https://nominatim.openstreetmap.org/search?` +
      new URLSearchParams({
        q: "tourist attraction",
        format: "json",
        limit: 20,
        addressdetails: 1,
        extratags: 1,
        namedetails: 1
      });

    const response = await fetch(nominatimUrl, {
      headers: { "User-Agent": "AppMySpareTime/1.0" }
    });

    const data = await response.json();

    const places = data.map(item => ({
      name: item.display_name,
      lat: Number(item.lat),
      lon: Number(item.lon),
      tags: item.extratags || {}
    }));

    if (places.length > 0) return places;
  } catch (fallbackError) {
    failures.push("Nominatim fallback failed: " + fallbackError.message);
  }

  throw new Error(`Place search failed. ${failures.join(" | ")}`);
}

// ======================================================
// GOOGLE MAPS URL
// ======================================================

function buildMapsUrl(origin, stops, transport) {
  const destination = stops[stops.length - 1];

  const waypoints =
    stops.length > 1
      ? stops.slice(0, -1).map(stop => `${stop.lat},${stop.lon}`).join("|")
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
    const origin = req.body.origin;
    const preferences = req.body.preferences || {};

    if (
      !origin ||
      typeof origin.latitude !== "number" ||
      typeof origin.longitude !== "number"
    ) {
      return res.status(400).json({
        error: "Please use your current location first."
      });
    }

    const distanceChoice = String(preferences.distance || "20");
    const radiusMiles =
      distanceChoice === "10" ? 10 :
      distanceChoice === "20" ? 20 :
      distanceChoice === "30" ? 30 :
      distanceChoice === "50" ? 50 :
      Infinity;

    const radiusMetres =
      radiusMiles === Infinity
        ? 50000
        : radiusMiles * 1609.34;

    const activityQuery = `
[out:json][timeout:20];
(
  nwr(around:${radiusMetres},${origin.latitude},${origin.longitude})["tourism"];
  nwr(around:${radiusMetres},${origin.latitude},${origin.longitude})["historic"];
  nwr(around:${radiusMetres},${origin.latitude},${origin.longitude})["leisure"];
  nwr(around:${radiusMetres},${origin.latitude},${origin.longitude})["natural"];
);
out center tags;
`;

    const foodQuery = `
[out:json][timeout:20];
(
  nwr(around:${radiusMetres},${origin.latitude},${origin.longitude})["amenity"~"restaurant|cafe|pub|fast_food"];
);
out center tags;
`;

    const [activities, foods] = await Promise.all([
      findPlaces(activityQuery),
      findPlaces(foodQuery)
    ]);

    const suitableActivities = activities
      .map(place => ({
        ...place,
        distance: distanceMiles(
          origin.latitude,
          origin.longitude,
          place.lat,
          place.lon
        )
      }))
      .filter(place =>
        radiusMiles === Infinity || place.distance <= radiusMiles
      )
      .sort((a, b) => a.distance - b.distance);

    if (!suitableActivities.length) {
      return res.status(404).json({
        error: "I couldn't find a suitable adventure nearby."
      });
    }

    const activity = suitableActivities[0];

    const suitableFoods = foods
      .map(place => ({
        ...place,
        distance: distanceMiles(
          origin.latitude,
          origin.longitude,
          place.lat,
          place.lon
        )
      }))
      .filter(place =>
        radiusMiles === Infinity || place.distance <= radiusMiles
      )
      .sort((a, b) => a.distance - b.distance);

    const food = suitableFoods[0] || null;

    const stops = food ? [activity, food] : [activity];

    const mapsUrl = buildMapsUrl(
      origin,
      stops,
      preferences.transport || "Car"
    );

    return res.json({
      title: "Your App My Spare Time Adventure",
      area: activity.name,
      summary: food
        ? `I've found ${activity.name} for your adventure, followed by ${food.name} for a meal.`
        : `I've found ${activity.name} as your adventure destination.`,
      activity: {
        name: activity.name,
        lat: activity.lat,
        lon: activity.lon,
        tags: activity.tags,
        distanceMiles: Math.round(activity.distance * 10) / 10
      },
      food: food
        ? {
            name: food.name,
            lat: food.lat,
            lon: food.lon,
            tags: food.tags,
            distanceMiles: Math.round(food.distance * 10) / 10
          }
        : null,
      duration: preferences.duration || "Flexible",
      stops: stops.length,
      mapsUrl,
      travelpayoutsUrl: TRAVELPAYOUTS_URL
    });
  } catch (error) {
    console.error("ADVENTURE BUILD ERROR:", error);
    return res.status(500).json({
      error: `Adventure Brain error: ${error.message}`
    });
  }
});

// ======================================================
// START SERVER
// ======================================================

app.listen(PORT, () => {
  console.log(`App My Spare Time running on port ${PORT}`);
});import express from "express";
import fs from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";

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
    stage: "Adventure Brain v2-single-affiliate"
  });
});

// ======================================================
// UNIVERSAL AFFILIATE LINK (NO PROVIDERS)
// ======================================================

const TRAVELPAYOUTS_URL =
  "https://www.travelpayouts.com/click?marker=769134";

// ======================================================
// OUTBOUND CLICK LOGGING (NO PROVIDERS)
// ======================================================

app.post("/api/outbound-click", async (req, res) => {
  try {
    const { place, type } = req.body || {};

    const record = {
      id: randomUUID(),
      place: place || null,
      type: type || null,
      url: TRAVELPAYOUTS_URL,
      userAgent: req.headers["user-agent"] || null,
      timestamp: new Date().toISOString()
    };

    const clicksPath = path.join(process.cwd(), "data", "outbound-clicks.json");

    let existing = [];
    try {
      const contents = await fs.readFile(clicksPath, "utf8");
      existing = JSON.parse(contents || "[]");
    } catch {
      existing = [];
    }

    existing.push(record);

    await fs.mkdir(path.join(process.cwd(), "data"), { recursive: true });
    await fs.writeFile(clicksPath, JSON.stringify(existing, null, 2), "utf8");

    return res.json({ ok: true, id: record.id });
  } catch (err) {
    console.error("Error logging outbound click", err);
    return res.status(500).json({ error: "Could not log click" });
  }
});

// ======================================================
// ANALYTICS DASHBOARD
// ======================================================

app.get("/api/analytics/clicks", async (req, res) => {
  try {
    const clicksPath = path.join(process.cwd(), "data", "outbound-clicks.json");
    const contents = await fs.readFile(clicksPath, "utf8");
    const clicks = JSON.parse(contents || "[]");

    const stats = {
      totalClicks: clicks.length,
      clicksByType: {},
      recentClicks: clicks.slice(-20).reverse()
    };

    clicks.forEach(click => {
      if (click.type) {
        stats.clicksByType[click.type] =
          (stats.clicksByType[click.type] || 0) + 1;
      }
    });

    res.json(stats);
  } catch (err) {
    console.error("Error reading analytics", err);
    return res.json({
      totalClicks: 0,
      clicksByType: {},
      recentClicks: []
    });
  }
});

app.get("/dashboard", (req, res) => {
  res.sendFile(path.join(process.cwd(), "public", "dashboard.html"));
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

  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ======================================================
// OVERPASS + NOMINATIM SEARCH
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
    const timeout = setTimeout(() => controller.abort(), 30000);

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "AppMySpareTime/1.0",
          "Accept": "application/json"
        },
        body: new URLSearchParams({ data: query }),
        signal: controller.signal
      });

      if (!response.ok) {
        failures.push(`${endpoint} returned HTTP ${response.status}`);
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
      failures.push(`${endpoint}: ${error.message}`);
    } finally {
      clearTimeout(timeout);
    }
  }

  // Fallback: Nominatim
  try {
    const nominatimUrl =
      `https://nominatim.openstreetmap.org/search?` +
      new URLSearchParams({
        q: "tourist attraction",
        format: "json",
        limit: 20,
        addressdetails: 1,
        extratags: 1,
        namedetails: 1
      });

    const response = await fetch(nominatimUrl, {
      headers: { "User-Agent": "AppMySpareTime/1.0" }
    });

    const data = await response.json();

    const places = data.map(item => ({
      name: item.display_name,
      lat: Number(item.lat),
      lon: Number(item.lon),
      tags: item.extratags || {}
    }));

    if (places.length > 0) return places;
  } catch (fallbackError) {
    failures.push("Nominatim fallback failed: " + fallbackError.message);
  }

  throw new Error(`Place search failed. ${failures.join(" | ")}`);
}

// ======================================================
// GOOGLE MAPS URL
// ======================================================

function buildMapsUrl(origin, stops, transport) {
  const destination = stops[stops.length - 1];

  const waypoints =
    stops.length > 1
      ? stops.slice(0, -1).map(stop => `${stop.lat},${stop.lon}`).join("|")
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
    const origin = req.body.origin;
    const preferences = req.body.preferences || {};

    if (
      !origin ||
      typeof origin.latitude !== "number" ||
      typeof origin.longitude !== "number"
    ) {
      return res.status(400).json({
        error: "Please use your current location first."
      });
    }

    const distanceChoice = String(preferences.distance || "20");
    const radiusMiles =
      distanceChoice === "10" ? 10 :
      distanceChoice === "20" ? 20 :
      distanceChoice === "30" ? 30 :
      distanceChoice === "50" ? 50 :
      Infinity;

    const radiusMetres =
      radiusMiles === Infinity
        ? 50000
        : radiusMiles * 1609.34;

    const activityQuery = `
[out:json][timeout:20];
(
  nwr(around:${radiusMetres},${origin.latitude},${origin.longitude})["tourism"];
  nwr(around:${radiusMetres},${origin.latitude},${origin.longitude})["historic"];
  nwr(around:${radiusMetres},${origin.latitude},${origin.longitude})["leisure"];
  nwr(around:${radiusMetres},${origin.latitude},${origin.longitude})["natural"];
);
out center tags;
`;

    const foodQuery = `
[out:json][timeout:20];
(
  nwr(around:${radiusMetres},${origin.latitude},${origin.longitude})["amenity"~"restaurant|cafe|pub|fast_food"];
);
out center tags;
`;

    const [activities, foods] = await Promise.all([
      findPlaces(activityQuery),
      findPlaces(foodQuery)
    ]);

    const suitableActivities = activities
      .map(place => ({
        ...place,
        distance: distanceMiles(
          origin.latitude,
          origin.longitude,
          place.lat,
          place.lon
        )
      }))
      .filter(place =>
        radiusMiles === Infinity || place.distance <= radiusMiles
      )
      .sort((a, b) => a.distance - b.distance);

    if (!suitableActivities.length) {
      return res.status(404).json({
        error: "I couldn't find a suitable adventure nearby."
      });
    }

    const activity = suitableActivities[0];

    const suitableFoods = foods
      .map(place => ({
        ...place,
        distance: distanceMiles(
          origin.latitude,
          origin.longitude,
          place.lat,
          place.lon
        )
      }))
      .filter(place =>
        radiusMiles === Infinity || place.distance <= radiusMiles
      )
      .sort((a, b) => a.distance - b.distance);

    const food = suitableFoods[0] || null;

    const stops = food ? [activity, food] : [activity];

    const mapsUrl = buildMapsUrl(
      origin,
      stops,
      preferences.transport || "Car"
    );

    return res.json({
      title: "Your App My Spare Time Adventure",
      area: activity.name,
      summary: food
        ? `I've found ${activity.name} for your adventure, followed by ${food.name} for a meal.`
        : `I've found ${activity.name} as your adventure destination.`,
      activity: {
        name: activity.name,
        lat: activity.lat,
        lon: activity.lon,
        tags: activity.tags,
        distanceMiles: Math.round(activity.distance * 10) / 10
      },
      food: food
        ? {
            name: food.name,
            lat: food.lat,
            lon: food.lon,
            tags: food.tags,
            distanceMiles: Math.round(food.distance * 10) / 10
          }
        : null,
      duration: preferences.duration || "Flexible",
      stops: stops.length,
      mapsUrl,
      travelpayoutsUrl: TRAVELPAYOUTS_URL
    });
  } catch (error) {
    console.error("ADVENTURE BUILD ERROR:", error);
    return res.status(500).json({
      error: `Adventure Brain error: ${error.message}`
    });
  }
});

// ======================================================
// START SERVER
// ======================================================

app.listen(PORT, () => {
  console.log(`App My Spare Time running on port ${PORT}`);
});
