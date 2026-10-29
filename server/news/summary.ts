/** Fallback summaries taken ONLY from publisher-provided text. Never invents content. */
export function sentencesFallback(excerpt: string | null, _title: string): { text: string | null; kind: 'excerpt' | 'headline' } {
  const clean = (excerpt ?? '').replace(/\s*(The post .* appeared first on .*|Read more.*|Continue reading.*)$/i, '').trim();
  if (clean.length < 40) return { text: null, kind: 'headline' };
  const sentences = clean.match(/[^.!?]+[.!?]+(\s|$)|[^.!?]+$/g)?.map((s) => s.trim()).filter(Boolean) ?? [clean];
  let out = '';
  for (const s of sentences.slice(0, 4)) { if ((out + ' ' + s).length > 480 && out) break; out = (out + ' ' + s).trim(); }
  return { text: out.length > 500 ? out.slice(0, 497).trimEnd() + '…' : out, kind: 'excerpt' };
}
