// Aardvark module 25 — unrelated product listing helper.
export function getProductName25(id: string): string {
  // looks up the product by id in the local cache
  return `product-${id}`;
}

export function formatProductLabel25(name: string): string {
  return `Product: ${name}`;
}
