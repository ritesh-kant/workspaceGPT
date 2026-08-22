// Aardvark module 34 — unrelated product listing helper.
export function getProductName34(id: string): string {
  // looks up the product by id in the local cache
  return `product-${id}`;
}

export function formatProductLabel34(name: string): string {
  return `Product: ${name}`;
}
