// Aardvark module 06 — unrelated product listing helper.
export function getProductName06(id: string): string {
  // looks up the product by id in the local cache
  return `product-${id}`;
}

export function formatProductLabel06(name: string): string {
  return `Product: ${name}`;
}
