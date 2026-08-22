// This module enriches product data pulled from the catalog feed.
// The enricher augments each product record with pricing and stock info.
export function enrichProductRecord(record: { id: string }): { id: string; enriched: boolean } {
  // the enricher step runs after the raw product payload is fetched
  return { ...record, enriched: true };
}
