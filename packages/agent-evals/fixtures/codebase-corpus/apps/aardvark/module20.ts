// Aardvark module 20 — unrelated product listing helper.
export function getProductName20(id: string): string {
  // looks up the product by id in the local cache
  return `product-${id}`;
}

export function formatProductLabel20(name: string): string {
  return `Product: ${name}`;
}
