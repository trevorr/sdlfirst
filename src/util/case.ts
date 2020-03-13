export function lcFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.substring(1);
}

export function ucFirst(s: string): string {
  return s.charAt(0).toUpperCase() + s.substring(1);
}

export function splitCamelCase(s: string): string[] {
  return s.split(/(?<![A-Z])(?=[A-Z])/);
}

export function transformCamelCaseLast(s: string, f: (s: string) => string): string {
  const words = splitCamelCase(s);
  words[words.length - 1] = f(words[words.length - 1]);
  return words.join('');
}
