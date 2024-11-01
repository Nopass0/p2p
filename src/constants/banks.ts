// src/constants/banks.ts

export const BANKS = {
  // Российские банки
  SBERBANK: "sberbank",
  TINKOFF: "tinkoff",
  VTB: "vtb",
  ALFA: "alfa",
  GAZPROMBANK: "gazprombank",
  INTERBANK: "interbank",
  MTS_BANK: "mts_bank",
  OZON_BANK: "ozon_bank",
  OPEN: "open",
  POST_BANK: "post_bank",
  PSB: "psb",
  RAIFFEISEN: "raiffeisen",
  ROSBANK: "rosbank",
  RSTB: "rstb",
  SBP: "sbp",
  SOVKOM: "sovkom",
  URALSIB: "uralsib",

  // Международные системы
  ACCOUNT_NUMBER: "account_number",
  HUMO_UZS: "humo_uzs",
  ZIRAAT: "ziraat",
  PAPARA: "papara",
  UZ_CARD: "uz_card",
  KAPITAL: "kapital",
  GARANTI: "garanti",
  ENPARA: "enpara",
  KUVEYT: "kuveyt",
  ININAL: "ininal",
  IBAN: "iban",
} as const;

export const BANK_NAMES = {
  // Российские банки
  [BANKS.SBERBANK]: "Сбербанк",
  [BANKS.TINKOFF]: "Тинькофф",
  [BANKS.VTB]: "ВТБ",
  [BANKS.ALFA]: "Альфабанк",
  [BANKS.GAZPROMBANK]: "Газпромбанк",
  [BANKS.INTERBANK]: "Межбанк",
  [BANKS.MTS_BANK]: "МТС-Банк",
  [BANKS.OZON_BANK]: "Озонбанк",
  [BANKS.OPEN]: "Открытие",
  [BANKS.POST_BANK]: "Почта банк",
  [BANKS.PSB]: "Промсвязьбанк",
  [BANKS.RAIFFEISEN]: "Райффайзен",
  [BANKS.ROSBANK]: "Росбанк",
  [BANKS.RSTB]: "Россельхозбанк",
  [BANKS.SBP]: "СБП",
  [BANKS.SOVKOM]: "Совкомбанк",
  [BANKS.URALSIB]: "Уралсиб",

  // Международные системы
  [BANKS.ACCOUNT_NUMBER]: "Номер счета",
  [BANKS.HUMO_UZS]: "Humo UZS",
  [BANKS.ZIRAAT]: "Ziraat Bank",
  [BANKS.PAPARA]: "Papara",
  [BANKS.UZ_CARD]: "UZ Card",
  [BANKS.KAPITAL]: "Kapital Bank",
  [BANKS.GARANTI]: "Garanti",
  [BANKS.ENPARA]: "Enpara",
  [BANKS.KUVEYT]: "Kuveyt",
  [BANKS.ININAL]: "Ininal",
  [BANKS.IBAN]: "iBan",
} as const;

export type BankId = keyof typeof BANK_NAMES;

export function getBankName(bankId: string): string {
  const normalizedBankId = bankId.toLowerCase();
  return BANK_NAMES[normalizedBankId as BankId] || bankId;
}

export function validateBankId(bankId: string): boolean {
  return Object.values(BANKS).includes(
    bankId.toLowerCase() as (typeof BANKS)[keyof typeof BANKS],
  );
}

export const ALL_BANKS = Object.values(BANKS);
