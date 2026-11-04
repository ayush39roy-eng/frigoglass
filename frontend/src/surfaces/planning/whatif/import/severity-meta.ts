import { CircleAlert, Info, TriangleAlert } from 'lucide-react';

import type { ImportSeverity } from './import-types';

export const SEVERITY_ORDER: ImportSeverity[] = ['error', 'warning', 'info'];
export const SEVERITY_META: Record<
  ImportSeverity,
  {
    label: string;
    plural: string;
    tone: 'danger' | 'warning' | 'neutral';
    Icon: typeof Info;
  }
> = {
  error: {
    label: 'Error',
    plural: 'Errors',
    tone: 'danger',
    Icon: CircleAlert,
  },
  warning: {
    label: 'Warning',
    plural: 'Warnings',
    tone: 'warning',
    Icon: TriangleAlert,
  },
  info: { label: 'Info', plural: 'Info', tone: 'neutral', Icon: Info },
};
