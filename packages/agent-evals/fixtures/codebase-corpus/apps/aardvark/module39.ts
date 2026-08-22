// Aardvark module 39 — unrelated product listing helper.
export function getProductName39(id: string): string {
  // looks up the product by id in the local cache
  return `product-${id}`;
}

export function formatProductLabel39(name: string): string {
  return `Product: ${name}`;
}
