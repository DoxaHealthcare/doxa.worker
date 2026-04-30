import { createLogger, format, transports } from "winston";
const { combine, timestamp, json } = format;

// Custom format for console logging with colors
const consoleLogFormat = format.combine(
  format.colorize(),
  format.timestamp(),
  format.printf((logs) => {
    const { timestamp, level, message, ...rest } = logs;
    return `${timestamp} ${level}: ${message} ${Object.keys(rest).length ? JSON.stringify(rest, null, 2) : ''}`;
  })
);

// Create a Winston logger
const logger = createLogger({
  level: 'debug', // Changed from 'info' to show all log levels
  format: combine(timestamp(), json()),
  transports: [
    new transports.Console({
      format: consoleLogFormat,
      level: 'debug'
    })
  ],
});

export default logger;
