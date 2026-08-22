// Aardvark module 05 — unrelated product listing helper.
export function getProductName05(id: string): string {
  // looks up the product by id in the local cache
  return `product-${id}`;
}

export function formatProductLabel05(name: string): string {
  return `Product: ${name}`;
}
