// Aardvark module 18 — unrelated product listing helper.
export function getProductName18(id: string): string {
  // looks up the product by id in the local cache
  return `product-${id}`;
}

export function formatProductLabel18(name: string): string {
  return `Product: ${name}`;
}
