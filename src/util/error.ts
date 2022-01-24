export function getErrorMessage(e: unknown): string {
  if (e instanceof Error) {
    return e.message;
  }
  if (e && typeof e === 'object') {
    return e.constructor.name;
  }
  return String(e);
}
