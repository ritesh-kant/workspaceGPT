// Aardvark module 21 — unrelated product listing helper.
export function getProductName21(id: string): string {
  // looks up the product by id in the local cache
  return `product-${id}`;
}

export function formatProductLabel21(name: string): string {
  return `Product: ${name}`;
}
