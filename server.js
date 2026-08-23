import express from "express";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static("public"));

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    app: "App My Spare Time",
    stage: "Adventure Brain v22"
  });
});


  async function findPlaces(latitude, longitude, radius, query) {
  const endpoints = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.private.coffee/api/interpreter"
  ];

  for (const endpoint of endpoints) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);

      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "AppMySpareTime/23"
        },
        body: new URLSearchParams({
          data: query
        }),
        signal: controller.signal
      });

      clearTimeout(timeout);

      if (!response.ok) {
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
      console.log(`Place search failed at ${endpoint}:`, error);
    }
  }

  throw new Error("Place search is temporarily unavailable.");
  }

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

    const radius =
      preferences.distance === "10" ? 16000 :
      preferences.distance === "20" ? 32000 :
      preferences.distance === "30" ? 48000 :
      preferences.distance === "50" ? 80000 :
      120000;

    const activityQuery = `
      [out:json][timeout:25];
      (
        nwr(around:${radius},${origin.latitude},${origin.longitude})
          ["tourism"~"attraction|museum|gallery|viewpoint|zoo|theme_park|heritage"];
        nwr(around:${radius},${origin.latitude},${origin.longitude})
          ["historic"];
        nwr(around:${radius},${origin.latitude},${origin.longitude})
          ["leisure"~"park|nature_reserve|garden"];
        nwr(around:${radius},${origin.latitude},${origin.longitude})
          ["natural"~"beach|peak|waterfall|wood"];
      );
      out center tags;
    `;

    const foodQuery = `
      [out:json][timeout:25];
      (
        nwr(around:${radius},${origin.latitude},${origin.longitude})
          ["amenity"~"restaurant|cafe|pub|fast_food"];
      );
      out center tags;
    `;

    const [activities, foods] = await Promise.all([
      findPlaces(
        origin.latitude,
        origin.longitude,
        radius,
        activityQuery
      ),
      findPlaces(
        origin.latitude,
        origin.longitude,
        radius,
        foodQuery
      )
    ]);

    const maxMiles =
      preferences.distance === "any"
        ? Infinity
        : Number(preferences.distance || 20);

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
      .filter(place => place.distance <= maxMiles)
      .sort((a, b) => a.distance - b.distance);

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
      .filter(place => place.distance <= maxMiles)
      .sort((a, b) => a.distance - b.distance);

    if (!suitableActivities.length) {
      return res.status(404).json({
        error:
          "I couldn't find a suitable adventure nearby. Try increasing the distance."
      });
    }

    const activity = suitableActivities[0];

    let food = null;

    if (suitableFoods.length) {
      const requestedFood =
        String(preferences.food || "").toLowerCase();

      food =
        suitableFoods.find(place => {
          const tags = JSON.stringify(place.tags).toLowerCase();

          if (
            requestedFood.includes("pub") &&
            tags.includes("pub")
          ) return true;

          if (
            requestedFood.includes("cafe") &&
            tags.includes("cafe")
          ) return true;

          if (
            requestedFood.includes("restaurant") &&
            tags.includes("restaurant")
          ) return true;

          return requestedFood === "anything";
        }) || suitableFoods[0];
    }

    const waypoints = food
      ? `&waypoints=${activity.lat},${activity.lon}|${food.lat},${food.lon}`
      : `&destination=${activity.lat},${activity.lon}`;

    const destination = food
      ? `&destination=${food.lat},${food.lon}`
      : "";

    const transport =
      String(preferences.transport || "Car").toLowerCase();

    const travelMode =
      transport === "walking"
        ? "walking"
        : transport === "bicycle"
        ? "bicycling"
        : "driving";

    const mapsUrl =
      "https://www.google.com/maps/dir/?api=1" +
      `&origin=${origin.latitude},${origin.longitude}` +
      destination +
      waypoints +
      `&travelmode=${travelMode}`;

    const stops = food ? 2 : 1;

    res.json({
      title: "Your App My Spare Time Adventure",
      area: activity.name,
      summary:
        food
          ? `I've found ${activity.name} for your adventure, followed by ${food.name} for a food stop.`
          : `I've found ${activity.name} as your adventure destination.`,
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
      duration:
        preferences.duration === "3h"
          ? "about 3 hours"
          : "your selected time",
      stops,
      mapsUrl
    });

  } catch (error) {
    console.error(error);

    res.status(500).json({
      error:
        "The Adventure Brain couldn't search for places right now. Please try again."
    });
  }
});



app.listen(PORT, () => {
  console.log(
    `App My Spare Time running on port ${PORT}`
  );
});
