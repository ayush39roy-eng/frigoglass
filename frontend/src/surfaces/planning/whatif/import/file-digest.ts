/**
 * P41 (ADR 0055 D3): the hex SHA-256 of the uploaded bytes, so a saved scenario names the
 * import it came from. Null when the browser cannot hash (saving is then off).
 */
export async function sha256Hex(file: Blob): Promise<string | null> {
  try {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) return null;
    const digest = await subtle.digest('SHA-256', await file.arrayBuffer());
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}
