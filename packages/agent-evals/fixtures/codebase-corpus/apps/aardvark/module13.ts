// Aardvark module 13 — unrelated product listing helper.
export function getProductName13(id: string): string {
  // looks up the product by id in the local cache
  return `product-${id}`;
}

export function formatProductLabel13(name: string): string {
  return `Product: ${name}`;
}
