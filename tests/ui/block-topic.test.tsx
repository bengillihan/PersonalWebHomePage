// @vitest-environment jsdom
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import StoryCard from '../../web/src/components/StoryCard';
import Settings from '../../web/src/components/Settings';
import type { BlockedTopic, Story } from '../../web/src/types';

const story = (o: Partial<Story> = {}): Story => ({
  id: 7, title: 'Seahawks beat 49ers in overtime thriller', summary: 'A summary.', summaryKind: 'excerpt', differences: null, category: 'Sports', importance: 0.5,
  publishedAt: Date.now() - 60_000, updatedAt: 1, sourceCount: 1, isRead: false, isUpdated: false, bookmarked: false, rating: 0, imageUrl: null, blockedBy: [],
  primary: { publisher: 'General News', url: 'https://example.com/7', aggregated: false },
  articles: [{ id: 7, publisher: 'General News', title: 'x', url: 'https://example.com/7', publishedAt: 1, aggregated: false, alsoVia: [] }], ...o,
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface Calls { post: any[]; patch: any[]; put: any[]; del: string[]; preview: any[] }
let calls: Calls; let topics: BlockedTopic[];
const hockey = (o: Partial<BlockedTopic> = {}): BlockedTopic => ({ id: 1, name: 'Hockey / NHL', description: 'Hockey and NHL news', keywords: ['hockey', 'nhl', 'stanley cup'], categories: [], enabled: true, seeded: true, blockedArticles: 12, ...o });

beforeEach(() => {
  calls = { post: [], patch: [], put: [], del: [], preview: [] }; topics = [hockey()];
  vi.stubGlobal('confirm', () => true);
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'; const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (url === '/api/stories/7/block-suggestion') return json({ name: 'Seahawks', keywords: ['seahawks'], category: 'Sports' });
    if (url === '/api/blocked-topics/preview') { calls.preview.push(body); return json({ keywords: body.description ? String(body.description).split(',').map((s: string) => s.trim()).filter(Boolean) : [], categories: body.categories, matches: body.categories?.length ? 9 : 3, samples: [{ title: 'Seahawks win again', publisher: 'General News' }] }); }
    if (url === '/api/blocked-topics' && method === 'POST') { calls.post.push(body); return json({ id: 2, ...body, keywords: [], enabled: true, seeded: false, blockedArticles: 0 }, 201); }
    if (url === '/api/blocked-topics' && method === 'GET') return json(topics);
    const m = /^\/api\/blocked-topics\/(\d+)$/.exec(url);
    if (m && method === 'PATCH') { calls.patch.push({ id: Number(m[1]), ...body }); topics = topics.map((t) => (t.id === Number(m[1]) ? { ...t, enabled: body.enabled } : t)); return json(topics[0]); }
    if (m && method === 'PUT') { calls.put.push({ id: Number(m[1]), ...body }); topics = topics.map((t) => (t.id === Number(m[1]) ? { ...t, ...body } : t)); return json(topics[0]); }
    if (m && method === 'DELETE') { calls.del.push(m[1]); topics = []; return json({ ok: true }); }
    if (/\/feedback$/.test(url)) return json({ ok: true });
    if (url === '/api/topics') return json([]);
    return json({ error: 'unexpected ' + method + ' ' + url }, 500);
  }));
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

function Card({ onGone, initial }: { onGone: (id: number) => void; initial?: Story }) {
  const [s, setS] = useState(initial ?? story());
  return <StoryCard story={s} showImages={false} onChange={setS} onGone={onGone} />;
}
const openForm = async (onGone = vi.fn()) => {
  render(<Card onGone={onGone} />);
  fireEvent.click(screen.getByRole('button', { name: 'Thumbs down' }));
  fireEvent.click(await screen.findByRole('button', { name: /Never show this topic/ }));
  await waitFor(() => expect((screen.getByLabelText(/Name/) as HTMLInputElement).value).toBe('Seahawks'));
  return onGone;
};

describe('thumbs-down menu: "Never show this topic"', () => {
  it('is offered next to the soft reasons, pre-filled from the headline and classification, with a preview of what it would hide', async () => {
    await openForm();
    expect((screen.getByLabelText(/Hide stories about/) as HTMLInputElement).value).toBe('seahawks');
    expect(screen.getByRole('checkbox', { name: /classified as Sports/ })).toBeTruthy(); // suggestion from the stored classification
    await waitFor(() => expect(screen.getByRole('group', { name: 'Never show this topic' }).textContent).toMatch(/Would hide 3 recent stories/));
    expect(screen.getByRole('group', { name: 'Never show this topic' }).textContent).toMatch(/Seahawks win again/);
    expect(calls.post).toEqual([]); // nothing saved yet; the soft reasons are still there too
    expect(screen.getByRole('button', { name: 'Low importance' })).toBeTruthy();
  });

  it('REGRESSION: confirming creates a hard block from plain language, then removes the story', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const onGone = await openForm();
    fireEvent.change(screen.getByLabelText(/Hide stories about/), { target: { value: 'seahawks, Seattle football' } });
    fireEvent.click(screen.getByRole('button', { name: 'Block this topic' }));
    await waitFor(() => expect(calls.post).toEqual([{ name: 'Seahawks', description: 'seahawks, Seattle football', categories: [] }]));
    expect((await screen.findByRole('status')).textContent).toMatch(/Blocked “Seahawks”/);
    expect(onGone).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(1300); });
    expect(onGone).toHaveBeenCalledWith(7);
  });

  it('can also block by the classification (broad, previewed first)', async () => {
    await openForm();
    fireEvent.click(screen.getByRole('checkbox', { name: /classified as Sports/ }));
    await waitFor(() => expect(screen.getByRole('group', { name: 'Never show this topic' }).textContent).toMatch(/Would hide 9 recent stories/));
    expect(calls.preview.at(-1).categories).toEqual(['Sports']);
    fireEvent.click(screen.getByRole('button', { name: 'Block this topic' }));
    await waitFor(() => expect(calls.post[0]).toMatchObject({ categories: ['Sports'] }));
  });

  it('cancel closes it without saving anything, and soft thumbs-down feedback is unaffected', async () => {
    await openForm();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('group', { name: 'Never show this topic' })).toBeNull(); expect(calls.post).toEqual([]);
    expect((fetch as any).mock.calls.some(([u]: [string]) => u === '/api/blocked-topics' )).toBe(false);
  });

  it('a story that is normally hidden but shown (search/Saved) is labelled with the blocking topic', () => {
    render(<Card onGone={() => {}} initial={story({ blockedBy: ['Hockey / NHL'] })} />);
    expect(screen.getByText('Blocked: Hockey / NHL')).toBeTruthy();
    cleanup(); render(<Card onGone={() => {}} />); expect(screen.queryByText(/^Blocked:/)).toBeNull();
  });
});

describe('Settings → Interests → Not interested', () => {
  const mount = () => render(<Settings panel="interests" setPanel={() => {}} onClose={() => {}} onChanged={() => {}} onTheme={() => {}} />);
  const section = async () => (await screen.findByRole('heading', { name: 'Not interested' })).parentElement!.parentElement!;

  it('shows the seeded Hockey / NHL topic with its keywords and match count', async () => {
    mount(); const s = await section();
    await waitFor(() => expect(within(s).getByText('Hockey / NHL')).toBeTruthy());
    expect(within(s).getByText('starter')).toBeTruthy(); expect(within(s).getByText('12 articles matched')).toBeTruthy();
    expect(s.textContent).toMatch(/Matches: hockey, nhl, stanley cup/); expect(s.textContent).toMatch(/search and Saved still find them/);
  });

  it('adds a topic from plain language after previewing it', async () => {
    mount(); const s = await section();
    fireEvent.change(within(s).getByPlaceholderText('Cricket'), { target: { value: 'Cricket' } });
    fireEvent.change(within(s).getByPlaceholderText('cricket, IPL, test match'), { target: { value: 'cricket, IPL' } });
    fireEvent.click(within(s).getByRole('button', { name: 'Preview' }));
    await waitFor(() => expect(s.textContent).toMatch(/Would hide 3 recent stories/));
    fireEvent.click(within(s).getByRole('button', { name: 'Block topic' }));
    await waitFor(() => expect(calls.post).toEqual([{ name: 'Cricket', description: 'cricket, IPL' }]));
  });

  it('enables/disables, edits and deletes topics', async () => {
    mount(); const s = await section(); await waitFor(() => within(s).getByText('Hockey / NHL'));
    fireEvent.click(within(s).getByRole('checkbox', { name: 'Blocking' }));
    await waitFor(() => expect(calls.patch).toEqual([{ id: 1, enabled: false }]));
    fireEvent.click(within(s).getByRole('button', { name: 'Edit' }));
    fireEvent.change(within(s).getByLabelText(/Words and phrases matched/), { target: { value: 'hockey, nhl, ahl' } });
    fireEvent.click(within(s).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.put).toEqual([{ id: 1, name: 'Hockey / NHL', description: 'Hockey and NHL news', keywords: ['hockey', 'nhl', 'ahl'], categories: [] }]));
    fireEvent.click(await within(s).findByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(calls.del).toEqual(['1']));
  });
});
