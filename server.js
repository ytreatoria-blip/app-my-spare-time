import express from "express";


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
    "https://overpass-api.de/api/interpreter"
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

      const distanceChoice =
        String(
          preferences.distance || "20"
        );

      const radiusMiles =
        distanceChoice === "10" ? 10 :
        distanceChoice === "20" ? 20 :
        distanceChoice === "30" ? 30 :
        distanceChoice === "50" ? 50 :
        Infinity;

      const radiusMetres =
        radiusMiles === Infinity
          ? 100000
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
        findPlaces(activityQuery),
        findPlaces(foodQuery)
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

      const activity =
        suitableActivities[0];


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
          name:
            activity.name,

          distanceMiles:
            Math.round(
              activity.distance * 10
            ) / 10
        },

        food:
          food
            ? {
                name:
                  food.name,

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

        mapsUrl
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
