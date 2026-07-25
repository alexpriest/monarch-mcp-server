import { timingSafeEqual, createHash } from 'crypto';

/**
 * Compare two strings in constant time to prevent timing attacks.
 */
export function secureCompare(a: string, b: string): boolean {
  if (!a || !b) return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    const dummyA = createHash('sha256').update(a).digest();
    const dummyB = createHash('sha256').update(b).digest();
    timingSafeEqual(dummyA, dummyB);
    return false;
  }
  try {
    return timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}

export function sanitizeErrorMessage(error: unknown, isProduction: boolean = true): string {
  if (!isProduction) {
    if (error instanceof Error) return error.message;
    return String(error);
  }
  if (error instanceof Error) {
    if (error.message.includes('API error')) return 'External API request failed';
    if (error.message.includes('Validation')) return 'Invalid input provided';
    if (error.message.includes('Unauthorized') || error.message.includes('401')) return 'Authentication failed';
    if (error.message.includes('fetch') || error.message.includes('network')) return 'Network connection error';
  }
  return 'An error occurred while processing your request';
}
