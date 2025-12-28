import cors, { CorsOptions } from "cors"

const allowedOrigins: string[] = [
  "http://localhost:3000",
  "http://localhost:5173",
  // "https://your-frontend.vercel.app",
]

export const corsOptions: CorsOptions = {
  origin: (origin, callback) => {
    // Allow server-to-server, Postman, curl
    if (!origin) {
      callback(null, true)
      return
    }

    if (allowedOrigins.includes(origin)) {
      callback(null, true)
      return
    }

    callback(new Error(`CORS blocked: ${origin}`))
  },

  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
}