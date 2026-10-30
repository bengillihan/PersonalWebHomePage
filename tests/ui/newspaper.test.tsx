// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import App from '../../web/src/App';
import Nav from '../../web/src/components/Nav';
import FrontPage from '../../web/src/components/FrontPage';
import type { FrontPageData, Story } from '../../web/src/types';

const story = (id: number, o: Partial<Story> = {}): Story => ({
  id, title: `Story ${id}`, summary: `Summary of story ${id}.`, summaryKind: 'excerpt', differences: null, category: null, importance: 0.5,
  publishedAt: Date.now() - id * 60_000, updatedAt: 1, sourceCount: 1, isRead: false, isUpdated: false, bookmarked: false, rating: 0, imageUrl: null, blockedBy: [], mutedSources: 0,
  primary: { publisher: `Pub ${id}`, url: `https://example.com/${id}`, aggregated: false },
  articles: [{ id, publisher: `Pub ${id}`, title: `Story ${id}`, url: `https://example.com/${id}`, publishedAt: 1, aggregated: false, alsoVia: [], muted: false }], ...o,
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const status = { newsRefreshing: false, marketRefreshing: false, lastNewsRefreshAt: 1, lastMarketFetchAt: null, stale: false, aiEnabled: true };

let front: FrontPageData; let requests: string[]; let reads: { id: number; read: boolean }[]; let showRead: boolean;
beforeEach(() => {
  requests = []; reads = []; showRead = false;
  front = { lead: story(1, { imageUrl: 'https://img.example/1.jpg' }), secondary: [story(2), story(3), story(4, { isUpdated: true, isRead: true })], sections: [{ key: 'local', label: 'Local', items: [story(5), story(6)] }, { key: 'business', label: 'Business', items: [story(7)] }], status, hasAnyStories: true, showImages: true, showRead };
  const store = new Map<string, string>(); // this runtime's built-in localStorage is not usable under jsdom
  vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, String(v)), removeItem: (k: string) => void store.delete(k), clear: () => store.clear() });
  vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} unobserve() {} });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    requests.push(url);
    const m = /^\/api\/stories\/(\d+)\/read$/.exec(url);
    if (m) { const b = JSON.parse(String(init?.body)); reads.push({ id: Number(m[1]), read: b.read }); return json({ ok: true }); }
    if (/^\/api\/stories\/\d+\/(bookmark|feedback|hide)$/.test(url)) return json({ ok: true });
    if (url === '/api/me') return json({ email: 'me@example.com', csrfToken: 't', theme: 'light' });
    if (url === '/api/topics') return json([{ id: 1, name: 'AI', kind: 'interest', description: '', priority: 'high', weight: 5, stance: 'prefer', include: [], exclude: [] }]);
    if (url === '/api/frontpage') return json({ ...front, showRead });
    if (url === '/api/market') return json({ provider: { name: 'Twelve Data', configured: true }, quotes: [], lastFetchedAt: null, refreshing: false });
    if (url.startsWith('/api/feed')) return json({ items: [story(20), story(21), story(22)], nextCursor: null, status, hasAnyStories: true, showImages: false, showRead });
    return json({ error: 'unexpected ' + url }, 500);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const feedTabs = () => requests.filter((u) => u.startsWith('/api/feed')).map((u) => new URL('http://x' + u).searchParams.get('tab'));

describe('navigation', () => {
  const NAMES = ['Front Page', 'Local', 'Regional', 'Washington', 'U.S.', 'World', 'Business', 'Technology', 'Sports', 'Weather'];
  it('shows every section in order on the horizontal bar and marks the current one', () => {
    render(<Nav tab="local" onPick={() => {}} />);
    const tabs = within(screen.getByRole('tablist', { name: 'Sections' })).getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(NAMES); expect(tabs.filter((t) => t.getAttribute('aria-selected') === 'true').map((t) => t.textContent)).toEqual(['Local']);
  });
  it('on a phone the tabs live behind one "Sections" button that opens a menu and closes after a choice', () => {
    const picked: string[] = []; render(<Nav tab="front" onPick={(k) => picked.push(k)} />);
    expect(screen.queryByRole('list', { name: 'Section menu' })).toBeNull();
    const button = screen.getByRole('button', { name: 'Sections menu' }); expect(button.getAttribute('aria-expanded')).toBe('false'); expect(button.textContent).toContain('Front Page');
    fireEvent.click(button); const menu = screen.getByRole('list', { name: 'Section menu' });
    expect(within(menu).getAllByRole('button').map((b) => b.textContent)).toEqual(NAMES); expect(button.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(within(menu).getByRole('button', { name: 'Washington' })); expect(picked).toEqual(['washington']); expect(screen.queryByRole('list', { name: 'Section menu' })).toBeNull();
  });
});

describe('App', () => {
  it('opens on the Front Page in Newspaper View, requesting one front-page payload and no section feeds', async () => {
    render(<App />);
    await screen.findByRole('article', { name: 'Story 1' });
    expect(screen.getByRole('tab', { name: 'Front Page' }).getAttribute('aria-selected')).toBe('true');
    expect(requests.filter((u) => u === '/api/frontpage')).toHaveLength(1); expect(feedTabs()).toEqual([]);
    expect(screen.getByRole('region', { name: 'Market watchlist' })).toBeTruthy(); // watchlist near the top
  });
  it('each section tab shows that section\'s feed, with the first story as the lead', async () => {
    render(<App />); await screen.findByRole('article', { name: 'Story 1' });
    fireEvent.click(screen.getByRole('tab', { name: 'Local' }));
    await screen.findByRole('article', { name: 'Story 20' }); expect(feedTabs()).toEqual(['local']);
    expect(screen.getByRole('tab', { name: 'Local' }).getAttribute('aria-selected')).toBe('true'); expect(screen.queryByRole('article', { name: 'Story 1' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Story 20' }).className).toMatch(/text-3xl/); expect(screen.getByRole('heading', { name: 'Story 21' }).className).not.toMatch(/text-3xl/);
    fireEvent.click(screen.getByRole('tab', { name: 'Technology' })); await waitFor(() => expect(feedTabs()).toEqual(['local', 'technology']));
  });
  it('Weather is its own section and does not request the news feed', async () => {
    render(<App />); await screen.findByRole('article', { name: 'Story 1' });
    fireEvent.click(screen.getByRole('tab', { name: 'Weather' })); await waitFor(() => expect(requests).toContain('/api/weather')); expect(feedTabs()).toEqual([]);
  });
  it('Saved, Unread and Search still work from the newspaper view', async () => {
    render(<App />); await screen.findByRole('article', { name: 'Story 1' });
    fireEvent.click(screen.getByRole('button', { name: 'Saved' })); await screen.findByRole('article', { name: 'Story 20' }); expect(feedTabs()).toEqual(['saved']);
    fireEvent.click(screen.getByRole('button', { name: 'Unread' })); await waitFor(() => expect(feedTabs()).toEqual(['saved', 'unread']));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search' }), { target: { value: 'harbor' } });
    await waitFor(() => expect(requests.some((u) => u.includes('q=harbor') && u.includes('tab=latest'))).toBe(true));
  });
  it('a visible switch changes between Newspaper View and Compact Feed, and the choice is remembered', async () => {
    const first = render(<App />); await screen.findByRole('article', { name: 'Story 1' });
    expect(screen.getByRole('button', { name: 'Newspaper' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Compact feed' }));
    await screen.findByRole('article', { name: 'Story 20' }); expect(feedTabs()).toEqual(['foryou']);
    expect(screen.getByRole('tab', { name: 'For You' }).getAttribute('aria-selected')).toBe('true'); expect(screen.queryByRole('tab', { name: 'Weather' })).toBeNull();
    expect(localStorage.getItem('view')).toBe('compact');
    first.unmount(); render(<App />); await screen.findByRole('article', { name: 'Story 20' }); expect(screen.getByRole('button', { name: 'Compact feed' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Newspaper' })); await screen.findByRole('article', { name: 'Story 1' });
  });
});

describe('Front Page', () => {
  const mount = () => render(<FrontPage version={0} onStatus={() => {}} onOpenSettings={() => {}} onNavigate={() => {}} />);
  it('REGRESSION: lays out a lead, secondary stories and section blocks with each story once, attribution, links, thumbnails and Updated labels', async () => {
    mount(); await screen.findByRole('article', { name: 'Story 1' });
    const titles = screen.getAllByRole('article').map((a) => a.getAttribute('aria-label')); expect(titles).toEqual(['Story 1', 'Story 2', 'Story 3', 'Story 4', 'Story 5', 'Story 6', 'Story 7']); expect(new Set(titles).size).toBe(titles.length);
    expect(screen.getByRole('heading', { name: 'Story 1' }).className).toMatch(/font-serif/);
    expect(within(screen.getByRole('article', { name: 'Story 1' })).getByText('Pub 1')).toBeTruthy();
    expect(within(screen.getByRole('article', { name: 'Story 1' })).getByRole('link', { name: 'Story 1' }).getAttribute('href')).toBe('https://example.com/1');
    expect(screen.getByRole('article', { name: 'Story 1' }).querySelector('img')?.getAttribute('src')).toBe('https://img.example/1.jpg');
    expect(within(screen.getByRole('article', { name: 'Story 4' })).getByText('Updated')).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Local' })).toBeTruthy(); expect(screen.getByRole('region', { name: 'Business' })).toBeTruthy(); expect(screen.queryByRole('region', { name: 'Sports' })).toBeNull();
  });
  it('images off means a clean text layout (no thumbnails)', async () => {
    front = { ...front, showImages: false }; mount(); await screen.findByRole('article', { name: 'Story 1' }); expect(document.querySelector('img')).toBeNull();
  });
  it('REGRESSION: marking a story read removes it at once without reloading, offers Undo, and Undo brings it back', async () => {
    mount(); await screen.findByRole('article', { name: 'Story 2' });
    fireEvent.click(within(screen.getByRole('article', { name: 'Story 2' })).getByRole('button', { name: 'Mark read' }));
    await waitFor(() => expect(screen.queryByRole('article', { name: 'Story 2' })).toBeNull());
    expect(reads).toEqual([{ id: 2, read: true }]); expect(requests.filter((u) => u === '/api/frontpage')).toHaveLength(1);
    expect(screen.getByRole('status').textContent).toContain('Marked as read');
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(reads).toEqual([{ id: 2, read: true }, { id: 2, read: false }])); await waitFor(() => expect(requests.filter((u) => u === '/api/frontpage')).toHaveLength(2));
  });
  it('with "Show read stories" on, a read story stays (dimmed) and no Undo is offered', async () => {
    showRead = true; front = { ...front, showRead: true }; mount(); await screen.findByRole('article', { name: 'Story 2' });
    fireEvent.click(within(screen.getByRole('article', { name: 'Story 2' })).getByRole('button', { name: 'Mark read' }));
    await waitFor(() => expect(reads).toHaveLength(1)); expect(screen.getByRole('article', { name: 'Story 2' }).className).toMatch(/opacity-60/); expect(screen.queryByRole('status')).toBeNull();
  });
  it('saving and rating from the front page use the existing story actions', async () => {
    mount(); await screen.findByRole('article', { name: 'Story 3' });
    fireEvent.click(within(screen.getByRole('article', { name: 'Story 3' })).getByRole('button', { name: 'Bookmark' }));
    await waitFor(() => expect(requests).toContain('/api/stories/3/bookmark')); expect(within(screen.getByRole('article', { name: 'Story 3' })).getByRole('button', { name: 'Bookmark' }).getAttribute('aria-pressed')).toBe('true');
  });
  it('removing the lead promotes the next story rather than leaving a hole', async () => {
    mount(); await screen.findByRole('article', { name: 'Story 1' });
    fireEvent.click(within(screen.getByRole('article', { name: 'Story 1' })).getByRole('button', { name: 'Hide story' }));
    await waitFor(() => expect(screen.queryByRole('article', { name: 'Story 1' })).toBeNull()); expect(screen.getByRole('heading', { name: 'Story 2' }).className).toMatch(/text-3xl/);
  });
  it('an empty page explains itself instead of showing nothing', async () => {
    front = { ...front, lead: null, secondary: [], sections: [] }; mount(); expect((await screen.findByText(/all caught up/)).textContent).toBeTruthy();
  });
});
