/**
 * 业务校验错误：服务端统一映射为 HTTP 400。
 */
export class ValidationError extends Error {
  constructor(message, code = 'VALIDATION_ERROR', details = undefined) {
    super(message);
    this.name = 'ValidationError';
    this.code = code;
    this.details = details;
  }
}

export function toValidationError(err, fallbackMessage = '请求参数不合法') {
  if (err instanceof ValidationError) return err;
  return new ValidationError(err && err.message ? err.message : fallbackMessage);
}
