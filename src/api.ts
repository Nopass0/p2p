// src/api.ts
import { Elysia } from "elysia";
import { cors } from "@elysiajs/cors";
import { swagger } from "@elysiajs/swagger";
import rateRoutes from "./api/rate";
import transactionRoutes from "./api/transactions";
import payoutRoutes from "./api/payout";

const api = new Elysia()
  .use(cors())
  .use(
    swagger({
      documentation: {
        info: {
          title: "API Платежной Системы",
          version: "1.0.0",
          description: "API для обработки платежей и выплат",
        },
        tags: [
          { name: "Выплаты", description: "Операции с выплатами" },
          { name: "Курсы", description: "Операции с курсами валют" },
          { name: "Транзакции", description: "Операции с транзакциями" },
        ],
        components: {
          securitySchemes: {
            bearerAuth: {
              type: "http",
              scheme: "bearer",
              bearerFormat: "JWT",
              description: "Введите ваш токен доступа",
            },
          },
        },
      },
      swaggerOptions: {
        persistAuthorization: true,
      },
      path: "/docs",
      uiPath: "/docs/swagger",
      jsonPath: "/docs/json",
    }),
  )
  .use(rateRoutes)
  .use(transactionRoutes)
  .use(payoutRoutes)
  .group("/api", (api) =>
    api.get(
      "/",
      {
        detail: {
          summary: "Проверка статуса API",
          tags: ["Общее"],
          responses: {
            "200": {
              description: "Успешный ответ",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      status: {
                        type: "string",
                        example: "ok",
                        description: "Статус API",
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      () => ({ status: "ok" }),
    ),
  );

export default api;
