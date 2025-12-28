import express from "express"
import morgan from "morgan"
import cors from "cors"
import routes from "./routes"

const app = express()

/* ---------------- Middleware ---------------- */

app.use(express.json({ limit: "2mb" }))
app.use(express.urlencoded({ extended: true }))
app.use(morgan("dev"))

app.use(
  cors({
    origin: [
      "http://localhost:3000",
      "http://localhost:5173",
      "https://your-frontend.vercel.app",
    ],
    credentials: true,
  })
)

/* ---------------- Health Check ---------------- */

app.get("/health", (_req, res) => {
  res.json({ status: "ok" })
})

/* ---------------- Routes ---------------- */

app.use("/api", routes)

/* ---------------- Error Handling ---------------- */

app.use((_req, res) => {
  res.status(404).json({ error: "Route not found" })
})

app.use(
  (
    err: any,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction
  ) => {
    console.error(err)
    res.status(500).json({ error: "Internal server error" })
  }
)

export default app