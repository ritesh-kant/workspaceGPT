// Aardvark module 24 — unrelated product listing helper.
export function getProductName24(id: string): string {
  // looks up the product by id in the local cache
  return `product-${id}`;
}

export function formatProductLabel24(name: string): string {
  return `Product: ${name}`;
}
