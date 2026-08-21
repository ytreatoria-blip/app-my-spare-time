import express from "express";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static("public"));

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    app: "App My Spare Time",
    stage: "PWA deployment"
  });
});

app.post("/api/adventure/build", (req, res) => {
  res.status(503).json({
    error: "Live Adventure Brain is being connected in the next build stage."
  });
});

app.listen(PORT, () => {
  console.log(`App My Spare Time running on port ${PORT}`);
});
