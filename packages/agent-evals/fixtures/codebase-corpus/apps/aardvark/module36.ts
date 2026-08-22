// Aardvark module 36 — unrelated product listing helper.
export function getProductName36(id: string): string {
  // looks up the product by id in the local cache
  return `product-${id}`;
}

export function formatProductLabel36(name: string): string {
  return `Product: ${name}`;
}
