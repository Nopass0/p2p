// src/api/payout.ts
import bot from "@/bot";
import config from "@/config";
import { validateBankId } from "@/constants/banks";
import db from "@/db";
import logger from "@/utils/logger";
import { randomUUID } from "crypto";
import { Elysia, t } from "elysia";
import { createReadStream, existsSync } from "fs";
import { join } from "node:path";

const createPayoutSchema = {
  body: t.Object({
    destination: t.String(),
    amount: t.Number(),
    walletId: t.String(),
    expiredTime: t.Number(),
    expiredOfferTime: t.Number(),
    sbp_bank: t.Optional(t.String()),
    callback_url: t.String(),
  }),
  headers: t.Object({
    token: t.String(),
  }),
};

const checkStatusSchema = {
  body: t.Object({
    clientUniqueId: t.String(),
  }),
  headers: t.Object({
    token: t.String(),
  }),
};

// Функция генерации уникального ID
const generateUniqueId = () => `TX_${randomUUID()}`;

// Функция валидации времени
const validateTimes = (
  expiredTime: number,
  expiredOfferTime: number,
): boolean => {
  // Убираем проверку с текущим временем для будущих дат
  return (
    expiredTime < expiredOfferTime && // expiredTime должен быть меньше expiredOfferTime
    expiredTime > 0 && // проверяем, что метки положительные
    expiredOfferTime > 0
  );
};

// Функция валидации суммы
const validateAmount = (amount: number): boolean => {
  return (
    amount >= config.MIN_PAYOUT_AMOUNT && amount <= config.MAX_PAYOUT_AMOUNT
  );
};

const payoutRoutes = new Elysia({ prefix: "/api" })
  .use((app) => {
    app.derive(({ headers }) => {
      if (headers.token !== config.PRIVATE_TOKEN) {
        throw new Error("Неверный токен авторизации");
      }
      return {};
    });
    return app;
  })
  .post(
    "/payout/create",
    async ({ body, set }) => {
      try {
        // Валидация банка
        if (!validateBankId(body.walletId)) {
          set.status = 400;
          return {
            external_id: "",
            status: 2,
            reason: "Неподдерживаемый метод выплаты",
            code: 400,
          };
        }

        // Валидация суммы
        if (!validateAmount(body.amount)) {
          set.status = 400;
          return {
            external_id: "",
            status: 2,
            reason: `Сумма должна быть от ${config.MIN_PAYOUT_AMOUNT} до ${config.MAX_PAYOUT_AMOUNT} RUB`,
            code: 400,
          };
        }

        // Валидация времени
        if (!validateTimes(body.expiredTime, body.expiredOfferTime)) {
          set.status = 400;
          return {
            external_id: "",
            status: 2,
            reason: "Неверные временные метки",
            code: 400,
          };
        }

        // Генерируем уникальный ID для транзакции
        const clientUniqueId = generateUniqueId();

        // Создаем транзакцию в базе данных
        const transaction = await db.transaction.create({
          data: {
            id: clientUniqueId,
            amount: body.amount,
            status: "PENDING",
            currency: "RUB",
            paymentMethod: body.walletId,
            destination: body.destination,
            callbackUrl: body.callback_url,
            metadata: {
              sbp_bank: body.sbp_bank,
              expiredTime: body.expiredTime,
            },
            expiresAt: new Date(body.expiredOfferTime * 1000),
          },
        });

        // Получаем список активных операторов
        const operators = await db.user.findMany({
          where: {
            isAdmin: true,
            // Можно добавить дополнительные условия, например:
            balance: { gte: body.amount }, // только операторы с достаточным балансом
          },
        });

        if (operators.length === 0) {
          // Если нет доступных операторов, отменяем транзакцию
          await db.transaction.update({
            where: { id: clientUniqueId },
            data: { status: "FAILED" },
          });

          set.status = 503;
          return {
            external_id: clientUniqueId,
            status: 2,
            reason: "Нет доступных операторов",
            code: 503,
          };
        }

        // Отправляем уведомления операторам
        for (const operator of operators) {
          await bot.sendPayoutRequest(operator.telegramId, {
            transactionId: transaction.id,
            amount: body.amount,
            destination: body.destination,
            walletId: body.walletId,
            expiresAt: transaction.expiresAt,
          });
        }

        // Устанавливаем таймер на отмену транзакции
        setTimeout(
          async () => {
            const expiredTransaction = await db.transaction.findUnique({
              where: { id: clientUniqueId },
            });

            if (expiredTransaction && expiredTransaction.status === "PENDING") {
              await db.transaction.update({
                where: { id: clientUniqueId },
                data: { status: "EXPIRED" },
              });

              // Отправляем уведомление на callback_url
              if (body.callback_url) {
                try {
                  await fetch(body.callback_url, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      external_id: clientUniqueId,
                      status: 3,
                      reason: "Transaction expired",
                    }),
                  });
                } catch (error) {
                  logger.error("Failed to send callback notification:", error);
                }
              }
            }
          },
          (body.expiredOfferTime - Math.floor(Date.now() / 1000)) * 1000,
        );

        return {
          external_id: transaction.id,
          status: 1,
          reason: "",
          code: 0,
        };
      } catch (error) {
        logger.error("Error creating payout:", error);
        set.status = 500;
        return {
          external_id: "",
          status: 2,
          reason: "Внутренняя ошибка сервера",
          code: 500,
        };
      }
    },
    {
      body: createPayoutSchema.body,
      headers: createPayoutSchema.headers,
      detail: {
        tags: ["Выплаты"],
        summary: "Создание новой выплаты",
        description:
          "Создает новую заявку на выплату и отправляет её операторам",
        security: [{ bearerAuth: [] }],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: [
                  "destination",
                  "amount",
                  "walletId",
                  "expiredTime",
                  "expiredOfferTime",
                  "callback_url",
                ],
                properties: {
                  destination: {
                    type: "string",
                    description: "Номер карты или счета получателя",
                    example: "4276123456789012",
                  },
                  amount: {
                    type: "number",
                    description: "Сумма перевода в рублях",
                    minimum: config.MIN_PAYOUT_AMOUNT,
                    maximum: config.MAX_PAYOUT_AMOUNT,
                    example: 1000.5,
                  },
                  walletId: {
                    type: "string",
                    description: "Название банка или платежной системы",
                    example: "sberbank",
                    enum: [
                      "sberbank",
                      "tinkoff",
                      "vtb",
                      "alfa",
                      "gazprombank",
                      "interbank",
                      "mts_bank",
                      "ozon_bank",
                      "open",
                      "post_bank",
                      "psb",
                      "raiffeisen",
                      "rosbank",
                      "rstb",
                      "sbp",
                      "sovkom",
                      "uralsib",
                      "account_number",
                      "humo_uzs",
                      "ziraat",
                      "papara",
                      "uz_card",
                      "kapital",
                      "garanti",
                      "enpara",
                      "kuveyt",
                      "ininal",
                      "iban",
                    ],
                  },
                  expiredTime: {
                    type: "number",
                    description:
                      "Время в Unix формате для добавления транзакции",
                    example: 1678901234,
                  },
                  expiredOfferTime: {
                    type: "number",
                    description:
                      "Время в Unix формате для истечения транзакции",
                    example: 1678902234,
                  },
                  sbp_bank: {
                    type: "string",
                    description: "Банк для СБП перевода (опционально)",
                    example: "tinkoff",
                  },
                  callback_url: {
                    type: "string",
                    description: "URL для уведомлений о статусе транзакции",
                    example: "https://api.example.com/callback",
                  },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Успешное создание выплаты",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    external_id: {
                      type: "string",
                      description:
                        "Автоматически сгенерированный идентификатор транзакции",
                      example: "TX_550e8400-e29b-41d4-a716-446655440000",
                    },
                    status: {
                      type: "number",
                      description: "Статус операции (1 - успешно, 2 - ошибка)",
                      example: 1,
                    },
                    reason: {
                      type: "string",
                      description: "Причина ошибки (если есть)",
                      example: "",
                    },
                    code: {
                      type: "number",
                      description: "Код ошибки (0 - нет ошибки)",
                      example: 0,
                    },
                  },
                },
              },
            },
          },
          "400": {
            description: "Ошибка валидации",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    external_id: {
                      type: "string",
                      example: "",
                    },
                    status: {
                      type: "number",
                      example: 2,
                    },
                    reason: {
                      type: "string",
                      example: "Неверные параметры запроса",
                    },
                    code: {
                      type: "number",
                      example: 400,
                    },
                  },
                },
              },
            },
          },
          "500": {
            description: "Внутренняя ошибка сервера",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    external_id: {
                      type: "string",
                      example: "",
                    },
                    status: {
                      type: "number",
                      example: 2,
                    },
                    reason: {
                      type: "string",
                      example: "Внутренняя ошибка сервера",
                    },
                    code: {
                      type: "number",
                      example: 500,
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  )
  .get(
    "/payout/screenshot/:filename",
    async ({ params, set }) => {
      try {
        const filePath = join(config.UPLOAD_DIR, params.filename);

        // Проверяем существование файла
        if (!existsSync(filePath)) {
          set.status = 404;
          return {
            error: "Screenshot not found",
            code: 404,
          };
        }

        // Проверяем, что файл принадлежит существующей транзакции
        // Извлекаем ID транзакции из имени файла
        const txIdMatch = params.filename.match(/TX_[a-f0-9-]+/);
        if (!txIdMatch) {
          set.status = 400;
          return {
            error: "Invalid filename format",
            code: 400,
          };
        }

        const transactionId = txIdMatch[0];
        const screenshot = await db.screenshot.findFirst({
          where: {
            path: params.filename,
            transaction: {
              id: transactionId,
            },
          },
        });

        if (!screenshot) {
          set.status = 404;
          return {
            error: "Screenshot record not found",
            code: 404,
          };
        }

        // Определяем тип файла
        const fileExt = params.filename.split(".").pop()?.toLowerCase();
        const mimeTypes: { [key: string]: string } = {
          jpg: "image/jpeg",
          jpeg: "image/jpeg",
          png: "image/png",
          webp: "image/webp",
        };

        const contentType =
          mimeTypes[fileExt || ""] || "application/octet-stream";

        // Устанавливаем заголовки
        set.headers["Content-Type"] = contentType;
        set.headers["Content-Disposition"] =
          `inline; filename="${params.filename}"`;

        // Создаем поток для чтения файла
        const fileStream = createReadStream(filePath);
        return fileStream;
      } catch (error) {
        logger.error("Error serving screenshot:", error);
        set.status = 500;
        return {
          error: "Internal server error",
          code: 500,
        };
      }
    },
    {
      params: t.Object({
        filename: t.String(),
      }),
      detail: {
        tags: ["Выплаты"],
        summary: "Получение скриншота",
        description: "Возвращает файл скриншота по его имени",
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            in: "path",
            name: "filename",
            description: "Имя файла скриншота",
            required: true,
            schema: {
              type: "string",
              example:
                "1730449671857_TX_dd155dd9-a2c3-4dde-8286-12e99414c5fd.jpg",
            },
          },
        ],
        responses: {
          "200": {
            description: "Файл скриншота",
            content: {
              "image/jpeg": {
                schema: {
                  type: "string",
                  format: "binary",
                },
              },
              "image/png": {
                schema: {
                  type: "string",
                  format: "binary",
                },
              },
              "image/webp": {
                schema: {
                  type: "string",
                  format: "binary",
                },
              },
            },
          },
          "404": {
            description: "Скриншот не найден",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    error: {
                      type: "string",
                      example: "Screenshot not found",
                    },
                    code: {
                      type: "number",
                      example: 404,
                    },
                  },
                },
              },
            },
          },
          "500": {
            description: "Внутренняя ошибка сервера",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    error: {
                      type: "string",
                      example: "Internal server error",
                    },
                    code: {
                      type: "number",
                      example: 500,
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  )
  .post(
    "/payout/status",
    async ({ body, set }) => {
      try {
        const transaction = await db.transaction.findUnique({
          where: { id: body.clientUniqueId },
          include: { screenshot: true },
        });

        if (!transaction) {
          set.status = 404;
          return {
            clientUniqueId: body.clientUniqueId,
            status: 3,
            amount: 0,
            amountPaid: 0,
            receipt: "",
            reason: "Транзакция не найдена",
            code: 404,
            screenshot: "",
          };
        }

        const status =
          {
            PENDING: 1,
            ACCEPTED: 1,
            COMPLETED: 2,
            FAILED: 3,
            EXPIRED: 3,
            CANCELLED: 3,
          }[transaction.status] || 3;

        return {
          clientUniqueId: transaction.id,
          status,
          amount: transaction.amount,
          amountPaid:
            transaction.status === "COMPLETED" ? transaction.amount : 0,
          receipt: "",
          reason: transaction.status === "COMPLETED" ? "" : transaction.status,
          code: 0,
          screenshot: transaction.screenshot?.path || "",
        };
      } catch (error) {
        logger.error("Error checking payout status:", error);
        set.status = 500;
        return {
          clientUniqueId: body.clientUniqueId,
          status: 3,
          amount: 0,
          amountPaid: 0,
          receipt: "",
          reason: "Внутренняя ошибка сервера",
          code: 500,
          screenshot: "",
        };
      }
    },
    {
      body: checkStatusSchema.body,
      headers: checkStatusSchema.headers,
      detail: {
        tags: ["Выплаты"],
        summary: "Проверка статуса выплаты",
        description: "Возвращает текущий статус выплаты по её идентификатору",
        security: [{ bearerAuth: [] }],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["clientUniqueId"],
                properties: {
                  clientUniqueId: {
                    type: "string",
                    description: "Уникальный идентификатор транзакции",
                    example: "TX_550e8400-e29b-41d4-a716-446655440000",
                  },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Успешное получение статуса",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    clientUniqueId: {
                      type: "string",
                      description: "Идентификатор транзакции",
                      example: "TX_550e8400-e29b-41d4-a716-446655440000",
                    },
                    status: {
                      type: "number",
                      description:
                        "Статус транзакции (1 - в обработке, 2 - выполнено, 3 - ошибка)",
                      example: 2,
                    },
                    amount: {
                      type: "number",
                      description: "Сумма к выплате",
                      example: 1000.5,
                    },
                    amountPaid: {
                      type: "number",
                      description: "Фактически выплаченная сумма",
                      example: 1000.5,
                    },
                    receipt: {
                      type: "string",
                      description: "Ссылка на чек (если есть)",
                      example: "https://example.com/receipts/123",
                    },
                    reason: {
                      type: "string",
                      description: "Причина ошибки или статус (если есть)",
                      example: "",
                    },
                    code: {
                      type: "number",
                      description: "Код ошибки (0 - нет ошибки)",
                      example: 0,
                    },
                    screenshot: {
                      type: "string",
                      description: "Ссылка на скриншот подтверждения",
                      example: "https://example.com/screenshots/123.jpg",
                    },
                  },
                },
              },
            },
          },
          "404": {
            description: "Транзакция не найдена",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    clientUniqueId: {
                      type: "string",
                      example: "TX_550e8400-e29b-41d4-a716-446655440000",
                    },
                    status: {
                      type: "number",
                      example: 3,
                    },
                    amount: {
                      type: "number",
                      example: 0,
                    },
                    amountPaid: {
                      type: "number",
                      example: 0,
                    },
                    receipt: {
                      type: "string",
                      example: "",
                    },
                    reason: {
                      type: "string",
                      example: "Транзакция не найдена",
                    },
                    code: {
                      type: "number",
                      example: 404,
                    },
                    screenshot: {
                      type: "string",
                      example: "",
                    },
                  },
                },
              },
            },
          },
          "500": {
            description: "Внутренняя ошибка сервера",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    clientUniqueId: {
                      type: "string",
                      example: "TX_550e8400-e29b-41d4-a716-446655440000",
                    },
                    status: {
                      type: "number",
                      example: 3,
                    },
                    amount: {
                      type: "number",
                      example: 0,
                    },
                    amountPaid: {
                      type: "number",
                      example: 0,
                    },
                    receipt: {
                      type: "string",
                      example: "",
                    },
                    reason: {
                      type: "string",
                      example: "Внутренняя ошибка сервера",
                    },
                    code: {
                      type: "number",
                      example: 500,
                    },
                    screenshot: {
                      type: "string",
                      example: "",
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  );

export default payoutRoutes;
