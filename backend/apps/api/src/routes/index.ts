import { Router } from "express"

// Import feature routes
import newsRoutes from "./news.routes"
// import marketRoutes from "./market.routes"
// import portfolioRoutes from "./portfolio.routes"
// import executionRoutes from "./execution.routes"
// import strategyRoutes from "./strategy.routes"

const router = Router()

/* ---------------- Feature Routes ---------------- */

// Health passthrough (optional)
router.get("/", (_req, res) => {
  res.json({ status: "api routes ok" })
})

router.use("/news", newsRoutes)
// router.use("/market", marketRoutes)
// router.use("/portfolio", portfolioRoutes)
// router.use("/execution", executionRoutes)
// router.use("/strategy", strategyRoutes)

export default router