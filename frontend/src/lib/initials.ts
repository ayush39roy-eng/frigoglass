/** Two-letter monogram for a name or email ("Sam Super" → "SS"). */
export function initialsOf(name: string | undefined): string {
  if (!name) return 'RPD';
  const parts = name.trim().split(/[\s.@]+/).filter(Boolean);
  const first = parts[0]?.[0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
  return (first + last).toUpperCase() || 'RPD';
}
