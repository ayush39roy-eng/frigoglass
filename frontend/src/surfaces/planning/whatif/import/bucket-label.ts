/** Served breakdown bucket key → label ("unknown" is the backend's key for a missing value, P32-R05). */
export function bucketLabel(key: string): string {
  return key === 'unknown' ? 'Unknown' : key;
}
