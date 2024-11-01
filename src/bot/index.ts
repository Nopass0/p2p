import { Telegraf, Context, Markup } from "telegraf";
import type { Message, Update } from "telegraf/types";
import config from "@/config";
import db from "@/db";
import logger from "@/utils/logger";
import { getBankName } from "@/constants/banks";
import { createWriteStream, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { pipeline } from "stream/promises";
import fetch from "node-fetch";

interface UserState {
  awaitingBalance: boolean;
  awaitingOperatorId: boolean;
  awaitingScreenshot: boolean;
  currentTransactionId?: string;
}

interface BotContext extends Context {
  state: {
    isAdmin: boolean;
    isOperator: boolean;
  };
}

export class TelegramBot {
  private bot: Telegraf<BotContext>;
  private userStates: Map<number, UserState>;
  private transactionMappings: Map<string, string>; // Для хранения соответствия ID

  constructor() {
    this.bot = new Telegraf<BotContext>(config.TELEGRAM_BOT_TOKEN);
    this.userStates = new Map();
    this.transactionMappings = new Map();
    this.setupMiddleware();
    this.setupHandlers();

    // Создаем директорию для загрузки файлов, если её нет
    if (!existsSync(config.UPLOAD_DIR)) {
      mkdirSync(config.UPLOAD_DIR, { recursive: true });
    }
  }

  private async setupMiddleware(): Promise<void> {
    this.bot.use(async (ctx, next) => {
      if (!ctx.from) return;

      const user = await db.user.findUnique({
        where: { telegramId: BigInt(ctx.from.id) },
      });

      ctx.state = {
        isAdmin: ctx.from.id === config.ADMIN_TELEGRAM_ID,
        isOperator: Boolean(user?.isAdmin),
      };

      if (!user && ctx.from.id !== config.ADMIN_TELEGRAM_ID) {
        await db.user.create({
          data: {
            telegramId: BigInt(ctx.from.id),
            username: ctx.from.username || undefined,
            isAdmin: false,
          },
        });
      }

      return next();
    });
  }

  private getMainKeyboard(isAdmin: boolean, isOperator: boolean) {
    const buttons = [];

    if (isOperator) {
      buttons.push([
        Markup.button.callback("💰 Мой баланс", "check_balance"),
        Markup.button.callback("💵 Установить баланс", "set_balance"),
      ]);
    }

    if (isAdmin) {
      buttons.push([
        Markup.button.callback("👥 Список операторов", "list_operators"),
        Markup.button.callback("➕ Добавить оператора", "add_operator"),
      ]);
      buttons.push([
        Markup.button.callback("📊 Статистика", "statistics"),
        Markup.button.callback("⚙️ Настройки", "settings"),
      ]);
    }

    buttons.push([Markup.button.callback("ℹ️ Помощь", "help")]);

    return Markup.inlineKeyboard(buttons);
  }

  private getCancelKeyboard() {
    return Markup.inlineKeyboard([
      [Markup.button.callback("❌ Отмена", "cancel_action")],
    ]);
  }

  public async sendPayoutRequest(
    operatorId: bigint,
    payoutData: {
      transactionId: string;
      amount: number;
      destination: string;
      walletId: string;
      expiresAt: Date;
    },
  ): Promise<void> {
    try {
      // Сокращаем ID транзакции до первых 8 символов после TX_
      const shortTxId = payoutData.transactionId.substring(0, 11);
      // Сокращаем номер карты, оставляем только последние 4 цифры
      const shortDestination = payoutData.destination.slice(-4);

      const message = `
  💰 *Новая заявка на выплату*

  💵 Сумма: *${payoutData.amount.toLocaleString("ru-RU")}* RUB
  🏦 Банк: *${getBankName(payoutData.walletId)}*
  ⏱ Срок: *${payoutData.expiresAt.toLocaleString("ru-RU")}*
  🆔 ID: *${payoutData.transactionId}*
  `;

      const keyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback(
            "✅ Принять",
            `ap:${shortTxId}:${shortDestination}`, // Сокращенный формат данных
          ),
        ],
      ]);

      const result = await this.bot.telegram.sendMessage(
        Number(operatorId),
        message,
        {
          parse_mode: "Markdown",
          ...keyboard,
        },
      );

      // Сохраняем соответствие короткого и полного ID в памяти или базе данных
      await this.saveTransactionMapping(shortTxId, payoutData.transactionId);

      logger.info(
        `Successfully sent payout request to operator ${operatorId}`,
        {
          operatorId,
          transactionId: payoutData.transactionId,
          messageId: result.message_id,
        },
      );
    } catch (error) {
      logger.error(`Error sending payout request to operator ${operatorId}:`, {
        operatorId,
        transactionId: payoutData.transactionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Добавьте методы для работы с маппингом ID
  private async saveTransactionMapping(
    shortId: string,
    fullId: string,
  ): Promise<void> {
    // Можно использовать Map в памяти или сохранять в базу данных
    this.transactionMappings.set(shortId, fullId);
  }

  private async getFullTransactionId(
    shortId: string,
  ): Promise<string | undefined> {
    return this.transactionMappings.get(shortId);
  }

  private async showMainMenu(ctx: BotContext): Promise<void> {
    if (!ctx.from) return;

    const username = ctx.from.first_name || "пользователь";
    let message = "";

    if (ctx.state.isAdmin) {
      message =
        `🎉 Добро пожаловать, ${username}!\n\n` +
        `👑 Панель управления администратора\n` +
        `\nВыберите действие:`;
    } else if (ctx.state.isOperator) {
      message =
        `🎉 Добро пожаловать, ${username}!\n\n` +
        `🔧 Панель управления оператора\n` +
        `\nВыберите действие:`;
    } else {
      message =
        `⛔️ Доступ запрещен\n\n` +
        `У вас нет необходимых прав для использования бота.`;
    }

    await ctx.reply(message, {
      parse_mode: "HTML",
      ...this.getMainKeyboard(ctx.state.isAdmin, ctx.state.isOperator),
    });
  }

  private async handleAcceptPayout(
    ctx: BotContext,
    transactionId: string,
    destination: string,
  ): Promise<void> {
    if (!ctx.from) return;

    try {
      // Логируем начало обработки
      logger.info(`Starting accept payout process`, {
        operatorId: ctx.from.id,
        transactionId: transactionId,
      });

      // Проверяем транзакцию с подробным логированием
      const transaction = await db.transaction.findUnique({
        where: { id: transactionId },
      });

      logger.info(`Transaction status check`, {
        transactionId,
        currentStatus: transaction?.status,
        userId: transaction?.userId,
      });

      if (!transaction) {
        await ctx.reply("❌ Заявка не найдена");
        return;
      }

      // Проверяем статус и наличие привязанного пользователя
      if (transaction.status !== "PENDING") {
        logger.info(`Invalid transaction status`, {
          transactionId,
          status: transaction.status,
        });
        await ctx.reply("❌ Эта заявка уже не активна (неверный статус)");
        return;
      }

      // Находим пользователя
      const user = await db.user.findUnique({
        where: { telegramId: BigInt(ctx.from.id) },
      });

      if (!user) {
        logger.error(`User not found`, {
          telegramId: ctx.from.id,
        });
        await ctx.reply("❌ Ошибка: пользователь не найден");
        return;
      }

      // Обновляем транзакцию с использованием транзакции Prisma
      const updatedTransaction = await db.$transaction(async (prisma) => {
        // Перепроверяем статус транзакции
        const currentTransaction = await prisma.transaction.findUnique({
          where: { id: transactionId },
        });

        if (!currentTransaction || currentTransaction.status !== "PENDING") {
          throw new Error("Transaction is no longer available");
        }

        // Обновляем транзакцию
        return prisma.transaction.update({
          where: { id: transactionId },
          data: {
            userId: user.id,
            status: "ACCEPTED",
            destination: destination,
          },
        });
      });

      logger.info(`Transaction successfully accepted`, {
        transactionId,
        operatorId: ctx.from.id,
        newStatus: updatedTransaction.status,
      });

      // Сохраняем состояние ожидания скриншота
      this.userStates.set(ctx.from.id, {
        awaitingBalance: false,
        awaitingOperatorId: false,
        awaitingScreenshot: true,
        currentTransactionId: transactionId,
      });

      // Отправляем реквизиты и инструкции оператору
      await ctx.reply(
        `✅ Заявка успешно принята!\n\n` +
          `💳 Реквизиты получателя:\n` +
          `\`${destination}\`\n\n` +
          `После выполнения перевода отправьте скриншот чека об оплате.`,
        {
          parse_mode: "Markdown",
          reply_markup: this.getCancelKeyboard().reply_markup,
        },
      );

      // Удаляем кнопку "Принять" из оригинального сообщения
      if (ctx.callbackQuery && "message" in ctx.callbackQuery) {
        await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
      }
    } catch (error) {
      logger.error(`Error in handleAcceptPayout`, {
        error: error instanceof Error ? error.message : String(error),
        transactionId,
        operatorId: ctx.from.id,
      });

      if (
        error instanceof Error &&
        error.message === "Transaction is no longer available"
      ) {
        await ctx.reply("❌ Эта заявка уже недоступна");
      } else {
        await ctx.reply("❌ Произошла ошибка при принятии заявки");
      }
    }
  }

  private async handleScreenshotUpload(
    ctx: BotContext & {
      message: Message.PhotoMessage | Message.DocumentMessage;
    },
  ): Promise<void> {
    if (!ctx.from) return;

    const userState = this.userStates.get(ctx.from.id);
    if (!userState?.awaitingScreenshot || !userState.currentTransactionId) {
      return;
    }

    try {
      let fileId: string;
      if ("photo" in ctx.message) {
        // Берем последнее (самое качественное) фото
        fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
      } else if ("document" in ctx.message) {
        fileId = ctx.message.document.file_id;
      } else {
        await ctx.reply("❌ Пожалуйста, отправьте изображение или документ.");
        return;
      }

      // Получаем информацию о файле
      const file = await ctx.telegram.getFile(fileId);
      if (!file.file_path) {
        await ctx.reply("❌ Не удалось получить файл.");
        return;
      }

      // Формируем путь для сохранения файла
      const fileExt = file.file_path.split(".").pop() || "jpg";
      const fileName = `${Date.now()}_${userState.currentTransactionId}.${fileExt}`;
      const filePath = join(config.UPLOAD_DIR, fileName);

      // Скачиваем и сохраняем файл
      const fileUrl = `https://api.telegram.org/file/bot${config.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
      const response = await fetch(fileUrl);
      if (!response.ok) throw new Error("Failed to download file");

      const fileStream = createWriteStream(filePath);
      await pipeline(response.body!, fileStream);

      // Создаем запись о скриншоте в базе данных
      const user = await db.user.findUnique({
        where: { telegramId: BigInt(ctx.from.id) },
      });

      if (!user) {
        await ctx.reply("❌ Пользователь не найден");
        return;
      }

      await db.screenshot.create({
        data: {
          path: fileName,
          transactionId: userState.currentTransactionId,
          userId: user.id,
        },
      });

      // Обновляем статус транзакции
      await db.transaction.update({
        where: { id: userState.currentTransactionId },
        data: { status: "COMPLETED" },
      });

      // Сбрасываем состояние пользователя
      this.userStates.set(ctx.from.id, {
        awaitingBalance: false,
        awaitingOperatorId: false,
        awaitingScreenshot: false,
      });

      await ctx.reply(
        "✅ Скриншот успешно загружен!\n" +
          "Транзакция помечена как завершенная.",
      );

      // Отправляем уведомление администратору
      if (config.ADMIN_TELEGRAM_ID) {
        await this.bot.telegram.sendMessage(
          config.ADMIN_TELEGRAM_ID,
          `🔔 Новый скриншот загружен\n` +
            `Транзакция: ${userState.currentTransactionId}\n` +
            `Оператор: ${ctx.from.username || ctx.from.id}`,
        );
      }
    } catch (error) {
      logger.error("Error handling screenshot:", error);
      await ctx.reply("❌ Произошла ошибка при загрузке скриншота");
    }
  }

  private async handleCheckBalance(ctx: BotContext): Promise<void> {
    if (!ctx.from) return;

    try {
      const user = await db.user.findUnique({
        where: { telegramId: BigInt(ctx.from.id) },
      });

      if (!user) {
        await ctx.reply("❌ Пользователь не найден");
        return;
      }

      await ctx.reply(
        `💰 *Информация о балансе*\n\n` +
          `Текущий баланс: *${user.balance}* RUB\n` +
          `Максимальный баланс: *${user.maxBalance}* RUB\n` +
          `🕒 Обновлено: ${new Date().toLocaleString("ru-RU")}`,
        {
          parse_mode: "Markdown",
        },
      );
    } catch (error) {
      logger.error("Ошибка получения баланса:", error);
      await ctx.reply("❌ Не удалось получить информацию о балансе");
    }
  }

  private async handleMessage(
    ctx: BotContext & { message: Message.TextMessage },
  ): Promise<void> {
    if (!ctx.from) return;

    const userState = this.userStates.get(ctx.from.id);
    if (!userState) return;

    if (userState.awaitingBalance) {
      await this.handleBalanceInput(ctx);
    } else if (userState.awaitingOperatorId) {
      await this.handleOperatorInput(ctx);
    }
  }

  private async handleBalanceInput(
    ctx: BotContext & { message: Message.TextMessage },
  ): Promise<void> {
    if (!ctx.from) return;

    const amount = parseFloat(ctx.message.text);

    if (isNaN(amount)) {
      await ctx.reply(
        "❌ Некорректная сумма. Пожалуйста, введите число.\n\nПример: 1000.50",
        {
          reply_markup: this.getCancelKeyboard().reply_markup,
        },
      );
      return;
    }

    if (amount < 0) {
      await ctx.reply("❌ Сумма не может быть отрицательной", {
        reply_markup: this.getCancelKeyboard().reply_markup,
      });
      return;
    }

    try {
      await db.user.update({
        where: { telegramId: BigInt(ctx.from.id) },
        data: { balance: amount, maxBalance: amount },
      });

      this.userStates.set(ctx.from.id, {
        awaitingBalance: false,
        awaitingOperatorId: false,
        awaitingScreenshot: false,
      });

      await ctx.reply(
        `✅ Баланс успешно установлен!\n\n` +
          `💰 Текущий баланс: *${amount}* RUB\n` +
          `🕒 Обновлено: ${new Date().toLocaleString("ru-RU")}`,
        {
          parse_mode: "Markdown",
        },
      );

      await this.showMainMenu(ctx);
    } catch (error) {
      logger.error("Ошибка установки баланса:", error);
      await ctx.reply("❌ Произошла ошибка при установке баланса");
    }
  }

  private async handleOperatorInput(
    ctx: BotContext & { message: Message.TextMessage },
  ): Promise<void> {
    if (!ctx.from) return;

    try {
      const operatorId = BigInt(ctx.message.text.trim());

      // Проверяем, существует ли уже такой оператор
      const existingUser = await db.user.findUnique({
        where: { telegramId: operatorId },
      });

      if (existingUser) {
        // Обновляем существующего пользователя
        await db.user.update({
          where: { telegramId: operatorId },
          data: { isAdmin: true },
        });
      } else {
        // Создаем нового оператора
        await db.user.create({
          data: {
            telegramId: operatorId,
            isAdmin: true,
          },
        });
      }

      this.userStates.set(ctx.from.id, {
        awaitingBalance: false,
        awaitingOperatorId: false,
        awaitingScreenshot: false,
      });

      await ctx.reply(
        `✅ Оператор успешно ${existingUser ? "обновлён" : "добавлен"}!\n\n` +
          `👤 ID: ${operatorId}`,
      );

      await this.showMainMenu(ctx);
    } catch (error) {
      logger.error("Ошибка добавления оператора:", error);
      await ctx.reply(
        "❌ Ошибка! Проверьте правильность ID\n\n" +
          "ID должно быть числом. Попробуйте еще раз или нажмите Отмена",
        {
          reply_markup: this.getCancelKeyboard().reply_markup,
        },
      );
    }
  }

  private async showHelp(ctx: BotContext): Promise<void> {
    let message = `🤖 *Справочная информация*\n\n`;

    if (ctx.state.isAdmin) {
      message +=
        `*Возможности администратора:*\n` +
        `👥 Просмотр списка операторов\n` +
        `➕ Добавление новых операторов\n` +
        `📊 Просмотр статистики\n` +
        `⚙️ Управление настройками\n\n`;
    }

    if (ctx.state.isOperator) {
      message +=
        `*Возможности оператора:*\n` +
        `💰 Просмотр входящих заявок\n` +
        `📸 Загрузка скриншотов\n` +
        `💵 Управление выплатами\n\n`;
    }

    message += `❗️ Для выбора действия используйте кнопки меню ниже.`;

    await ctx.reply(message, {
      parse_mode: "Markdown",
      ...this.getMainKeyboard(ctx.state.isAdmin, ctx.state.isOperator),
    });
  }

  private setupHandlers(): void {
    this.bot.action(/ap:([^:]+):(\d+)/, async (ctx) => {
      if (!ctx.from) return;

      const [shortTxId, shortDestination] = (
        ctx.match as RegExpMatchArray
      ).slice(1);

      // Получаем полный ID транзакции
      const fullTransactionId = await this.getFullTransactionId(shortTxId);
      if (!fullTransactionId) {
        await ctx.reply("❌ Транзакция не найдена или устарела");
        return;
      }

      // Получаем полные данные транзакции из базы
      const transaction = await db.transaction.findUnique({
        where: { id: fullTransactionId },
      });

      if (!transaction) {
        await ctx.reply("❌ Транзакция не найдена");
        return;
      }

      await this.handleAcceptPayout(
        ctx as BotContext,
        fullTransactionId,
        transaction.destination || "",
      );
      await ctx.answerCbQuery();
    });
    // Команда start
    this.bot.command("start", async (ctx) => {
      await this.showMainMenu(ctx);
    });

    // Обработка текстовых сообщений и файлов
    this.bot.on("message", async (ctx) => {
      if ("photo" in ctx.message || "document" in ctx.message) {
        await this.handleScreenshotUpload(
          ctx as BotContext & {
            message: Message.PhotoMessage | Message.DocumentMessage;
          },
        );
      } else if ("text" in ctx.message) {
        await this.handleMessage(
          ctx as BotContext & { message: Message.TextMessage },
        );
      }
    });

    // Проверка баланса
    this.bot.action("check_balance", async (ctx) => {
      if (!ctx.state.isOperator) {
        await ctx.answerCbQuery("⛔️ Недостаточно прав");
        return;
      }

      await this.handleCheckBalance(ctx as BotContext);
      await ctx.answerCbQuery();
    });

    // Установка баланса
    this.bot.action("set_balance", async (ctx) => {
      if (!ctx.from || !ctx.state.isOperator) {
        await ctx.answerCbQuery("⛔️ Недостаточно прав");
        return;
      }

      this.userStates.set(ctx.from.id, {
        awaitingBalance: true,
        awaitingOperatorId: false,
        awaitingScreenshot: false,
      });

      await ctx.reply(
        "💵 *Установка баланса*\n\n" +
          "Введите новую сумму баланса:\n" +
          "Пример: 1000.50\n\n" +
          "❗️ Используйте точку для копеек",
        {
          parse_mode: "Markdown",
          reply_markup: this.getCancelKeyboard().reply_markup,
        },
      );

      await ctx.answerCbQuery();
    });

    // Список операторов
    this.bot.action("list_operators", async (ctx) => {
      if (!ctx.state.isAdmin) {
        await ctx.answerCbQuery("⛔️ Только для администратора");
        return;
      }

      try {
        const operators = await db.user.findMany({
          where: { isAdmin: true },
        });

        if (operators.length === 0) {
          await ctx.reply("📝 Операторы не найдены");
          return;
        }

        const operatorsList = operators
          .map(
            (op, index) =>
              `${index + 1}. ID: \`${op.telegramId}\`${
                op.username ? ` (@${op.username})` : ""
              }\n💰 Баланс: *${op.balance}* RUB`,
          )
          .join("\n\n");

        await ctx.reply(
          `👥 *Список операторов:*\n\n${operatorsList}\n\n` +
            `Всего операторов: ${operators.length}`,
          {
            parse_mode: "Markdown",
          },
        );
      } catch (error) {
        logger.error("Ошибка получения списка операторов:", error);
        await ctx.reply("❌ Не удалось получить список операторов");
      }

      await ctx.answerCbQuery();
    });

    // Добавление оператора
    this.bot.action("add_operator", async (ctx) => {
      if (!ctx.from || !ctx.state.isAdmin) {
        await ctx.answerCbQuery("⛔️ Только для администратора");
        return;
      }

      this.userStates.set(ctx.from.id, {
        awaitingBalance: false,
        awaitingOperatorId: true,
        awaitingScreenshot: false,
      });

      await ctx.reply(
        "👤 *Добавление нового оператора*\n\n" +
          "Введите Telegram ID нового оператора:\n" +
          "Пример: 123456789\n\n" +
          "❗️ ID можно узнать у @userinfobot",
        {
          parse_mode: "Markdown",
          reply_markup: this.getCancelKeyboard().reply_markup,
        },
      );

      await ctx.answerCbQuery();
    });

    // Статистика
    this.bot.action("statistics", async (ctx) => {
      if (!ctx.state.isAdmin) {
        await ctx.answerCbQuery("⛔️ Только для администратора");
        return;
      }

      try {
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const stats = await db.transaction.groupBy({
          by: ["status"],
          where: {
            createdAt: {
              gte: today,
            },
          },
          _count: true,
          _sum: {
            amount: true,
          },
        });

        const totalTransactions = await db.transaction.count({
          where: {
            createdAt: {
              gte: today,
            },
          },
        });

        const completedTransactions = stats.find(
          (s) => s.status === "COMPLETED",
        );
        const pendingTransactions = stats.find((s) => s.status === "PENDING");
        const failedTransactions = stats.find((s) => s.status === "FAILED");

        const message = `
📊 *Статистика за сегодня:*

Всего транзакций: ${totalTransactions}
✅ Выполнено: ${completedTransactions?._count || 0}
⏳ В процессе: ${pendingTransactions?._count || 0}
❌ Отменено/Ошибки: ${failedTransactions?._count || 0}

💰 Общая сумма выполненных: ${completedTransactions?._sum.amount?.toLocaleString("ru-RU") || 0} RUB
`;

        await ctx.reply(message, {
          parse_mode: "Markdown",
        });
      } catch (error) {
        logger.error("Ошибка получения статистики:", error);
        await ctx.reply("❌ Не удалось получить статистику");
      }

      await ctx.answerCbQuery();
    });

    // Настройки
    this.bot.action("settings", async (ctx) => {
      if (!ctx.state.isAdmin) {
        await ctx.answerCbQuery("⛔️ Только для администратора");
        return;
      }

      const message = `
⚙️ *Текущие настройки:*

Мин. сумма выплаты: ${config.MIN_PAYOUT_AMOUNT} RUB
Макс. сумма выплаты: ${config.MAX_PAYOUT_AMOUNT} RUB
Время на принятие: ${config.PAYOUT_EXPIRES_IN / 60} мин
Макс. размер скриншота: ${(config.SCREENSHOT_MAX_SIZE / 1024 / 1024).toFixed(1)} MB

Для изменения настроек обратитесь к разработчику.
`;

      await ctx.reply(message, {
        parse_mode: "Markdown",
      });
      await ctx.answerCbQuery();
    });

    // Обработчик кнопки "Принять"
    this.bot.action(/accept_payout:(.+):(.+)/, async (ctx) => {
      const [transactionId, destination] = (
        ctx.match as RegExpMatchArray
      ).slice(1);
      await this.handleAcceptPayout(
        ctx as BotContext,
        transactionId,
        destination,
      );
      await ctx.answerCbQuery();
    });

    // Отмена действия
    this.bot.action("cancel_action", async (ctx) => {
      if (!ctx.from) return;

      const userState = this.userStates.get(ctx.from.id);
      if (userState?.currentTransactionId) {
        // Отменяем транзакцию, если она была в процессе
        await db.transaction.update({
          where: { id: userState.currentTransactionId },
          data: { status: "CANCELLED" },
        });
      }

      this.userStates.set(ctx.from.id, {
        awaitingBalance: false,
        awaitingOperatorId: false,
        awaitingScreenshot: false,
      });

      await ctx.reply("🚫 Действие отменено");
      await this.showMainMenu(ctx as BotContext);
      await ctx.answerCbQuery();
    });

    // Помощь
    this.bot.action("help", async (ctx) => {
      await this.showHelp(ctx as BotContext);
      await ctx.answerCbQuery();
    });

    // Обработка ошибок
    this.bot.catch((err: unknown) => {
      logger.error("Bot error:", err);
    });
  }

  public start(): void {
    this.bot.launch();
    logger.info("✅ Telegram бот запущен");

    process.once("SIGINT", () => this.bot.stop("SIGINT"));
    process.once("SIGTERM", () => this.bot.stop("SIGTERM"));
  }
}

export default new TelegramBot();
