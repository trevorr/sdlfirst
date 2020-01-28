export function lcFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.substring(1);
}

export function ucFirst(s: string): string {
  return s.charAt(0).toUpperCase() + s.substring(1);
}
