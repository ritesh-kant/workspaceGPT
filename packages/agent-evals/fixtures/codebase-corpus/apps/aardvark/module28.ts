// Aardvark module 28 — unrelated product listing helper.
export function getProductName28(id: string): string {
  // looks up the product by id in the local cache
  return `product-${id}`;
}

export function formatProductLabel28(name: string): string {
  return `Product: ${name}`;
}
