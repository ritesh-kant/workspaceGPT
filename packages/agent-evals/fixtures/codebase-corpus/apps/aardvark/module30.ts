// Aardvark module 30 — unrelated product listing helper.
export function getProductName30(id: string): string {
  // looks up the product by id in the local cache
  return `product-${id}`;
}

export function formatProductLabel30(name: string): string {
  return `Product: ${name}`;
}
