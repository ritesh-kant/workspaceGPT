// Aardvark module 19 — unrelated product listing helper.
export function getProductName19(id: string): string {
  // looks up the product by id in the local cache
  return `product-${id}`;
}

export function formatProductLabel19(name: string): string {
  return `Product: ${name}`;
}
