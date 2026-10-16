import pino from "pino";
import { LOG_LEVEL, LOG_PRETTY, LISTENER_ID } from "./config";

const transport = LOG_PRETTY
  ? pino.transport({ target: "pino-pretty", options: { colorize: true, singleLine: false } })
  : undefined;

export const logger = pino(
  {
    level: LOG_LEVEL,
    base: { listenerId: LISTENER_ID, pid: process.pid },
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  transport
);

export function childLogger(module: string) {
  return logger.child({ module });
}
