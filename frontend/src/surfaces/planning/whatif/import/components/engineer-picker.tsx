import * as React from 'react';

import { Input } from '@/components/ui/input';

import { NativeSelect } from '../../components/form-controls';
import { rosterForRow } from '../import-rows';
import type { ImportLeader, ImportRosterEntry } from '../import-types';

const AUTO = '__auto__';
const NEW = '__new__';

/**
 * Engineer for one file row: the roster of the row's capacity hub first, then the
 * other hubs; "Auto-assign" (the What-if picker chooses, ADR 0044 §5); "New
 * designer…" with a name input. A native select on purpose (keyboard- and
 * AT-complete in a virtualized table, as the scenario forms).
 */
export function EngineerPicker({
  id,
  rowName,
  hub,
  leader,
  roster,
  error,
  onChange,
}: {
  id: string;
  rowName: string;
  hub: string;
  leader: ImportLeader;
  roster: readonly ImportRosterEntry[];
  error?: string | undefined;
  onChange: (leader: ImportLeader) => void;
}): React.JSX.Element {
  const { own, others } = React.useMemo(() => rosterForRow(roster, hub), [roster, hub]);
  const value = leader.kind === 'auto' ? AUTO : leader.kind === 'new' ? NEW : leader.engineer_id;
  const errId = `${id}-err`;
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <NativeSelect
        id={id}
        aria-label={`Engineer for ${rowName}`}
        value={value}
        className="h-7 text-xs"
        onChange={(e) => {
          const v = e.target.value;
          if (v === AUTO) onChange({ kind: 'auto' });
          else if (v === NEW)
            onChange({
              kind: 'new',
              name: leader.kind === 'new' ? leader.name : '',
            });
          else {
            const eng = roster.find((r) => r.engineer_id === v);
            if (eng)
              onChange({
                kind: 'existing',
                engineer_id: eng.engineer_id,
                name: eng.name,
              });
          }
        }}
      >
        <option value={AUTO}>Auto-assign</option>
        {own.length > 0 ? (
          <optgroup label={`${own[0]?.capacity_hub ?? hub} designers`}>
            {own.map((e) => (
              <option key={e.engineer_id} value={e.engineer_id}>
                {e.name}
              </option>
            ))}
          </optgroup>
        ) : null}
        {others.length > 0 ? (
          <optgroup label="Other hubs">
            {others.map((e) => (
              <option key={e.engineer_id} value={e.engineer_id}>
                {`${e.name} (${e.capacity_hub})`}
              </option>
            ))}
          </optgroup>
        ) : null}
        <option value={NEW}>New designer…</option>
      </NativeSelect>
      {leader.kind === 'new' ? (
        <Input
          aria-label={`New designer name for ${rowName}`}
          className="h-7 text-xs"
          value={leader.name}
          maxLength={120}
          placeholder="Designer name"
          aria-invalid={Boolean(error)}
          aria-describedby={error ? errId : undefined}
          onChange={(e) => onChange({ kind: 'new', name: e.target.value })}
        />
      ) : null}
      {error ? (
        <p id={errId} className="text-2xs font-medium text-danger-subtle-fg">
          {error}
        </p>
      ) : null}
    </div>
  );
}
