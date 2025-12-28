import http from "http"
import app from "./app"

const PORT = process.env.PORT || 3000

const server = http.createServer(app)

server.listen(PORT, () => {
  console.log(`🚀 API server running on port ${PORT}`)
})

/* Graceful shutdown (important for Render) */
process.on("SIGTERM", () => {
  console.log("SIGTERM received. Shutting down server.")
  server.close(() => {
    process.exit(0)
  })
})

process.on("SIGINT", () => {
  console.log("SIGINT received. Shutting down server.")
  server.close(() => {
    process.exit(0)
  })
})