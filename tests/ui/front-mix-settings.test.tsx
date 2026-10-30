// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import Settings from '../../web/src/components/Settings';

const DEFAULTS = { weights: { local: 5, regional: 4, washington: 3, us: 4, world: 4, politics: 2, business: 5, technology: 5, sports: 2, other: 2 }, majorException: true, majorThreshold: 0.8 };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
let puts: any[]; let stored: typeof DEFAULTS;
beforeEach(() => {
  puts = []; stored = structuredClone(DEFAULTS);
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/front-mix' && init?.method === 'PUT') { stored = JSON.parse(String(init.body)); puts.push(stored); return json({ mix: stored, defaults: DEFAULTS }); }
    if (url === '/api/front-mix') return json({ mix: stored, defaults: DEFAULTS });
    return json({ error: 'unexpected ' + url }, 500);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const mount = () => render(<Settings panel="frontmix" setPanel={() => {}} onClose={() => {}} onChanged={() => {}} onTheme={() => {}} />);
const slider = (name: string) => screen.getByRole('slider', { name }) as HTMLInputElement;

describe('Settings → Front Page Mix', () => {
  it('lists every category as a 0-5 slider starting at the defaults, and is reachable from the Settings menu', async () => {
    mount(); await screen.findByRole('slider', { name: 'Local' });
    expect(screen.getAllByRole('slider').map((s) => (s as HTMLInputElement).value)).toEqual(['5', '4', '3', '4', '4', '2', '5', '5', '2', '2']);
    expect(screen.getAllByRole('slider').map((s) => [s.getAttribute('min'), s.getAttribute('max')])[0]).toEqual(['0', '5']);
    expect(screen.getByRole('button', { name: 'Front Page Mix' })).toBeTruthy();
  });
  it('explains that 0 only leaves the Front Page, and labels a zero weight', async () => {
    mount(); await screen.findByRole('slider', { name: 'Sports' }); expect(screen.getByText(/0 leaves the category off the Front Page only/)).toBeTruthy();
    fireEvent.change(slider('Sports'), { target: { value: '0' } }); expect(screen.getByText('Off Front Page')).toBeTruthy(); expect(slider('Sports').getAttribute('aria-valuetext')).toBe('off the Front Page');
  });
  it('saves exactly what was set (including the major-story exception) and reports success', async () => {
    mount(); await screen.findByRole('slider', { name: 'Politics' });
    fireEvent.change(slider('Politics'), { target: { value: '5' } }); fireEvent.click(screen.getByRole('checkbox')); fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(puts).toHaveLength(1)); expect(puts[0].weights.politics).toBe(5); expect(puts[0].majorException).toBe(false); expect(puts[0].weights.local).toBe(5); expect(await screen.findByRole('status')).toBeTruthy();
  });
  it('resets to the defaults in one click', async () => {
    stored = { ...structuredClone(DEFAULTS), weights: { ...DEFAULTS.weights, local: 0, business: 1 } }; mount(); await screen.findByRole('slider', { name: 'Local' }); expect(slider('Local').value).toBe('0');
    fireEvent.click(screen.getByRole('button', { name: 'Reset to defaults' })); await waitFor(() => expect(puts).toHaveLength(1)); expect(puts[0]).toEqual(DEFAULTS); await waitFor(() => expect(slider('Local').value).toBe('5'));
  });
  it('the major-story threshold is only editable while the exception is on', async () => {
    mount(); const select = (await screen.findByRole('combobox')) as HTMLSelectElement; expect(select.disabled).toBe(false); fireEvent.click(screen.getByRole('checkbox')); expect(select.disabled).toBe(true);
  });
});
