// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import App from '../../web/src/App';
import StoryCard from '../../web/src/components/StoryCard';
import { ReadOnlyContext } from '../../web/src/readonly';
import type { Story } from '../../web/src/types';

const story = (id: number, o: Partial<Story> = {}): Story => ({
  id, title: `Story ${id}`, summary: `Summary of story ${id}.`, summaryKind: 'excerpt', differences: null, category: null, importance: 0.5,
  publishedAt: Date.now() - id * 60_000, updatedAt: 1, sourceCount: 2, isRead: false, isUpdated: false, bookmarked: false, rating: 0, imageUrl: null, blockedBy: [], mutedSources: 0,
  primary: { publisher: `Pub ${id}`, url: `https://example.com/${id}`, aggregated: false },
  articles: [{ id, publisher: `Pub ${id}`, title: `Story ${id}`, url: `https://example.com/${id}`, publishedAt: 1, aggregated: false, alsoVia: [], muted: false }, { id: id + 100, publisher: 'Other', title: 'Same story', url: 'https://other.example/1', publishedAt: 1, aggregated: false, alsoVia: [], muted: false }], ...o,
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const status = { newsRefreshing: false, marketRefreshing: false, lastNewsRefreshAt: 1, lastMarketFetchAt: null, stale: false, aiEnabled: false };

let requests: { url: string; method: string }[];
beforeEach(() => {
  requests = [];
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, String(v)), removeItem: (k: string) => void store.delete(k), clear: () => store.clear() });
  vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} unobserve() {} });
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    requests.push({ url, method: init?.method ?? 'GET' });
    if (url === '/api/me') return json({ anonymous: true, email: null, name: null, csrfToken: null, theme: 'system' });
    if (url === '/api/frontpage') return json({ lead: story(1), secondary: [story(2)], sections: [{ key: 'local', label: 'Local', items: [story(3)] }], status, hasAnyStories: true, showImages: false, showRead: true });
    if (url.startsWith('/api/feed')) return json({ items: [story(20), story(21)], nextCursor: null, status, hasAnyStories: true, showImages: false, showRead: true });
    if (url === '/api/weather') return json({ location: { label: 'Des Moines, WA', lat: null, lon: null, zip: null }, forecast: null, fetchedAt: null, stale: true, refreshing: false, error: null, attribution: [] });
    return json({ error: 'unauthenticated' }, 401); // everything private
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('read-only story card', () => {
  const card = (readOnly: boolean, variant: 'card' | 'lead' | 'brief') => render(<ReadOnlyContext.Provider value={readOnly}><StoryCard variant={variant} story={story(1)} showImages={false} onChange={() => {}} onGone={() => {}} /></ReadOnlyContext.Provider>);
  for (const v of ['card', 'lead', 'brief'] as const) {
    it(`${v}: no read, save, rating, hide or ungroup controls, but the headline link and coverage still work`, async () => {
      card(true, v);
      for (const name of [/mark read/i, /mark unread/i, /bookmark/i, /thumbs up/i, /thumbs down/i, /hide story/i, /why recommended/i]) expect(screen.queryByRole('button', { name }), String(name)).toBeNull();
      expect(screen.getByRole('link', { name: 'Story 1' }).getAttribute('href')).toBe('https://example.com/1');
      fireEvent.click(screen.getByRole('link', { name: 'Story 1' })); expect(requests).toEqual([]); // opening an article marks nothing read
      if (v === 'brief') { fireEvent.click(screen.getByRole('button', { name: 'More actions' })); fireEvent.click(screen.getByRole('menuitem', { name: /coverage/i })); } else fireEvent.click(screen.getByRole('button', { name: /coverage/i }));
      expect(screen.getByRole('link', { name: 'Same story' })).toBeTruthy(); expect(screen.queryByRole('button', { name: /ungroup/i })).toBeNull();
    });
  }
  it('the owner still gets every control', () => {
    card(false, 'card');
    for (const name of [/mark read/i, /bookmark/i, /thumbs up/i, /thumbs down/i, /hide story/i, /why recommended/i]) expect(screen.getByRole('button', { name }), String(name)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /see coverage/i })); expect(screen.getAllByRole('button', { name: /ungroup/i })).toHaveLength(2);
  });
});

describe('App for a visitor who is not signed in', () => {
  it('shows the front page and sections read-only: Sign in instead of Settings, Refresh and Sign out, and no Saved, Unread or markets', async () => {
    render(<App />); await screen.findByRole('article', { name: 'Story 1' });
    expect(screen.getAllByRole('link', { name: /sign in/i }).every((a) => a.getAttribute('href') === '/auth/login')).toBe(true);
    for (const name of [/settings/i, /refresh/i, /sign out/i, /^saved$/i, /^unread$/i, /bookmark/i, /mark read/i]) expect(screen.queryByRole('button', { name }), String(name)).toBeNull();
    expect(screen.getByRole('note').textContent).toMatch(/read-only/i);
    fireEvent.click(screen.getByRole('tab', { name: 'Business' })); await screen.findByRole('article', { name: 'Story 20' });
    await waitFor(() => expect(requests.some((r) => r.url === '/api/weather')).toBe(true));
    const urls = requests.map((r) => r.url); expect(urls.filter((u) => /market|topics|sources|prefs|front-mix|geo|refresh|diagnostics/.test(u))).toEqual([]); // nothing private is even requested
    expect(requests.filter((r) => r.method !== 'GET')).toEqual([]);
  });
  it('the compact feed keeps its public tabs and drops Saved, Unread and interest tabs', async () => {
    localStorage.setItem('view', 'compact'); render(<App />); await screen.findByRole('article', { name: 'Story 20' });
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['For You', 'Latest', 'Local', 'Explore']);
    expect(requests.filter((r) => r.method !== 'GET')).toEqual([]);
  });
});
