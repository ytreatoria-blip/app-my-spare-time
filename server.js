import express from "express";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static("public"));

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    app: "App My Spare Time",
    stage: "Adventure Brain v21"
  });
});

const adventures = [
  {
    title: "Hidden Heritage Loop",
    area: "A nearby historic area",
    summary:
      "A scenic walk with a heritage stop and a suitable food break."
  },
  {
    title: "Green & Curious",
    area: "A nearby countryside area",
    summary:
      "A nature walk, an unusual local attraction and a relaxed food stop."
  },
  {
    title: "Scenic Escape",
    area: "A nearby viewpoint area",
    summary:
      "A scenic route with a walk, photo stop and food break."
  }
];

app.post("/api/adventure/build", (req, res) => {
  const preferences = req.body.preferences || {};
  const origin = req.body.origin;

  if (!origin) {
    return res.status(400).json({
      error: "Please use your current location first."
    });
  }

  const adventure =
    adventures[Math.floor(Math.random() * adventures.length)];

  const transport =
    (preferences.transport || "Car").toLowerCase();

  let travelMode = "driving";

  if (transport === "bicycle") {
    travelMode = "bicycling";
  } else if (transport === "walking") {
    travelMode = "walking";
  }

  const mapsUrl =
    "https://www.google.com/maps/dir/?api=1" +
    `&origin=${origin.latitude},${origin.longitude}` +
    `&destination=${encodeURIComponent(adventure.area)}` +
    `&travelmode=${travelMode}`;

  res.json({
    title: adventure.title,
    area: adventure.area,
    summary: adventure.summary,
    duration:
      preferences.duration === "3h"
        ? "about 3 hours"
        : "your selected time",
    stops: 2,
    mapsUrl
  });
});

app.listen(PORT, () => {
  console.log(
    `App My Spare Time running on port ${PORT}`
  );
});
