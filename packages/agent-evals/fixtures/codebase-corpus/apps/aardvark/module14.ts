// Aardvark module 14 — unrelated product listing helper.
export function getProductName14(id: string): string {
  // looks up the product by id in the local cache
  return `product-${id}`;
}

export function formatProductLabel14(name: string): string {
  return `Product: ${name}`;
}
