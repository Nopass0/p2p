import type { HTTPHeaders } from "elysia/types";

//eror type (for console try .. catch)
export type ErrorType = {
  name: string;
  message: string;
  stack?: string;
};

// Новый тип, который включает дополнительные свойства
export type ReqErrorType = ErrorType & {
  request?: Request;
  code?: string;
  set?: {
    headers: HTTPHeaders;
    status?: number;
    redirect?: string;
    cookie?: Record<string, any>;
  };
};

export type AnyError = any;
