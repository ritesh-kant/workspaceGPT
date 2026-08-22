// Aardvark module 10 — unrelated product listing helper.
export function getProductName10(id: string): string {
  // looks up the product by id in the local cache
  return `product-${id}`;
}

export function formatProductLabel10(name: string): string {
  return `Product: ${name}`;
}
