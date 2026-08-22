// Aardvark module 16 — unrelated product listing helper.
export function getProductName16(id: string): string {
  // looks up the product by id in the local cache
  return `product-${id}`;
}

export function formatProductLabel16(name: string): string {
  return `Product: ${name}`;
}
