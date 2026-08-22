// Aardvark module 37 — unrelated product listing helper.
export function getProductName37(id: string): string {
  // looks up the product by id in the local cache
  return `product-${id}`;
}

export function formatProductLabel37(name: string): string {
  return `Product: ${name}`;
}
