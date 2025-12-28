import winston from "winston"

/*
|--------------------------------------------------------------------------
| Logger Configuration
|--------------------------------------------------------------------------
| Centralized logging for application & HTTP logs
|--------------------------------------------------------------------------
*/

const { combine, timestamp, printf, colorize, errors } =
  winston.format

const logFormat = printf(
  ({ level, message, timestamp, stack }) =>
    `${timestamp} [${level}] ${stack || message
    }`
)

export const logger = winston.createLogger({
  level:
    process.env.NODE_ENV === "production"
      ? "info"
      : "debug",
  format: combine(
    errors({ stack: true }),
    timestamp(),
    logFormat
  ),
  transports: [
    new winston.transports.Console({
      format: combine(
        colorize(),
        timestamp(),
        logFormat
      ),
    }),
  ],
})

/*
|--------------------------------------------------------------------------
| Morgan Stream (HTTP Logging)
|--------------------------------------------------------------------------
| Allows: app.use(morgan("combined", { stream }))
|--------------------------------------------------------------------------
*/

export const morganStream = {
  write: (message: string) => {
    logger.info(message.trim())
  },
}