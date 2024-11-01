// utils/signature.ts
export const generateSignature = (
  privateKey: string,
  message: string
): string => {
  const crypto = require("crypto");
  const hmac = crypto.createHmac("sha512", privateKey);
  hmac.update(message);
  return hmac.digest("hex");
};
