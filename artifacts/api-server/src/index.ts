import app from "./app";
import { logger } from "./lib/logger";
import { startTelegramBot } from "./lib/telegram-bot";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const telegramDisabled =
  process.env["TELEGRAM_BOT_DISABLED"] === "true" ||
  process.env["NODE_ENV"] === "development";
const telegramStop = telegramDisabled
    ? () => {
        logger.info("Telegram bot disabled for this API process");
      }
    : startTelegramBot();
const server = app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
});

function shutdown(signal: string) {
  logger.info({ signal }, "Shutting down");
  telegramStop();
  server.close(() => {
    void poolClose();
  });
}

async function poolClose() {
  const { pool } = await import("@workspace/db");
  await pool.end();
  process.exit(0);
}

process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));
