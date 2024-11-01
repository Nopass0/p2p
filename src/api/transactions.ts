// api/transactions.ts
import { Elysia } from "elysia";
import { z } from "zod";
import db from "@/db";
import logger from "@/utils/logger";
import config from "@/config";
import { RateService } from "@/service/rate";
import { generateSignature } from "@/utils/signature";
// import { TelegramBot } from "@/bot";

const SCREENSHOT_TIMEOUT = 10 * 60 * 1000; // 10 минут в миллисекундах

const transactionRoutes = new Elysia()
  .post("/payout/create", async ({ body, set }) => {})
  .get("/payout/status", async ({ body, set }) => {})
  .get("/balance", async () => {
    const users = await db.user.findMany({
      select: {
        balance: true,
      },
    });

    const totalBalance = users.reduce((acc, user) => acc + user.balance, 0);

    return {
      total: totalBalance,
      users: users.length,
    };
  });

export default transactionRoutes;
