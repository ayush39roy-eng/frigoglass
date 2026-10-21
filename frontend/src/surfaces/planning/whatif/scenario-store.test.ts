import { beforeEach, describe, expect, it } from 'vitest';

import { askFixture } from './test-fixtures';
import { useWhatIfScenario } from './scenario-store';

describe('useWhatIfScenario', () => {
  beforeEach(() => useWhatIfScenario.getState().reset());

  it('adds, edits and removes lines of each list', () => {
    const s = useWhatIfScenario.getState();
    s.addLine('projects');
    s.addLine('projects');
    const [a, b] = useWhatIfScenario.getState().projects;
    expect(a?.key).not.toBe(b?.key);
    s.updateLine('projects', a?.key ?? '', { count: '7' });
    expect(useWhatIfScenario.getState().projects[0]?.count).toBe('7');
    s.removeLine('projects', a?.key ?? '');
    expect(useWhatIfScenario.getState().projects).toHaveLength(1);
    expect(useWhatIfScenario.getState().projects[0]?.key).toBe(b?.key);
  });

  it('moves a project line to a category its new hub accepts', () => {
    const s = useWhatIfScenario.getState();
    s.addLine('projects');
    const key = useWhatIfScenario.getState().projects[0]?.key ?? '';
    s.updateLine('projects', key, { hub: 'OEM-HCK' });
    expect(useWhatIfScenario.getState().projects[0]?.category).toBe('C-OEM');
    s.updateLine('projects', key, { hub: 'R&D-Greece' });
    expect(useWhatIfScenario.getState().projects[0]?.category).toBe('C');
  });

  it('keeps A when the hub change leaves the category valid', () => {
    const s = useWhatIfScenario.getState();
    s.addLine('projects');
    const key = useWhatIfScenario.getState().projects[0]?.key ?? '';
    s.updateLine('projects', key, { hub: 'R&D-India' });
    expect(useWhatIfScenario.getState().projects[0]?.category).toBe('A');
  });

  it('loads a chat scenario and resets to the empty scenario', () => {
    const s = useWhatIfScenario.getState();
    s.setBasis('remaining');
    const scenario = askFixture().scenario;
    if (!scenario) throw new Error('fixture');
    s.loadChatScenario(scenario);
    const st = useWhatIfScenario.getState();
    expect(st.projects).toHaveLength(1);
    expect(st.projects[0]).toMatchObject({ hub: 'PD-India', category: 'A', count: '5' });
    s.reset();
    const after = useWhatIfScenario.getState();
    expect(after.projects).toHaveLength(0);
    expect(after.basis).toBe('year');
  });
});
