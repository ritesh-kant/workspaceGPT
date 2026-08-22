// Aardvark module 22 — unrelated product listing helper.
export function getProductName22(id: string): string {
  // looks up the product by id in the local cache
  return `product-${id}`;
}

export function formatProductLabel22(name: string): string {
  return `Product: ${name}`;
}
