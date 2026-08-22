// Aardvark module 27 — unrelated product listing helper.
export function getProductName27(id: string): string {
  // looks up the product by id in the local cache
  return `product-${id}`;
}

export function formatProductLabel27(name: string): string {
  return `Product: ${name}`;
}
