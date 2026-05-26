import express from "express";
import cors from "cors";

import nhlRoutes from "./routes/nhl.route";
import oddsRoutes from "./routes/odds.route";
import opportunityRoutes from "./routes/opportunities.routes";

const app = express();

app.use(cors());
app.use(express.json());

app.use("/api/nhl", nhlRoutes);
app.use("/api/odds", oddsRoutes);
app.use("/api/opportunities", opportunityRoutes);

const PORT = 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});