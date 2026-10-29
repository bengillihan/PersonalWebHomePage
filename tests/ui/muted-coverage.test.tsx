// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import StoryCard from '../../web/src/components/StoryCard';
import type { Story } from '../../web/src/types';

const art = (id: number, publisher: string, muted: boolean) => ({ id, publisher, title: `${publisher} headline`, url: `https://example.com/${id}`, publishedAt: Date.now() - id * 60_000, aggregated: false, alsoVia: [], muted });
const story = (o: Partial<Story> = {}): Story => ({
  id: 1, title: 'General headline', summary: 'A summary.', summaryKind: 'excerpt', differences: null, category: null, importance: 0.5, publishedAt: Date.now(), updatedAt: 1,
  sourceCount: 1, mutedSources: 1, isRead: false, isUpdated: false, bookmarked: false, rating: 0, imageUrl: null, blockedBy: [],
  primary: { publisher: 'General', url: 'https://example.com/2', aggregated: false }, articles: [art(1, 'Loud Blog', true), art(2, 'General', false)], ...o,
});
afterEach(() => cleanup());
const mount = (s: Story) => render(<StoryCard story={s} showImages={false} onChange={() => {}} onGone={vi.fn()} />);

describe('muted publishers in expanded coverage', () => {
  it('counts only unmuted publishers, mentions the muted ones, and labels them in the coverage list', () => {
    mount(story());
    const button = screen.getByRole('button', { name: /See coverage from 1 source \(\+1 muted\)/ });
    expect(screen.queryByText(/^\+\d+ more$/)).toBeNull(); // the header does not inflate coverage with the muted publisher
    expect(screen.getByText('General', { selector: 'span' })).toBeTruthy(); // and credits the unmuted publisher
    expect(screen.queryByText('muted publisher')).toBeNull(); // collapsed: nothing listed yet
    fireEvent.click(button);
    const list = screen.getByRole('list');
    expect(within(list).getAllByRole('listitem')).toHaveLength(2); // both are listed...
    expect(within(list).getAllByText('muted publisher')).toHaveLength(1); // ...and exactly the muted one is labelled
    expect(within(within(list).getAllByRole('listitem')[0]).getByText('Loud Blog')).toBeTruthy();
  });

  it('a story with no muted coverage looks exactly as before', () => {
    mount(story({ mutedSources: 0, sourceCount: 2, articles: [art(1, 'Alpha', false), art(2, 'Beta', false)] }));
    fireEvent.click(screen.getByRole('button', { name: 'See coverage from 2 sources' }));
    expect(screen.queryByText('muted publisher')).toBeNull();
  });

  it('a single unmuted publisher with muted coverage still offers the coverage list (it would otherwise be hidden)', () => {
    mount(story({ sourceCount: 1, mutedSources: 2 })); expect(screen.getByRole('button', { name: /\+2 muted/ })).toBeTruthy();
    cleanup(); mount(story({ sourceCount: 1, mutedSources: 0, articles: [art(2, 'General', false)] })); expect(screen.queryByRole('button', { name: /See coverage/ })).toBeNull();
  });
});
