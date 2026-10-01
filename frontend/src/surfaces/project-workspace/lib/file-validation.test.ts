import { describe, expect, it } from 'vitest';

import type { FileRead } from '../api/types';
import { groupFiles, MAX_FILE_BYTES, nextVersionFor, validateFileDraft } from './file-validation';

function fileOf(name: string, size: number): File {
  const f = new File(['x'], name);
  Object.defineProperty(f, 'size', { value: size });
  return f;
}

describe('validateFileDraft (contract §7)', () => {
  const ok = { file: fileOf('cert.pdf', 1000), display_name: 'Certification report', category: 'Certification', description: '' };
  it('accepts a valid draft', () => expect(validateFileDraft(ok)).toEqual({}));
  it('rejects files over 50 MB', () => {
    expect(validateFileDraft({ ...ok, file: fileOf('big.pdf', MAX_FILE_BYTES + 1) }).file).toMatch(/50 MB/);
    expect(validateFileDraft({ ...ok, file: fileOf('edge.pdf', MAX_FILE_BYTES) })).toEqual({});
  });
  it('rejects disallowed types (case-insensitive extension check)', () => {
    expect(validateFileDraft({ ...ok, file: fileOf('run.exe', 10) }).file).toMatch(/Allowed types/);
    expect(validateFileDraft({ ...ok, file: fileOf('PART.STEP', 10) })).toEqual({});
  });
  it('requires a display name and a known category', () => {
    expect(validateFileDraft({ ...ok, display_name: ' ' }).display_name).toBeTruthy();
    expect(validateFileDraft({ ...ok, category: '' }).category).toBeTruthy();
    expect(validateFileDraft({ ...ok, category: 'Invoice' }).category).toBeTruthy();
  });
  it('requires a file', () => expect(validateFileDraft({ ...ok, file: null }).file).toBeTruthy());
});

function fr(id: string, name: string, version: number, created: string): FileRead {
  return { id, display_name: name, category: 'Other', description: null, version, size_bytes: 1, content_type: 'application/pdf', uploaded_by_name: null, created_at: created };
}

describe('groupFiles / nextVersionFor (all versions are returned — P9-T03)', () => {
  const files = [
    fr('a1', 'Drawing', 1, '2026-09-01T00:00:00Z'),
    fr('b1', 'Cert', 1, '2026-09-05T00:00:00Z'),
    fr('a2', 'Drawing', 2, '2026-09-10T00:00:00Z'),
  ];
  it('groups by display name, newest version first, newest group first', () => {
    const groups = groupFiles(files);
    expect(groups.map((g) => g.display_name)).toEqual(['Drawing', 'Cert']);
    expect(groups[0]!.versions.map((v) => v.id)).toEqual(['a2', 'a1']);
  });
  it('next version is max + 1 (case-insensitive name), null for a new name', () => {
    expect(nextVersionFor(files, 'drawing ')).toBe(3);
    expect(nextVersionFor(files, 'New')).toBeNull();
    expect(nextVersionFor(files, '')).toBeNull();
  });
});
