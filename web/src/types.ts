export interface Status { newsRefreshing: boolean; marketRefreshing: boolean; lastNewsRefreshAt: number | null; lastMarketFetchAt: number | null; stale: boolean; aiEnabled: boolean }
export interface Story {
  id: number; title: string; summary: string | null; summaryKind: 'ai' | 'excerpt' | 'headline' | null; differences: string | null;
  category: string | null; importance: number; publishedAt: number; updatedAt: number; sourceCount: number;
  isRead: boolean; isUpdated: boolean; bookmarked: boolean; rating: number; imageUrl: string | null;
  primary: { publisher: string; url: string; aggregated: boolean } | null;
  articles: { id: number; publisher: string; title: string; url: string; publishedAt: number; aggregated: boolean; alsoVia: string[] }[];
  why?: { score: number; parts: Record<string, number>; reasons: string[]; bucket: string };
}
export interface FeedResponse { items: Story[]; nextCursor: string | null; status: Status; hasAnyStories: boolean; showImages: boolean; showRead: boolean }
export interface Quote {
  symbol: string; name: string; type: 'equity' | 'etf' | 'mutual_fund' | 'index'; providerSymbol: string; last: number | null; asOf: string | null; fetchedAt: number | null;
  isDailyNav: boolean; isMoneyMarket: boolean; changes: { range: string; change: number; pct: number }[]; error: string | null; errorKind: string | null; note: string | null;
}
export interface Source {
  id: number; name: string; siteUrl: string; feedUrl: string | null; kind: 'rss' | 'aggregator'; aggregatorLabel: string | null; priority: 'high' | 'normal' | 'low';
  enabled: boolean; coverage: 'comprehensive' | 'interest'; categories: string[]; isLocal: boolean; health: 'unknown' | 'ok' | 'stale' | 'error' | 'disabled'; statusReason: string | null; freshnessHours: number | null; freshnessDefaultHours: number;
  lastCheckedAt: number | null; lastSuccessAt: number | null; lastItemAt: number | null; lastError: string | null; articleCount: number;
}
export interface Topic { id: number; name: string; kind: 'category' | 'interest'; description: string; priority: 'high' | 'normal' | 'low'; include: string[]; exclude: string[] }
export interface Prefs {
  weights: { interests: number; importance: number; recency: number; source: number; feedback: number };
  quotas: { personalized: number; major: number; local: number };
  preferredPublishers: string[]; mutedPublishers: string[]; theme: 'light' | 'dark' | 'system'; showRead: boolean; showImages: boolean; retentionDays: number; staleMinutes: number;
}
export interface WeatherLocation { label: string; lat: number; lon: number; zip: string | null }
export interface WeatherDay { date: string; code: number; description: string; icon: string; highF: number; lowF: number; precipPct: number | null }
export interface WeatherView {
  location: WeatherLocation; fetchedAt: number | null; stale: boolean; refreshing: boolean; error: string | null;
  forecast: { timezone: string; current: { tempF: number; description: string; icon: string }; days: WeatherDay[] } | null;
  attribution: { text: string; url: string }[];
}
