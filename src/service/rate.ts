import db from "@/db";
import { cache } from "@/utils/cache";
import logger from "@/utils/logger";
import fetch from "node-fetch";
import { z } from "zod";

interface ExchangeRateFetcher {
  fetchRate(): Promise<number>;
}

class BinanceFetcher implements ExchangeRateFetcher {
  async fetchRate(): Promise<number> {
    const response = await fetch(
      "https://api.binance.com/api/v3/ticker/price?symbol=USDTRUB"
    );

    const schema = z.object({
      symbol: z.string(),
      price: z.string(),
    });

    const data = await response.json();
    const result = schema.safeParse(data);

    if (!result.success) {
      throw new Error("Invalid response from Binance API");
    }

    return parseFloat(result.data.price);
  }
}

class HuobiFetcher implements ExchangeRateFetcher {
  async fetchRate(): Promise<number> {
    const response = await fetch(
      "https://api.huobi.pro/market/detail/merged?symbol=usdtrub"
    );

    const schema = z.object({
      tick: z.object({
        bid: z.array(z.number()),
        ask: z.array(z.number()),
      }),
    });

    const data = await response.json();
    const result = schema.safeParse(data);

    if (!result.success) {
      throw new Error("Invalid response from Huobi API");
    }

    const bidPrice = result.data.tick.bid[0];
    const askPrice = result.data.tick.ask[0];
    return (bidPrice + askPrice) / 2;
  }
}

export class RateService {
  private static fetchers: ExchangeRateFetcher[] = [
    new BinanceFetcher(),
    new HuobiFetcher(),
  ];

  static async updateRates(): Promise<void> {
    try {
      const ratePromises = this.fetchers.map((fetcher) => fetcher.fetchRate());
      const results = await Promise.allSettled(ratePromises);

      const successfulRates = results
        .filter(
          (result): result is PromiseFulfilledResult<number> =>
            result.status === "fulfilled"
        )
        .map((result) => result.value);

      if (successfulRates.length === 0) {
        throw new Error("No exchange rates were fetched successfully");
      }

      const accurateRate = this.calculateAccurateRate(successfulRates);

      // Use upsert to handle unique constraint
      await db.exchangeRate.upsert({
        where: {
          from_to_source: {
            from: "USDT",
            to: "RUB",
            source: "COMBINED",
          },
        },
        update: {
          rate: accurateRate,
          createdAt: new Date(),
        },
        create: {
          from: "USDT",
          to: "RUB",
          rate: accurateRate,
          source: "COMBINED",
          createdAt: new Date(),
        },
      });

      cache.set("rate:RUB:USDT", accurateRate, 300_000);
      logger.info(`Updated exchange rate: 1 USDT = ${accurateRate} RUB`);
    } catch (error) {
      logger.error("Failed to update exchange rates:", error);
    }
  }

  private static calculateAccurateRate(rates: number[]): number {
    // Sort rates to calculate the median
    rates.sort((a, b) => a - b);
    const mid = Math.floor(rates.length / 2);

    return rates.length % 2 !== 0
      ? rates[mid]
      : (rates[mid - 1] + rates[mid]) / 2;
  }
}
