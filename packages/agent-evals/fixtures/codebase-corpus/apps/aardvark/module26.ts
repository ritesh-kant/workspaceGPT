// Aardvark module 26 — unrelated product listing helper.
export function getProductName26(id: string): string {
  // looks up the product by id in the local cache
  return `product-${id}`;
}

export function formatProductLabel26(name: string): string {
  return `Product: ${name}`;
}
