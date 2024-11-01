// src/config.ts
import { z } from "zod";

const configSchema = z.object({
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
  PORT: z.string().transform(Number).default("3000"),
  DATABASE_URL: z.string(),
  TELEGRAM_BOT_TOKEN: z.string(),
  ADMIN_TELEGRAM_ID: z.string().transform(Number),
  PRIVATE_TOKEN: z.string(),
  UPLOAD_DIR: z.string().default("./uploads"),
  RATE_UPDATE_INTERVAL: z.string().transform(Number).default("300000"), // 5 минут
  TRANSACTION_TIMEOUT: z.string().transform(Number).default("900000"), // 15 минут
  MIN_PAYOUT_AMOUNT: z.coerce.number().default(100),
  MAX_PAYOUT_AMOUNT: z.coerce.number().default(1000000),
  PAYOUT_EXPIRES_IN: z.coerce.number().default(3600), // 1 час
  SCREENSHOT_MAX_SIZE: z.coerce.number().default(10 * 1024 * 1024), // 10MB
  ALLOWED_SCREENSHOT_TYPES: z
    .array(z.string())
    .default(["image/jpeg", "image/png", "image/webp"]),
});

const config = configSchema.parse({
  NODE_ENV: process.env.NODE_ENV,
  PORT: process.env.PORT,
  DATABASE_URL: process.env.DATABASE_URL,
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  ADMIN_TELEGRAM_ID: process.env.ADMIN_TELEGRAM_ID,
  PRIVATE_TOKEN: process.env.PRIVATE_TOKEN,
  UPLOAD_DIR: process.env.UPLOAD_DIR,
  RATE_UPDATE_INTERVAL: process.env.RATE_UPDATE_INTERVAL,
  TRANSACTION_TIMEOUT: process.env.TRANSACTION_TIMEOUT,
  MIN_PAYOUT_AMOUNT: process.env.MIN_PAYOUT_AMOUNT || 100,
  MAX_PAYOUT_AMOUNT: process.env.MAX_PAYOUT_AMOUNT || 1000000,
  PAYOUT_EXPIRES_IN: process.env.PAYOUT_EXPIRES_IN || 3600,
  SCREENSHOT_MAX_SIZE: process.env.SCREENSHOT_MAX_SIZE || 10 * 1024 * 1024,
  ALLOWED_SCREENSHOT_TYPES: process.env.ALLOWED_SCREENSHOT_TYPES?.split(
    ",",
  ) || ["image/jpeg", "image/png", "image/webp"],
});

export default config;
