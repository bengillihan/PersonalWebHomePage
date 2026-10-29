// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import Feed, { type FeedFilter } from '../../web/src/components/Feed';
import type { Story } from '../../web/src/types';

const story = (id: number, o: Partial<Story> = {}): Story => ({
  id, title: `Story ${id}`, summary: `Summary of story ${id}.`, summaryKind: 'excerpt', differences: null, category: null, importance: 0.5,
  publishedAt: Date.now() - id * 60_000, updatedAt: 1, sourceCount: 1, isRead: false, isUpdated: false, bookmarked: false, rating: 0, imageUrl: null,
  primary: { publisher: `Pub ${id}`, url: `https://example.com/${id}`, aggregated: false },
  articles: [{ id, publisher: `Pub ${id}`, title: `Story ${id}`, url: `https://example.com/${id}`, publishedAt: 1, aggregated: false, alsoVia: [] }], ...o,
});

interface Calls { feed: string[]; read: { id: number; read: boolean }[] }
let calls: Calls; let items: Story[]; let showRead: boolean;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  calls = { feed: [], read: [] }; items = [story(1), story(2), story(3)]; showRead = false;
  vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} unobserve() {} });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const m = /^\/api\/stories\/(\d+)\/read$/.exec(url);
    if (m) { const body = JSON.parse(String(init?.body)); calls.read.push({ id: Number(m[1]), read: body.read }); return json({ ok: true }); }
    if (url.startsWith('/api/feed')) { calls.feed.push(url); return json({ items, nextCursor: null, status: { newsRefreshing: false, marketRefreshing: false, lastNewsRefreshAt: 1, lastMarketFetchAt: null, stale: false, aiEnabled: false }, hasAnyStories: true, showImages: false, showRead }); }
    return json({ error: 'unexpected ' + url }, 500);
  }));
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

const mount = (filter: FeedFilter) => render(<Feed filter={filter} onStatus={() => {}} onOpenSettings={() => {}} newVersion={0} />);
const card = (id: number) => screen.getByRole('article', { name: `Story ${id}` });
const titles = () => screen.queryAllByRole('article').map((a) => a.getAttribute('aria-label'));
const markReadButton = (id: number) => within(card(id)).getByRole('button', { name: /^Mark (read|unread)$/ });

describe('Feed: marking read', () => {
  it('REGRESSION: "Mark read" removes the story immediately, without reloading the feed, and offers Undo', async () => {
    mount({ tab: 'latest', q: '' });
    await screen.findByText('Story 1');
    expect(calls.feed).toHaveLength(1);
    fireEvent.click(markReadButton(1));
    await waitFor(() => expect(titles()).toEqual(['Story 2', 'Story 3'])); // gone right away
    expect(calls.read).toEqual([{ id: 1, read: true }]);
    expect(calls.feed).toHaveLength(1); // no reload
    expect(screen.getByRole('status').textContent).toContain('Marked as read');
    expect(screen.getByRole('button', { name: 'Undo' })).toBeTruthy();
  });

  it('Undo restores the story at its original position and marks it unread again', async () => {
    mount({ tab: 'latest', q: '' }); await screen.findByText('Story 1');
    fireEvent.click(markReadButton(2));
    await waitFor(() => expect(titles()).toEqual(['Story 1', 'Story 3']));
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(titles()).toEqual(['Story 1', 'Story 2', 'Story 3']));
    expect(calls.read).toEqual([{ id: 2, read: true }, { id: 2, read: false }]);
    expect(screen.queryByRole('status')).toBeNull();
    expect(card(2).className).not.toMatch(/opacity-60/); // restored as an ordinary unread story
  });

  it('the Undo prompt goes away on its own after a few seconds', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mount({ tab: 'foryou', q: '' }); await screen.findByText('Story 1');
    fireEvent.click(markReadButton(1)); await waitFor(() => screen.getByRole('status'));
    await act(async () => { vi.advanceTimersByTime(8100); });
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('removal applies in every hiding view: For You, Latest, Local, Explore, a category tab and Unread', async () => {
    for (const filter of [{ tab: 'foryou' }, { tab: 'latest' }, { tab: 'local' }, { tab: 'explore' }, { tab: 'topic', topic: 'Business' }, { tab: 'unread' }]) {
      items = [story(1), story(2)];
      const { unmount } = mount({ ...filter, q: '' });
      await screen.findByText('Story 1');
      fireEvent.click(markReadButton(1));
      await waitFor(() => expect(titles()).toEqual(['Story 2']), { timeout: 2000 });
      unmount();
    }
  });

  it('clicking the headline marks it read but waits a moment to remove it, so the article can open first', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mount({ tab: 'latest', q: '' }); await screen.findByText('Story 1');
    const link = within(card(1)).getByRole('link', { name: 'Story 1' });
    fireEvent.click(link);
    await waitFor(() => expect(calls.read).toEqual([{ id: 1, read: true }]));
    expect(link.isConnected).toBe(true); expect(titles()).toContain('Story 1'); // still in the DOM right after the click
    await act(async () => { vi.advanceTimersByTime(800); });
    await waitFor(() => expect(titles()).toEqual(['Story 2', 'Story 3']));
  });

  it('a failed request puts the story back and shows the error', async () => {
    (fetch as any).mockImplementation(async (url: string) => (url.includes('/read') ? json({ error: 'boom' }, 500) : json({ items, nextCursor: null, status: {}, hasAnyStories: true, showImages: false, showRead: false })));
    mount({ tab: 'latest', q: '' }); await screen.findByText('Story 1');
    fireEvent.click(markReadButton(1));
    await screen.findByRole('alert');
    expect(titles()).toEqual(['Story 1', 'Story 2', 'Story 3']); expect(screen.queryByRole('status')).toBeNull();
  });
});

describe('Feed: views that keep read stories', () => {
  it('Saved keeps a story in place when it is marked read (dimmed)', async () => {
    mount({ tab: 'saved', q: '' }); await screen.findByText('Story 1');
    fireEvent.click(markReadButton(1));
    await waitFor(() => expect(card(1).className).toMatch(/opacity-60/));
    expect(titles()).toEqual(['Story 1', 'Story 2', 'Story 3']); expect(screen.queryByRole('status')).toBeNull();
    expect(markReadButton(1).textContent).toBe('Mark unread');
  });

  it('search results keep read stories visible', async () => {
    mount({ tab: 'latest', q: 'story' }); await screen.findByText('Story 1', undefined, { timeout: 2000 });
    fireEvent.click(markReadButton(1));
    await waitFor(() => expect(card(1).className).toMatch(/opacity-60/));
    expect(titles()).toEqual(['Story 1', 'Story 2', 'Story 3']);
  });

  it('with "Show read stories" ON, read stories stay in the feed, visibly dimmed', async () => {
    showRead = true; items = [story(1), story(2, { isRead: true }), story(3)];
    mount({ tab: 'latest', q: '' }); await screen.findByText('Story 1');
    expect(card(2).className).toMatch(/opacity-60/); expect(card(1).className).not.toMatch(/opacity-60/);
    fireEvent.click(markReadButton(1));
    await waitFor(() => expect(card(1).className).toMatch(/opacity-60/));
    expect(titles()).toEqual(['Story 1', 'Story 2', 'Story 3']); expect(screen.queryByRole('status')).toBeNull(); // nothing is removed
  });

  it('a read story that gained new information shows Updated and is not dimmed; "Mark read" hides it again', async () => {
    items = [story(1, { isRead: true, isUpdated: true }), story(2)];
    mount({ tab: 'latest', q: '' }); await screen.findByText('Story 1');
    expect(within(card(1)).getByText('Updated')).toBeTruthy(); expect(card(1).className).not.toMatch(/opacity-60/);
    expect(markReadButton(1).textContent).toBe('Mark read');
    fireEvent.click(markReadButton(1));
    await waitFor(() => expect(titles()).toEqual(['Story 2']));
    expect(calls.read).toEqual([{ id: 1, read: true }]);
  });

  it('when everything is read, the empty state explains and links to the preference', async () => {
    items = [];
    const open = vi.fn(); render(<Feed filter={{ tab: 'latest', q: '' }} onStatus={() => {}} onOpenSettings={open} newVersion={0} />);
    await screen.findByText(/all caught up/);
    fireEvent.click(screen.getByRole('button', { name: 'Show read stories' })); expect(open).toHaveBeenCalledWith('preferences');
  });
});
