import * as React from 'react';

/**
 * P21-T05: Matrix Scenario mode on the Priority board. The board shows which
 * cards carry a staged (uncommitted) score change; it never shows a
 * browser-computed score — the served score stays until the scenario is applied
 * and the server re-reads it (I9). Empty outside Scenario mode.
 */
export const BoardScenarioContext = React.createContext<ReadonlySet<string>>(new Set());
