import * as React from 'react';
import { useSearchParams } from 'react-router-dom';

import { useSessionStore } from '@/stores/session';

/**
 * P21-T05 (owner add-on): the Priority board's Cards | List layout. The URL
 * (`layout=list`) wins; otherwise the user's last choice from localStorage (a
 * per-user convenience, guarded); otherwise Cards. Presentation only.
 */
export type BoardLayout = 'cards' | 'list';
export const BOARD_LAYOUT_PARAM = 'layout';
const STORAGE_PREFIX = 'rpd-board-layout:';

export function boardLayoutStorageKey(userId: string | null | undefined): string {
  return `${STORAGE_PREFIX}${userId ?? 'anonymous'}`;
}

function readStored(key: string): BoardLayout | null {
  try {
    const v = window.localStorage.getItem(key);
    return v === 'list' || v === 'cards' ? v : null;
  } catch {
    return null;
  }
}

function writeStored(key: string, value: BoardLayout): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // storage unavailable: the URL still carries the choice
  }
}

export function useBoardLayout(): [BoardLayout, (next: BoardLayout) => void] {
  const [params, setParams] = useSearchParams();
  const userId = useSessionStore((s) => s.me?.user_id);
  const key = boardLayoutStorageKey(userId);
  const fromUrl = params.get(BOARD_LAYOUT_PARAM);
  const layout: BoardLayout = fromUrl === 'list' || fromUrl === 'cards' ? fromUrl : (readStored(key) ?? 'cards');
  const setLayout = React.useCallback(
    (next: BoardLayout) => {
      writeStored(key, next);
      setParams(
        (prev) => {
          const out = new URLSearchParams(prev);
          if (next === 'list') out.set(BOARD_LAYOUT_PARAM, 'list');
          else out.delete(BOARD_LAYOUT_PARAM);
          return out;
        },
        { replace: true },
      );
    },
    [key, setParams],
  );
  return [layout, setLayout];
}
