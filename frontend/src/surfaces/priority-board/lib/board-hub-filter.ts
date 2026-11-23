import * as React from 'react';

/**
 * P60 (ADR 0068): a hub / country filter is active on the board. Cards then show
 * the hub rank only; without one they add the global rank (hover + "G16").
 */
export const BoardHubFilterContext = React.createContext(false);
