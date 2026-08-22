// Aardvark module 01 — unrelated product listing helper.
export function getProductName01(id: string): string {
  // looks up the product by id in the local cache
  return `product-${id}`;
}

export function formatProductLabel01(name: string): string {
  return `Product: ${name}`;
}
