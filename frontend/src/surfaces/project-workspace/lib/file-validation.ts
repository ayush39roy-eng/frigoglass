import { FILE_CATEGORIES, type FileCategory, type FileRead } from '../api/types';

/** Contract §7: max 50 MB, allowed extensions — a responsiveness check; the
 *  server is the authority and re-validates type and size. */
export const MAX_FILE_BYTES = 50 * 1024 * 1024;
export const ALLOWED_EXTENSIONS = ['pdf', 'png', 'jpg', 'jpeg', 'xlsx', 'docx', 'pptx', 'csv', 'txt', 'zip', 'step', 'stp', 'dxf'] as const;

export interface FileDraft {
  file: File | null;
  display_name: string;
  category: string;
  description: string;
}

export type FileDraftErrors = Partial<Record<'file' | 'display_name' | 'category' | 'description', string>>;

export function extensionOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i < 0 ? '' : name.slice(i + 1).toLowerCase();
}

export function validateFileDraft(d: FileDraft): FileDraftErrors {
  const e: FileDraftErrors = {};
  if (!d.file) e.file = 'Choose a file to upload.';
  else if (d.file.size > MAX_FILE_BYTES) e.file = 'Files are limited to 50 MB.';
  else if (!(ALLOWED_EXTENSIONS as readonly string[]).includes(extensionOf(d.file.name)))
    e.file = `Allowed types: ${ALLOWED_EXTENSIONS.join(', ')}.`;
  if (d.display_name.trim() === '') e.display_name = 'Display name is required.';
  else if (d.display_name.length > 255) e.display_name = 'Max 255 characters.';
  if (!(FILE_CATEGORIES as readonly string[]).includes(d.category)) e.category = 'Choose a category.';
  if (d.description.length > 2000) e.description = 'Max 2,000 characters.';
  return e;
}

export function isFileCategory(v: string): v is FileCategory {
  return (FILE_CATEGORIES as readonly string[]).includes(v);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export interface FileGroup {
  display_name: string;
  /** Newest version first. */
  versions: FileRead[];
}

/**
 * `GET /projects/{id}/files` returns EVERY version (P9-T03). Group by display
 * name, newest version first inside a group, groups ordered by their newest
 * upload. A rename (PATCH `display_name`) renames all versions server-side, so
 * exact-name grouping stays consistent.
 */
export function groupFiles(files: readonly FileRead[]): FileGroup[] {
  const byName = new Map<string, FileRead[]>();
  for (const f of files) {
    const list = byName.get(f.display_name) ?? [];
    list.push(f);
    byName.set(f.display_name, list);
  }
  return [...byName.entries()]
    .map(([display_name, versions]) => ({ display_name, versions: [...versions].sort((a, b) => b.version - a.version) }))
    .sort((a, b) => Date.parse(b.versions[0]?.created_at ?? '') - Date.parse(a.versions[0]?.created_at ?? ''));
}

/** The version a re-upload under `displayName` would get, or null for a new name. */
export function nextVersionFor(files: readonly FileRead[], displayName: string): number | null {
  const name = displayName.trim().toLowerCase();
  if (!name) return null;
  const matching = files.filter((f) => f.display_name.trim().toLowerCase() === name);
  return matching.length === 0 ? null : Math.max(...matching.map((f) => f.version)) + 1;
}
