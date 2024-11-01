import api from "@/api";
import "@/api/rate";
import db from "@/db";
import { RateService } from "@/service/rate";
import telegramBot from "./bot";
import config from "./config";
import type { AnyError } from "./types";
import logger from "./utils/logger";

async function main() {
  try {
    //check db
    await db.$connect();
    logger.info("Database connected successfully");

    await RateService.updateRates();
    setInterval(() => RateService.updateRates(), config.RATE_UPDATE_INTERVAL);
    logger.info("Rate service initialized");

    //start api server
    await api.listen(config.PORT).on("error", (error: AnyError) => {
      logger.error("Failed to start server: ", error);
      process.exit(1);
    });
    logger.info(`🚀 Server running at http://localhost:${config.PORT}`);

    //start telegram bot
    await telegramBot.start();
    logger.info("Telegram bot started");
  } catch (error) {
    logger.error("Failed to start server: ", error);
    process.exit(1);
  }
}

main();
