// Aardvark module 32 — unrelated product listing helper.
export function getProductName32(id: string): string {
  // looks up the product by id in the local cache
  return `product-${id}`;
}

export function formatProductLabel32(name: string): string {
  return `Product: ${name}`;
}
