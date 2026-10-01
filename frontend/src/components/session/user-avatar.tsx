import * as React from 'react';

import { initialsOf } from '@/lib/initials';
import { cn } from '@/lib/utils';
import { useAvatarFor } from '@/stores/preferences';

/**
 * The signed-in user's avatar: their uploaded photo (Profile & settings, stored
 * in this browser only) or, failing that, initials on a tinted disc.
 */

export function UserAvatar({
  email,
  name,
  className,
}: {
  email: string | undefined;
  name: string | undefined;
  className?: string;
}): React.JSX.Element {
  const photo = useAvatarFor(email);
  return (
    <span
      className={cn(
        'grid size-9 shrink-0 place-items-center overflow-hidden rounded-full bg-primary-subtle text-2xs font-bold text-primary-subtle-fg ring-2 ring-surface',
        className,
      )}
      aria-hidden="true"
    >
      {photo ? <img src={photo} alt="" className="size-full object-cover" /> : initialsOf(name)}
    </span>
  );
}
