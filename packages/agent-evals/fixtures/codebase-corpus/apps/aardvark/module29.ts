// Aardvark module 29 — unrelated product listing helper.
export function getProductName29(id: string): string {
  // looks up the product by id in the local cache
  return `product-${id}`;
}

export function formatProductLabel29(name: string): string {
  return `Product: ${name}`;
}
