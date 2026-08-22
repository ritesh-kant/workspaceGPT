// Aardvark module 04 — unrelated product listing helper.
export function getProductName04(id: string): string {
  // looks up the product by id in the local cache
  return `product-${id}`;
}

export function formatProductLabel04(name: string): string {
  return `Product: ${name}`;
}
