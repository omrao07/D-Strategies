import http from "http"
import app from "./app"

const PORT = Number(process.env.PORT) || 3000

const server = http.createServer(app)

server.listen(PORT, () => {
  console.log(`🚀 API server running on port ${PORT}`)
})

/* ---------------- Graceful Shutdown ---------------- */

const shutdown = () => {
  console.log("Shutting down server...")
  server.close(() => {
    process.exit(0)
  })
}

process.on("SIGTERM", shutdown)
process.on("SIGINT", shutdown)