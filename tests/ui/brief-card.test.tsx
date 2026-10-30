// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import StoryCard from '../../web/src/components/StoryCard';
import Weather from '../../web/src/components/Weather';
import type { Story, WeatherView } from '../../web/src/types';

const LONG = 'The council voted on Thursday night to fund extensive repairs to the harbor boardwalk, with work expected to begin this spring and finish before the summer market opens to visitors from across the region.';
const story = (o: Partial<Story> = {}): Story => ({
  id: 1, title: 'Harbor boardwalk repairs approved', summary: LONG, summaryKind: 'excerpt', differences: null, category: null, importance: 0.5, publishedAt: Date.now() - 60_000, updatedAt: 1, sourceCount: 3, isRead: false, isUpdated: false,
  bookmarked: false, rating: 0, imageUrl: null, blockedBy: [], mutedSources: 0, primary: { publisher: 'Alpha', url: 'https://example.com/1', aggregated: false },
  articles: [{ id: 1, publisher: 'Alpha', title: 'A', url: 'https://example.com/a', publishedAt: 1, aggregated: false, alsoVia: [], muted: false }, { id: 2, publisher: 'Beta', title: 'B', url: 'https://example.com/b', publishedAt: 1, aggregated: false, alsoVia: [], muted: false }], ...o,
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
let calls: { url: string; body: any }[]; let changed: Story[]; let gone: number[]; let reads: boolean[];
beforeEach(() => {
  calls = []; changed = []; gone = []; reads = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => { calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null }); return json(url.endsWith('/why') ? { score: 0.5, parts: { interests: 0.5 }, reasons: ['Very recent'], bucket: 'other' } : { ok: true }); }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const mount = (s: Story = story()) => render(<StoryCard variant="brief" story={s} showImages onChange={(x) => changed.push(x)} onGone={(id) => gone.push(id)} onRead={(_s, r) => reads.push(r)} />);
const card = () => screen.getByRole('article');
const items = (menu: HTMLElement) => [...menu.querySelectorAll<HTMLElement>('[role^="menuitem"]')];
const open = () => { fireEvent.click(within(card()).getByRole('button', { name: 'More actions' })); return screen.getByRole('menu', { name: 'More actions' }); };

describe('brief card: summary attribution', () => {
  it('REGRESSION: the "Publisher excerpt" label sits outside the clamped paragraph, so it is visible however long the summary is', () => {
    mount(); const summary = screen.getByText(LONG); expect(summary.className).toMatch(/line-clamp-3/); expect(summary.textContent).not.toMatch(/Publisher excerpt/);
    const label = within(card()).getByText('Publisher excerpt'); expect(summary.contains(label)).toBe(false); expect(label.closest('p')!.className).not.toMatch(/line-clamp/);
  });
  it('names AI summaries and headline-only stories correctly', () => {
    mount(story({ summaryKind: 'ai' })); expect(screen.getByText('AI summary')).toBeTruthy(); cleanup();
    mount(story({ summary: 'Short.', summaryKind: 'excerpt' })); expect(screen.getByText('Publisher excerpt')).toBeTruthy(); expect(screen.queryByRole('button', { name: 'Read more' })).toBeNull(); // short: nothing to expand
  });
  it('a long summary can be expanded and collapsed, without changing its text', () => {
    mount(); const more = screen.getByRole('button', { name: 'Read more' }); expect(more.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(more); expect(screen.getByText(LONG).className).not.toMatch(/line-clamp/); expect(screen.getByRole('button', { name: 'Show less' }).getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Show less' })); expect(screen.getByText(LONG).className).toMatch(/line-clamp-3/);
  });
  it('the lead and Compact Feed cards keep the label too, unclamped', () => {
    render(<StoryCard variant="lead" story={story()} showImages onChange={() => {}} onGone={() => {}} />); expect(screen.getByText('Publisher excerpt')).toBeTruthy(); expect(screen.getByText(LONG).className).not.toMatch(/line-clamp/);
  });
});

describe('brief card: controls', () => {
  it('shows only Mark read and Save; everything else is in a menu', () => {
    mount(); const c = within(card());
    expect(c.getByRole('button', { name: 'Mark read' })).toBeTruthy(); expect(c.getByRole('button', { name: 'Bookmark' })).toBeTruthy();
    for (const name of ['Thumbs up', 'Thumbs down', 'Hide story', 'Why recommended?']) expect(c.queryByRole('button', { name })).toBeNull();
    expect(c.getByRole('button', { name: 'More actions' }).getAttribute('aria-haspopup')).toBe('menu');
  });
  it('the menu lists every secondary action and is rendered outside the card, so no card container can clip it', () => {
    mount(); const menu = open(); expect(card().contains(menu)).toBe(false); expect(menu.parentElement).toBe(document.body);
    expect(items(menu).map((i) => i.getAttribute('aria-label') ?? i.textContent)).toEqual(['Thumbs up', 'Thumbs down', 'Why recommended?', 'Coverage (3 sources)', 'Hide story']);
  });
  it('REGRESSION: Mark read and Save act directly (Undo is the parent\'s toast, unchanged)', async () => {
    mount(); fireEvent.click(within(card()).getByRole('button', { name: 'Mark read' })); expect(reads).toEqual([true]);
    fireEvent.click(within(card()).getByRole('button', { name: 'Bookmark' })); await waitFor(() => expect(calls.map((c) => c.url)).toEqual(['/api/stories/1/bookmark'])); expect(calls[0].body).toEqual({ on: true }); expect(changed[0].bookmarked).toBe(true);
  });
  it('thumbs up, thumbs down, Why recommended?, Coverage and Hide all still work from the menu', async () => {
    mount(); fireEvent.click(within(open()).getByRole('menuitemcheckbox', { name: 'Thumbs up' })); await waitFor(() => expect(calls.at(-1)).toMatchObject({ url: '/api/stories/1/feedback', body: { rating: 1 } }));
    expect(screen.queryByRole('menu')).toBeNull(); // closes after a choice
    fireEvent.click(within(open()).getByRole('menuitemcheckbox', { name: 'Thumbs down' })); await waitFor(() => expect(calls.at(-1)).toMatchObject({ body: { rating: -1 } }));
    fireEvent.click(within(open()).getByRole('menuitem', { name: 'Why recommended?' })); await waitFor(() => expect(calls.at(-1)?.url).toBe('/api/stories/1/why')); // the explanation request is made
  });
  it('shows the current rating as a checked menu item', () => {
    mount(story({ rating: 1 })); const menu = open(); expect(within(menu).getByRole('menuitemcheckbox', { name: 'Thumbs up' }).getAttribute('aria-checked')).toBe('true'); expect(within(menu).getByRole('menuitemcheckbox', { name: 'Thumbs down' }).getAttribute('aria-checked')).toBe('false');
  });
  it('Coverage expands the source list and Hide removes the story', async () => {
    mount(); fireEvent.click(within(open()).getByRole('menuitem', { name: /Coverage/ })); expect(within(card()).getByText('Beta')).toBeTruthy();
    fireEvent.click(within(open()).getByRole('menuitem', { name: 'Hide coverage' })); expect(within(card()).queryByText('Beta')).toBeNull();
    fireEvent.click(within(open()).getByRole('menuitem', { name: 'Hide story' })); await waitFor(() => expect(gone).toEqual([1]));
  });
  it('a story with one source has no Coverage item', () => { mount(story({ sourceCount: 1, articles: story().articles.slice(0, 1) })); expect(within(open()).queryByRole('menuitem', { name: /Coverage/ })).toBeNull(); });
  it('keyboard: ArrowDown opens and focuses the first item, arrows/Home/End move, Escape closes and returns focus', () => {
    mount(); const btn = within(card()).getByRole('button', { name: 'More actions' }); btn.focus(); fireEvent.keyDown(btn, { key: 'ArrowDown' });
    const menu = screen.getByRole('menu'); const its = items(menu); expect(document.activeElement).toBe(its[0]);
    fireEvent.keyDown(menu, { key: 'ArrowDown' }); expect(document.activeElement).toBe(its[1]); fireEvent.keyDown(menu, { key: 'End' }); expect(document.activeElement).toBe(its.at(-1));
    fireEvent.keyDown(menu, { key: 'ArrowDown' }); expect(document.activeElement).toBe(its[0]); // wraps
    fireEvent.keyDown(menu, { key: 'Escape' }); expect(screen.queryByRole('menu')).toBeNull(); expect(document.activeElement).toBe(btn);
  });
  it('clicking elsewhere closes the menu, and Enter on the focused item selects it', async () => {
    mount(); open(); fireEvent.pointerDown(document.body); expect(screen.queryByRole('menu')).toBeNull();
    open(); fireEvent.keyDown(screen.getByRole('menu'), { key: 'ArrowDown' }); fireEvent.click(document.activeElement as HTMLElement); await waitFor(() => expect(calls.at(-1)?.body).toMatchObject({ rating: -1 }));
  });
});

describe('weather strip freshness', () => {
  const view = (o: Partial<WeatherView> = {}): WeatherView => ({
    location: { label: 'Des Moines, WA', lat: 1, lon: 2, zip: '98198' }, fetchedAt: Date.now() - 12 * 60_000, stale: false, refreshing: false, error: null,
    forecast: { timezone: 'x', current: { tempF: 52, description: 'Overcast', icon: '☁️' }, days: [{ date: '2026-10-30', code: 3, description: 'Overcast', icon: '☁️', highF: 54, lowF: 43, precipPct: 20 }] }, attribution: [], ...o });
  const mountWeather = async (v: WeatherView, ready = true) => { calls = []; (fetch as any).mockImplementation(async (url: string) => { calls.push({ url, body: null }); return json(v); }); render(<Weather variant="strip" version={0} />); if (ready) await screen.findByLabelText('Weather summary'); };
  it('REGRESSION: shows when the forecast was last updated, from the data already loaded, with a single request', async () => {
    await mountWeather(view()); expect(screen.getByText('Updated 12m ago')).toBeTruthy(); expect(screen.queryByText(/Cached forecast/)).toBeNull(); expect(screen.queryByText(/Refresh failed/)).toBeNull(); expect(calls.map((c) => c.url)).toEqual(['/api/weather']);
  });
  it('labels a stale forecast "Cached forecast" (and says when it is updating)', async () => {
    await mountWeather(view({ stale: true, fetchedAt: Date.now() - 3 * 3_600_000 })); expect(screen.getByText('Cached forecast')).toBeTruthy(); expect(screen.getByText('Updated 3h ago')).toBeTruthy(); cleanup();
    await mountWeather(view({ stale: true, refreshing: true })); expect(screen.getByText(/Cached forecast · updating/)).toBeTruthy();
  });
  it('shows a compact warning when the last refresh failed, still showing the cached forecast', async () => {
    await mountWeather(view({ stale: true, error: 'Open-Meteo returned HTTP 503' })); const warn = screen.getByText('⚠ Refresh failed'); expect(warn.getAttribute('title')).toMatch(/503/); expect(screen.getByText(/52°F/)).toBeTruthy();
  });
  it('with no forecast at all, a failure is still reported', async () => {
    await mountWeather(view({ forecast: null, fetchedAt: null, error: 'unreachable' }), false); expect(await screen.findByText(/Weather unavailable: unreachable/)).toBeTruthy();
  });
});
