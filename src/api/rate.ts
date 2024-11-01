// api/rate.ts
import { Elysia } from "elysia";
import { cache } from "@/utils/cache";
import db from "@/db";
import { z } from "zod";
import logger from "@/utils/logger";

const rateResponseSchema = z.object({
  rate: z.number(),
  timestamp: z.number(),
});

// Create a new Elysia instance without grouping yet
const rateRoutes = new Elysia().get("/api/rate", async ({ set }) => {
  try {
    // Try to get the rate from the cache
    const cachedRate = cache.get("rate:RUB:USDT");

    if (cachedRate !== undefined) {
      return rateResponseSchema.parse({
        rate: cachedRate,
        timestamp: Date.now(),
      });
    }

    // If not in cache, fetch the latest rate from the database
    const latestRate = await db.exchangeRate.findFirst({
      where: { from: "USDT", to: "RUB" },
      orderBy: { createdAt: "desc" },
    });

    if (latestRate) {
      return rateResponseSchema.parse({
        rate: latestRate.rate,
        timestamp: new Date(latestRate.createdAt).getTime(),
      });
    } else {
      set.status = 404;
      return { error: "Exchange rate not found" };
    }
  } catch (error) {
    logger.error("Error fetching exchange rate:", error);
    set.status = 500;
    return { error: "Internal Server Error" };
  }
});

export default rateRoutes;
