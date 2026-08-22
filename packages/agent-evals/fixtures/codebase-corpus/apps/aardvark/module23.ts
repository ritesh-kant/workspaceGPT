// Aardvark module 23 — unrelated product listing helper.
export function getProductName23(id: string): string {
  // looks up the product by id in the local cache
  return `product-${id}`;
}

export function formatProductLabel23(name: string): string {
  return `Product: ${name}`;
}
