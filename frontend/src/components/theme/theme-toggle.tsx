import * as React from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';

import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

import { useTheme } from './theme-context';
import type { ThemePreference } from './theme-context';

const OPTIONS: { value: ThemePreference; label: string; Icon: React.ComponentType<{ className?: string }> }[] = [
  { value: 'light', label: 'Light', Icon: Sun },
  { value: 'dark', label: 'Dark', Icon: Moon },
  { value: 'system', label: 'System', Icon: Monitor },
];

export function ThemeToggle(): React.JSX.Element {
  const { preference, setPreference } = useTheme();

  return (
    <ToggleGroup
      type="single"
      size="sm"
      value={preference}
      onValueChange={(next) => {
        // Radix emits '' when the active item is re-clicked; ignore that (no "off" state).
        if (next === 'light' || next === 'dark' || next === 'system') {
          setPreference(next);
        }
      }}
      aria-label="Colour theme"
    >
      {OPTIONS.map(({ value, label, Icon }) => (
        <Tooltip key={value}>
          <TooltipTrigger asChild>
            <ToggleGroupItem value={value} aria-label={`${label} theme`}>
              <Icon className="size-4" />
            </ToggleGroupItem>
          </TooltipTrigger>
          <TooltipContent>{label}</TooltipContent>
        </Tooltip>
      ))}
    </ToggleGroup>
  );
}
