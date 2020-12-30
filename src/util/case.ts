export function lcFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.substring(1);
}

export function ucFirst(s: string): string {
  return s.charAt(0).toUpperCase() + s.substring(1);
}

export function splitCamelCase(s: string): string[] {
  return s.split(/(?<![A-Z])(?=[A-Z])/);
}

export function joinCamelCase(s: string[]): string {
  return s.reduce((p, c) => (p ? p + ucFirst(c) : lcFirst(c)), '');
}

export function mapLast<T>(a: T[], f: (s: T) => T): T[] {
  if (a.length > 0) a[a.length - 1] = f(a[a.length - 1]);
  return a;
}
