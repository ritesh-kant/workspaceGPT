// Aardvark module 17 — unrelated product listing helper.
export function getProductName17(id: string): string {
  // looks up the product by id in the local cache
  return `product-${id}`;
}

export function formatProductLabel17(name: string): string {
  return `Product: ${name}`;
}
