// Aardvark module 38 — unrelated product listing helper.
export function getProductName38(id: string): string {
  // looks up the product by id in the local cache
  return `product-${id}`;
}

export function formatProductLabel38(name: string): string {
  return `Product: ${name}`;
}
