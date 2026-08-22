// Aardvark module 07 — unrelated product listing helper.
export function getProductName07(id: string): string {
  // looks up the product by id in the local cache
  return `product-${id}`;
}

export function formatProductLabel07(name: string): string {
  return `Product: ${name}`;
}
