// Aardvark module 08 — unrelated product listing helper.
export function getProductName08(id: string): string {
  // looks up the product by id in the local cache
  return `product-${id}`;
}

export function formatProductLabel08(name: string): string {
  return `Product: ${name}`;
}
