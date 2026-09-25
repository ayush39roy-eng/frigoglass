import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { Tabs, TabsContent, TabsList, TabsTrigger } from './tabs';

describe('Tabs', () => {
  it('switches panels on trigger click', async () => {
    const user = userEvent.setup();
    render(
      <Tabs defaultValue="design">
        <TabsList>
          <TabsTrigger value="design">Design</TabsTrigger>
          <TabsTrigger value="lab">Lab</TabsTrigger>
        </TabsList>
        <TabsContent value="design">Design steps</TabsContent>
        <TabsContent value="lab">Lab steps</TabsContent>
      </Tabs>,
    );
    expect(screen.getByText('Design steps')).toBeVisible();
    await user.click(screen.getByRole('tab', { name: 'Lab' }));
    expect(screen.getByText('Lab steps')).toBeVisible();
  });
});
