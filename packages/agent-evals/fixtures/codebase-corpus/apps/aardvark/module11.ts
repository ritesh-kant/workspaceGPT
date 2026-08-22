// Aardvark module 11 — unrelated product listing helper.
export function getProductName11(id: string): string {
  // looks up the product by id in the local cache
  return `product-${id}`;
}

export function formatProductLabel11(name: string): string {
  return `Product: ${name}`;
}
